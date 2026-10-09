/* Song analysis: tempo, first downbeat and musical key, computed in the browser. */
(function () {
  'use strict';

  function toMono(buffer) {
    var n = buffer.length, out = new Float32Array(n), chs = buffer.numberOfChannels;
    for (var c = 0; c < chs; c++) {
      var d = buffer.getChannelData(c);
      for (var i = 0; i < n; i++) out[i] += d[i] / chs;
    }
    return out;
  }

  // Onset strength envelope: rectified rise in log energy, full band plus a low band for kicks.
  function onsetEnvelope(x, sr, hop) {
    var frames = Math.floor(x.length / hop);
    var full = new Float32Array(frames), low = new Float32Array(frames);
    var a = Math.exp(-2 * Math.PI * 180 / sr), lp = 0;
    for (var f = 0; f < frames; f++) {
      var e = 0, el = 0, base = f * hop;
      for (var i = 0; i < hop; i++) {
        var v = x[base + i];
        lp = (1 - a) * v + a * lp;
        e += v * v; el += lp * lp;
      }
      full[f] = Math.log(1e-9 + e); low[f] = Math.log(1e-9 + el);
    }
    var env = new Float32Array(frames), lowOn = new Float32Array(frames);
    for (var k = 1; k < frames; k++) {
      var d1 = Math.max(0, full[k] - full[k - 1]);
      var d2 = Math.max(0, low[k] - low[k - 1]);
      env[k] = d1 + 1.5 * d2; lowOn[k] = d2;
    }
    // Remove local mean so sustained loud parts do not dominate
    var w = 16, out = new Float32Array(frames), outLow = new Float32Array(frames), acc = 0, accL = 0;
    for (var j = 0; j < frames; j++) {
      acc += env[j]; accL += lowOn[j];
      if (j >= w) { acc -= env[j - w]; accL -= lowOn[j - w]; }
      var m = acc / Math.min(j + 1, w), mL = accL / Math.min(j + 1, w);
      out[j] = Math.max(0, env[j] - m); outLow[j] = Math.max(0, lowOn[j] - mL);
    }
    return { env: out, low: outLow, rate: sr / hop };
  }

  function interp(arr, pos) {
    var i = Math.floor(pos), f = pos - i;
    if (i < 0 || i + 1 >= arr.length) return 0;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  }

  function combScore(env, period) {
    var best = 0;
    for (var o = 0; o < period; o += 1) {
      var s = 0;
      for (var p = o; p < env.length; p += period) s += interp(env, p);
      if (s > best) best = s;
    }
    return best;
  }

  function detectTempo(env, rate) {
    var minBpm = 70, maxBpm = 180;
    var minLag = Math.floor(rate * 60 / maxBpm), maxLag = Math.ceil(rate * 60 / minBpm);
    var best = 0, bestLag = minLag, scores = [];
    for (var lag = minLag; lag <= maxLag; lag++) {
      var s = 0;
      for (var i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
      // Add the double-period peak, which reinforces true beat periods
      for (var j = 0; j + lag * 2 < env.length; j += 1) s += 0.5 * env[j] * env[j + lag * 2];
      var bpm = 60 * rate / lag;
      var prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.6, 2));
      s *= prior;
      scores[lag] = s;
      if (s > best) { best = s; bestLag = lag; }
    }
    // Parabolic refinement
    var l = bestLag, y0 = scores[l - 1] || 0, y1 = scores[l], y2 = scores[l + 1] || 0;
    var denom = y0 - 2 * y1 + y2, shift = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
    if (Math.abs(shift) > 1) shift = 0;
    var period = l + shift;
    var coarse = 60 * rate / period;
    // Fine search: a beat comb across the whole window is very sensitive to small tempo errors.
    var bpmOut = coarse, bestComb = -1;
    for (var cand = coarse - 2.5; cand <= coarse + 2.5; cand += 0.05) {
      var c = combScore(env, rate * 60 / cand);
      if (c > bestComb) { bestComb = c; bpmOut = cand; }
    }
    var rounded = Math.round(bpmOut);
    if (Math.abs(bpmOut - rounded) < 0.4 && combScore(env, rate * 60 / rounded) > bestComb * 0.97) bpmOut = rounded;
    else bpmOut = Math.round(bpmOut * 10) / 10;
    var mean = 0; for (var q = minLag; q <= maxLag; q++) mean += scores[q] || 0;
    mean /= (maxLag - minLag + 1);
    return { bpm: bpmOut, confidence: Math.min(1, (best / (mean || 1) - 1) / 2) };
  }

  function detectPhase(env, low, rate, bpm, startSec) {
    var period = rate * 60 / bpm;
    var bestO = 0, best = -1;
    for (var o = 0; o < period; o += 0.5) {
      var s = 0;
      for (var p = o; p < env.length; p += period) s += interp(env, p);
      if (s > best) { best = s; bestO = o; }
    }
    // Which of the four beats carries the most kick energy: treat it as beat one
    var bestB = 0, bestBS = -1;
    for (var b = 0; b < 4; b++) {
      var sb = 0;
      for (var pp = bestO + b * period; pp < low.length; pp += period * 4) sb += interp(low, pp);
      if (sb > bestBS) { bestBS = sb; bestB = b; }
    }
    var beatSec = 60 / bpm, barSec = beatSec * 4;
    var t = startSec + (bestO + bestB * period) / rate;
    var first = t % barSec;
    return first < 0 ? first + barSec : first;
  }

  // Key from a chromagram built with Goertzel filters on note frequencies (C3..B6).
  function detectKey(x, sr) {
    var ds = sr > 30000 ? 2 : 1;
    var srd = sr / ds;
    var N = 8192, frames = 80;
    var usable = Math.floor(x.length / ds) - N;
    if (usable <= 0) return null;
    var chroma = new Float64Array(12);
    var buf = new Float32Array(N);
    var coeffs = [];
    for (var m = 48; m < 96; m++) {
      var f = 440 * Math.pow(2, (m - 69) / 12);
      coeffs.push({ pc: m % 12, c: 2 * Math.cos(2 * Math.PI * f / srd) });
    }
    var win = new Float32Array(N);
    for (var w = 0; w < N; w++) win[w] = 0.5 - 0.5 * Math.cos(2 * Math.PI * w / (N - 1));
    for (var fr = 0; fr < frames; fr++) {
      var start = Math.floor((usable * (fr + 0.5)) / frames);
      for (var i = 0; i < N; i++) buf[i] = x[(start + i) * ds] * win[i];
      var frameC = new Float64Array(12), tot = 0;
      for (var k = 0; k < coeffs.length; k++) {
        var cc = coeffs[k].c, s1 = 0, s2 = 0;
        for (var j = 0; j < N; j++) { var s0 = buf[j] + cc * s1 - s2; s2 = s1; s1 = s0; }
        var pw = s1 * s1 + s2 * s2 - cc * s1 * s2;
        var mag = Math.sqrt(Math.max(0, pw));
        frameC[coeffs[k].pc] += mag; tot += mag;
      }
      if (tot > 0) for (var q = 0; q < 12; q++) chroma[q] += frameC[q] / tot;
    }
    var major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    var minor = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    function corr(a, b) {
      var ma = 0, mb = 0, n = 12;
      for (var i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
      ma /= n; mb /= n;
      var num = 0, da = 0, db = 0;
      for (var j = 0; j < n; j++) { num += (a[j] - ma) * (b[j] - mb); da += Math.pow(a[j] - ma, 2); db += Math.pow(b[j] - mb, 2); }
      return num / Math.sqrt(da * db || 1);
    }
    var best = { r: -2 };
    for (var root = 0; root < 12; root++) {
      var rot = [];
      for (var z = 0; z < 12; z++) rot.push(chroma[(z + root) % 12]);
      var rM = corr(rot, major), rm = corr(rot, minor);
      if (rM > best.r) best = { r: rM, pc: root, mode: 'major' };
      if (rm > best.r) best = { r: rm, pc: root, mode: 'minor' };
    }
    var names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    best.name = names[best.pc] + (best.mode === 'minor' ? ' minor' : ' mayor');
    return best;
  }

  function analyze(buffer) {
    var sr = buffer.sampleRate, x = toMono(buffer);
    var dur = buffer.duration;
    var startSec = Math.min(dur * 0.15, 30);
    var lenSec = Math.min(90, dur - startSec);
    var seg = x.subarray(Math.floor(startSec * sr), Math.floor((startSec + lenSec) * sr));
    var hop = 512;
    var on = onsetEnvelope(seg, sr, hop);
    var tempo = detectTempo(on.env, on.rate);
    var downbeat = detectPhase(on.env, on.low, on.rate, tempo.bpm, startSec);
    var key = detectKey(x, sr);
    return { bpm: tempo.bpm, confidence: tempo.confidence, downbeat: downbeat, key: key, duration: dur };
  }

  window.AIDJAnalyze = { analyze: analyze };
})();
