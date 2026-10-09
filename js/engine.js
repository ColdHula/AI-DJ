/* AI DJ audio engine: synthesized kits, beat-quantized actions, arrangement, FX, song deck. */
(function () {
  'use strict';

  var SCALES = {
    minor: [0, 2, 3, 5, 7, 8, 10],
    major: [0, 2, 4, 5, 7, 9, 11],
    harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
    phrygian: [0, 1, 3, 5, 7, 8, 10]
  };
  var PCS = { 'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11 };
  var PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  var SECTION_LEN = { intro: 8, build: 4, drop: 16, break: 8 };
  var MASKS = {
    intro: { k: 1, s: 0, c: 0.5, h: 1, o: 0, p: 1, p2: 1, bass: 0, chords: 0.6, lead: 0 },
    build: { k: 1, s: 0, c: 0, h: 1, o: 0, p: 1, p2: 1, bass: 0, chords: 1, lead: 0 },
    drop: { k: 1, s: 1, c: 1, h: 1, o: 1, p: 1, p2: 1, bass: 1, chords: 1, lead: 1 },
    break: { k: 0, s: 0, c: 0, h: 0.5, o: 0, p: 1, p2: 1, bass: 0, chords: 1, lead: 1 }
  };
  var NEXT_SECTION = { intro: 'build', build: 'drop', drop: 'break', break: 'build' };

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function degreeSemis(scale, d) {
    var i = d - 1;
    var oct = Math.floor(i / 7);
    var idx = ((i % 7) + 7) % 7;
    return scale[idx] + 12 * oct;
  }

  function parseTokens(str) {
    if (!str) return [];
    return str.trim().split(/\s+/);
  }

  function Engine() {
    this.ctx = null;
    this.genre = null;
    this.bpm = 128;
    this.playing = false;
    this.step = 0;
    this.nextTime = 0;
    this.section = 'intro';
    this.secBar = 0;
    this.secLen = SECTION_LEN.intro;
    this.autopilot = true;
    this.queue = [];
    this.roll = 0;
    this.variation = false;
    this.listeners = {};
    this.song = null;
    this.songSrc = null;
    this.tempoMode = 'song';
    this.levels = { song: 0.9, beat: 0.9, music: 0.8, master: 0.9 };
    this.lastFx = {};
  }

  Engine.prototype.on = function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); };
  Engine.prototype.emit = function (ev, data) {
    var l = this.listeners[ev]; if (!l) return;
    for (var i = 0; i < l.length; i++) { try { l[i](data); } catch (e) { console.error(e); } }
  };

  Engine.prototype.init = function () {
    if (this.ctx) return this.ctx.resume();
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    var self = this;

    function g(v) { var n = ctx.createGain(); n.gain.value = v; return n; }
    function bq(type, f, q) { var n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; if (q != null) n.Q.value = q; return n; }

    // Buses
    this.drumBus = g(0.9);
    this.bassBus = g(0.75);
    this.bassDuck = g(1);
    this.musicBus = g(0.32);
    this.musicDuck = g(1);
    this.leadBus = g(0.26);
    this.fxBus = g(0.5);
    this.beatGain = g(this.levels.beat);
    this.musicGain = g(this.levels.music);
    this.deckGain = g(this.levels.song);
    this.deckEQ = ctx.createBiquadFilter(); this.deckEQ.type = 'lowshelf'; this.deckEQ.frequency.value = 140; this.deckEQ.gain.value = 0;
    this.deckDuck = g(1);

    this.drumBus.connect(this.beatGain);
    this.bassBus.connect(this.bassDuck); this.bassDuck.connect(this.beatGain);
    this.musicBus.connect(this.musicDuck); this.musicDuck.connect(this.musicGain);
    this.leadBus.connect(this.musicDuck);
    this.deckEQ.connect(this.deckDuck); this.deckDuck.connect(this.deckGain);

    // Section filters, then the performer's filters
    this.sum = g(1);
    this.secHP = bq('highpass', 20, 0.7);
    this.secLP = bq('lowpass', 20000, 0.7);
    this.userHP = bq('highpass', 20, 0.9);
    this.userLP = bq('lowpass', 20000, 0.9);
    this.beatGain.connect(this.sum); this.musicGain.connect(this.sum); this.deckGain.connect(this.sum);
    this.sum.connect(this.secHP); this.secHP.connect(this.secLP); this.secLP.connect(this.userHP); this.userHP.connect(this.userLP);

    // Dry gate (echo-out, rewind) and sends
    this.dryGate = g(1);
    this.userLP.connect(this.dryGate);

    this.echoSend = g(0);
    this.delay = ctx.createDelay(2);
    this.delayFb = g(0.35);
    this.delayTone = bq('lowpass', 3500);
    this.userLP.connect(this.echoSend); this.echoSend.connect(this.delay);
    this.delay.connect(this.delayTone); this.delayTone.connect(this.delayFb); this.delayFb.connect(this.delay);

    this.verbSend = g(0.06);
    this.verb = ctx.createConvolver();
    this.verb.buffer = this.makeImpulse(2.6);
    this.userLP.connect(this.verbSend); this.verbSend.connect(this.verb);
    this.fxBus.connect(this.verb);

    // Master chain
    this.master = g(this.levels.master);
    this.dryGate.connect(this.master);
    this.delayTone.connect(this.master);
    this.verb.connect(this.master);
    this.fxBus.connect(this.master);
    this.direct = g(0.9); // rewinds and scratches bypass the dry gate
    this.direct.connect(this.master);

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12; this.comp.ratio.value = 4; this.comp.attack.value = 0.004; this.comp.release.value = 0.22; this.comp.knee.value = 6;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.001; this.limiter.release.value = 0.08; this.limiter.knee.value = 0;
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 1024; this.analyser.smoothingTimeConstant = 0.78;
    this.master.connect(this.comp); this.comp.connect(this.limiter); this.limiter.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    if (ctx.createMediaStreamDestination) {
      this.recDest = ctx.createMediaStreamDestination();
      this.limiter.connect(this.recDest);
    }

    // Shared resources
    this.noise = this.makeNoise(2);
    this.shaper = this.makeShaper(2.5);
    this.hardShaper = this.makeShaper(8);
    this.vox = this.makeVox();

    this.timer = setInterval(function () { self.schedule(); }, 25);
    this.setEchoTime();
    return ctx.resume();
  };

  Engine.prototype.makeNoise = function (sec) {
    var ctx = this.ctx, len = Math.floor(ctx.sampleRate * sec);
    var b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
  };
  Engine.prototype.makeImpulse = function (sec) {
    var ctx = this.ctx, len = Math.floor(ctx.sampleRate * sec);
    var b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var c = 0; c < 2; c++) {
      var d = b.getChannelData(c);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    return b;
  };
  Engine.prototype.makeShaper = function (amt) {
    var ws = this.ctx.createWaveShaper(), n = 2048, curve = new Float32Array(n);
    for (var i = 0; i < n; i++) { var x = i / (n - 1) * 2 - 1; curve[i] = Math.tanh(x * amt) / Math.tanh(amt); }
    ws.curve = curve; ws.oversample = '2x';
    return ws;
  };
  // A short "ahh" vowel used for scratches when no song is loaded.
  Engine.prototype.makeVox = function () {
    var ctx = this.ctx, sr = ctx.sampleRate, len = Math.floor(sr * 1.2);
    var b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0);
    var f0 = 180, formants = [[730, 1], [1090, 0.5], [2440, 0.25]];
    var states = formants.map(function () { return [0, 0]; });
    var ph = 0;
    for (var i = 0; i < len; i++) {
      var t = i / sr;
      var f = f0 * (1 + 0.25 * Math.sin(t * 3)) ;
      ph += f / sr; if (ph > 1) ph -= 1;
      var src = (ph * 2 - 1) + (Math.random() * 2 - 1) * 0.15;
      var out = 0;
      for (var k = 0; k < formants.length; k++) {
        var fc = formants[k][0], r = 0.985;
        var w = 2 * Math.PI * fc / sr;
        var s = states[k];
        var y = src * (1 - r) + 2 * r * Math.cos(w) * s[0] - r * r * s[1];
        s[1] = s[0]; s[0] = y;
        out += y * formants[k][1];
      }
      var env = Math.min(1, t * 30) * Math.min(1, (1.2 - t) * 6);
      d[i] = out * env * 0.6;
    }
    return b;
  };

  Engine.prototype.setEchoTime = function () {
    if (!this.ctx) return;
    var beat = 60 / this.bpm;
    this.delay.delayTime.setTargetAtTime(beat * 0.75, this.ctx.currentTime, 0.05);
  };

  // ---------- Genre ----------
  Engine.prototype.setGenre = function (genre, immediate) {
    if (!this.playing || immediate || !this.ctx) {
      this.applyGenre(genre);
    } else {
      this.enqueue({ type: 'genre', genre: genre }, 16);
    }
  };
  Engine.prototype.applyGenre = function (genre, t) {
    this.genre = genre;
    var kit = genre.kit || {};
    this.kit = {
      kick: Object.assign({ start: 150, end: 48, decay: 0.4, drive: 0.3, click: 0.6 }, kit.kick || {}),
      snare: Object.assign({ tone: 190, decay: 0.18 }, kit.snare || {})
    };
    this.scale = SCALES[genre.scale] || SCALES.minor;
    this.keyPc = PCS[genre.key] != null ? PCS[genre.key] : 9;
    if (this.song && this.song.key && this.followSongKey !== false) {
      this.keyPc = this.song.key.pc;
      this.scale = this.song.key.mode === 'major' ? SCALES.major : (genre.scale === 'major' ? SCALES.minor : (SCALES[genre.scale] || SCALES.minor));
    }
    this.bassTokens = parseTokens(genre.bass && genre.bass.pattern);
    this.leadTokens = parseTokens(genre.lead && genre.lead.pattern);
    this.chordPat = (genre.chords && genre.chords.pattern) || '';
    this.prog = (genre.chords && genre.chords.progression) || [1, 6, 3, 7];
    if (!this.song || this.tempoMode === 'genre') {
      this.setBpm(this.song ? this.clockBpmFor(genre) : genre.bpm, t);
    } else {
      this.setBpm(this.clockBpmFor(genre), t);
    }
    this.emit('genre', genre);
  };
  Engine.prototype.setBpm = function (bpm, t) {
    this.bpm = clamp(bpm, 60, 200);
    this.setEchoTime();
    this.emit('bpm', this.bpm);
  };

  // ---------- Transport ----------
  Engine.prototype.start = function () {
    var self = this;
    return this.init().then(function () {
      if (self.playing) return;
      self.playing = true;
      self.step = 0;
      self.nextTime = self.ctx.currentTime + 0.12;
      self.queue = [];
      self.roll = 0;
      self.setSection('intro', self.nextTime, true);
      if (self.song) self.startSong(self.nextTime, self.song.downbeat);
      self.emit('play', true);
    });
  };
  Engine.prototype.stop = function () {
    if (!this.playing) return;
    this.playing = false;
    this.stopSong();
    var t = this.ctx.currentTime;
    this.dryGate.gain.cancelScheduledValues(t); this.dryGate.gain.setValueAtTime(1, t);
    this.resetSectionFilters(t);
    this.emit('play', false);
  };

  Engine.prototype.stepDur = function () { return 60 / this.bpm / 4; };

  Engine.prototype.schedule = function () {
    if (!this.playing) return;
    var ctx = this.ctx;
    while (this.nextTime < ctx.currentTime + 0.12) {
      var swing = this.genre && this.genre.swing || 0;
      var t = this.nextTime + ((this.step % 2) ? swing * this.stepDur() * 0.66 : 0);
      this.tick(this.step, t, this.nextTime);
      this.nextTime += this.stepDur();
      this.step++;
    }
  };

  Engine.prototype.enqueue = function (action, div) {
    // Snap to the next grid line that has not been scheduled yet.
    var target = Math.ceil(this.step / div) * div;
    if (target === this.step && this.nextTime - this.ctx.currentTime < 0.02) target += div;
    action.step = target;
    this.queue.push(action);
    var secs = Math.max(0, this.nextTime - this.ctx.currentTime) + (target - this.step) * this.stepDur();
    return secs;
  };

  Engine.prototype.tick = function (step, t, gridT) {
    var s16 = step % 16;
    var bar = Math.floor(step / 16);

    if (s16 === 0 && step > 0) this.advanceBar(gridT);

    // Run queued actions for this step
    if (this.queue.length) {
      var due = [], keep = [];
      for (var i = 0; i < this.queue.length; i++) (this.queue[i].step <= step ? due : keep).push(this.queue[i]);
      this.queue = keep;
      for (var j = 0; j < due.length; j++) this.runAction(due[j], gridT, step);
    }

    var genre = this.genre; if (!genre) return;
    var mask = MASKS[this.section] || MASKS.drop;
    var sd = this.stepDur();

    // Drums
    var drums = genre.drums || {};
    var rolling = this.roll > 0;
    if (rolling) {
      var every = this.roll === 2 ? 1 : 2;
      if (step % every === 0) {
        var v = 0.55 + 0.45 * ((step % 4) / 4);
        this.snare(t, v);
        this.kick(t, 0.7);
        this.duck(t);
      }
      this.hat(t, 0.3, false);
    } else {
      for (var key in drums) {
        if (!drums.hasOwnProperty(key)) continue;
        var pat = drums[key]; if (!pat) continue;
        var ch = pat.charAt(s16 + (bar % Math.max(1, pat.length / 16 | 0)) * 16) || pat.charAt(s16);
        if (ch === '.' || !ch) continue;
        var m = mask[key] != null ? mask[key] : 1;
        if (this.section === 'build' && key === 'k' && this.secBar >= this.secLen - 1) m = 0;
        if (m <= 0) continue;
        var vel = (ch === 'X' ? 1 : ch === 'g' ? 0.4 : 0.8) * m;
        this.playDrum(key, ch, t, vel);
      }
      if (this.section === 'build') this.buildRoll(step, t);
      if (this.fillBar === bar) this.fillHit(step, t);
    }

    // Bass
    if (mask.bass > 0 && this.bassTokens.length && !this.cutBass) {
      var bt = this.bassTokens[(s16 + (bar % Math.max(1, this.bassTokens.length / 16 | 0)) * 16) % this.bassTokens.length];
      if (bt && bt !== '.' && bt !== '-') {
        var hold = this.holdLen(this.bassTokens, (s16 + (bar % Math.max(1, this.bassTokens.length / 16 | 0)) * 16) % this.bassTokens.length);
        var root = this.chordRootSemis(bar);
        var midi = 24 + this.keyPc + root + parseInt(bt, 10);
        while (midi > 47) midi -= 12;
        while (midi < 24) midi += 12;
        this.bassNote(midi, t, hold * sd);
      }
    }

    // Chords
    if (mask.chords > 0 && this.chordPat && genre.chords && genre.chords.type !== 'none') {
      var cc = this.chordPat.charAt(s16);
      if (cc === 'x') {
        var len = 1; while (this.chordPat.charAt(s16 + len) === '-') len++;
        this.chord(bar, t, len * sd, mask.chords);
      }
    }

    // Lead
    if (mask.lead > 0 && this.leadTokens.length && genre.lead && genre.lead.type !== 'none') {
      var li = (s16 + (bar % Math.max(1, this.leadTokens.length / 16 | 0)) * 16) % this.leadTokens.length;
      var lt = this.leadTokens[li];
      if (lt && lt !== '.' && lt !== '-') {
        var deg = parseInt(lt, 10) + (this.variation ? 2 : 0);
        var lmidi = 60 + this.keyPc + degreeSemis(this.scale, deg);
        while (lmidi > 88) lmidi -= 12;
        while (lmidi < 62) lmidi += 12;
        this.leadNote(genre.lead.type, lmidi, t, this.holdLen(this.leadTokens, li) * sd);
      }
    }

    this.emit('step', { step: step, t: t, s16: s16, bar: bar });
  };

  Engine.prototype.holdLen = function (tokens, i) {
    var n = 1; while (tokens[(i + n) % tokens.length] === '-' && n < 32) n++;
    return n;
  };
  Engine.prototype.chordRootSemis = function (bar) {
    var prog = this.prog;
    var idx = (bar + (this.variation ? 2 : 0)) % prog.length;
    return degreeSemis(this.scale, prog[idx]);
  };

  // ---------- Arrangement ----------
  Engine.prototype.advanceBar = function (t) {
    this.secBar++;
    if (this.secBar >= this.secLen) {
      var nxt = NEXT_SECTION[this.section];
      if (this.section === 'build' || this.autopilot) {
        this.setSection(nxt, t);
      } else {
        this.secBar = 0; // loop the current section until the DJ acts
        this.emit('section', this.sectionInfo());
      }
    } else {
      this.emit('bar', this.sectionInfo());
    }
  };
  Engine.prototype.sectionInfo = function () {
    return { section: this.section, secBar: this.secBar, secLen: this.secLen, next: NEXT_SECTION[this.section], autopilot: this.autopilot };
  };

  Engine.prototype.setSection = function (name, t, silent) {
    var prev = this.section;
    this.section = name;
    this.secBar = 0;
    this.secLen = this.pendingLen || SECTION_LEN[name] || 8;
    this.pendingLen = 0;
    var bar = 4 * 60 / this.bpm;
    this.resetSectionFilters(t);
    if (name === 'intro') {
      this.secLP.frequency.setValueAtTime(2200, t);
      this.secLP.frequency.exponentialRampToValueAtTime(9000, t + bar * this.secLen);
    } else if (name === 'build') {
      var dur = bar * this.secLen;
      this.secHP.frequency.setValueAtTime(30, t);
      this.secHP.frequency.exponentialRampToValueAtTime(700, t + dur);
      this.riser(t, dur);
    } else if (name === 'drop') {
      this.impact(t, prev === 'build' ? 1 : 0.7);
      if (this.song) this.bassSwap(true, t);
    } else if (name === 'break') {
      this.secLP.frequency.setValueAtTime(1400, t);
      this.secLP.frequency.exponentialRampToValueAtTime(5000, t + bar * this.secLen);
      this.downlifter(t);
      if (this.song) this.bassSwap(false, t);
    }
    if (name === 'intro' && this.song) this.bassSwap(false, t);
    this.emit('section', this.sectionInfo());
  };
  Engine.prototype.resetSectionFilters = function (t) {
    this.secHP.frequency.cancelScheduledValues(t); this.secHP.frequency.setValueAtTime(20, t);
    this.secLP.frequency.cancelScheduledValues(t); this.secLP.frequency.setValueAtTime(20000, t);
  };
  Engine.prototype.bassSwap = function (on, t) {
    this.deckEQ.gain.setTargetAtTime(on ? -14 : 0, t, 0.05);
  };

  Engine.prototype.buildRoll = function (step, t) {
    var s16 = step % 16;
    var progress = (this.secBar + s16 / 16) / this.secLen;
    var every = progress < 0.5 ? 4 : progress < 0.75 ? 2 : 1;
    if (s16 % every === 0) this.snare(t, 0.35 + 0.6 * progress);
  };
  Engine.prototype.fillHit = function (step, t) {
    var s16 = step % 16;
    if (s16 >= 8) {
      var toms = [200, 180, 160, 140, 120, 110, 100, 90];
      this.tom(t, 0.8, toms[s16 - 8]);
      if (s16 % 2 === 0) this.snare(t, 0.6);
    }
  };

  // ---------- Performer actions (always on the grid) ----------
  Engine.prototype.trigger = function (name, opts) {
    if (!this.ctx) return 0;
    if (!this.playing) { this.oneShot(name); return 0; }
    var bar16 = 16, beat = 4, eighth = 2;
    switch (name) {
      case 'build':
        if (this.section === 'build') return 0;
        return this.enqueue({ type: 'section', section: 'build' }, bar16);
      case 'drop':
        if (this.section === 'build') {
          return this.enqueue({ type: 'section', section: 'drop' }, bar16);
        }
        if (this.section === 'drop') return this.enqueue({ type: 'redrop' }, bar16);
        return this.enqueue({ type: 'quickbuild' }, bar16);
      case 'break':
        if (this.section === 'break') return 0;
        return this.enqueue({ type: 'section', section: 'break' }, bar16);
      case 'echo':
        return this.enqueue({ type: 'echo' }, beat);
      case 'fill':
        return this.enqueue({ type: 'fill' }, bar16);
      case 'variation':
        return this.enqueue({ type: 'variation' }, bar16);
      case 'impact':
        return this.enqueue({ type: 'fx', fx: 'impact' }, beat);
      case 'siren': case 'ceksound':
        return this.enqueue({ type: 'fx', fx: name }, bar16 / 2);
      case 'horn': case 'scratch': case 'bassdive': case 'claps': case 'rewind':
        return this.enqueue({ type: 'fx', fx: name }, beat);
      case 'laser':
        return this.enqueue({ type: 'fx', fx: name }, eighth);
      default:
        return 0;
    }
  };
  Engine.prototype.setRoll = function (level) {
    this.roll = level;
  };

  Engine.prototype.runAction = function (a, t, step) {
    var beat = 60 / this.bpm, bar = beat * 4;
    switch (a.type) {
      case 'genre':
        this.applyGenre(a.genre, t);
        if (this.song && this.tempoMode === 'genre') this.resyncSong(t);
        this.impact(t, 0.6);
        break;
      case 'section':
        this.setSection(a.section, t);
        break;
      case 'quickbuild':
        this.pendingLen = 1;
        this.setSection('build', t);
        break;
      case 'redrop':
        this.setSection('drop', t);
        this.horn(t + 0.01);
        break;
      case 'echo':
        this.echoOut(t, beat);
        break;
      case 'fill':
        this.fillBar = Math.floor(step / 16);
        break;
      case 'variation':
        this.variation = !this.variation;
        this.impact(t, 0.4);
        break;
      case 'songStart':
        this.startSong(t, this.song.downbeat);
        break;
      case 'fx':
        this.fx(a.fx, t);
        break;
    }
    this.emit('action', { type: a.type, fx: a.fx, section: a.section, t: t });
  };

  Engine.prototype.fx = function (name, t) {
    var beat = 60 / this.bpm;
    switch (name) {
      case 'horn': this.horn(t); break;
      case 'siren': this.siren(t, beat * 8); break;
      case 'laser': this.laser(t, beat); break;
      case 'impact': this.impact(t, 1); break;
      case 'bassdive': this.bassDive(t); break;
      case 'ceksound': this.cekSound(t, beat * 4); break;
      case 'claps': this.claps(t, beat); break;
      case 'scratch': this.scratch(t, beat); break;
      case 'rewind': this.rewind(t, beat); break;
    }
  };
  Engine.prototype.oneShot = function (name) {
    var t = this.ctx.currentTime + 0.02;
    if (name === 'build' || name === 'drop' || name === 'break' || name === 'echo' || name === 'fill' || name === 'variation') {
      if (name === 'drop') this.impact(t, 1);
      return;
    }
    this.fx(name, t);
  };

  Engine.prototype.echoOut = function (t, beat) {
    var bar = beat * 4;
    var stepsLeft = 16 - ((this.step) % 16);
    var back = t + Math.max(beat * 2, stepsLeft * this.stepDur() + bar * 0);
    this.echoSend.gain.cancelScheduledValues(t);
    this.echoSend.gain.setValueAtTime(0.9, t);
    this.delayFb.gain.setValueAtTime(0.62, t);
    this.dryGate.gain.setValueAtTime(1, t + beat * 0.98);
    this.dryGate.gain.linearRampToValueAtTime(0, t + beat * 1.05);
    this.dryGate.gain.setValueAtTime(0, back - 0.01);
    this.dryGate.gain.linearRampToValueAtTime(1, back + 0.01);
    this.echoSend.gain.setValueAtTime(0.9, back);
    this.echoSend.gain.linearRampToValueAtTime(this.userEcho || 0, back + beat * 2);
    this.delayFb.gain.setValueAtTime(0.62, back + beat * 2);
    this.delayFb.gain.linearRampToValueAtTime(0.35, back + beat * 2.5);
  };

  // ---------- Performer filter pad ----------
  Engine.prototype.setXY = function (x, y) {
    // x: -1 (low-pass sweep) .. 0 (open) .. 1 (high-pass sweep); y: 0..1 echo + reverb
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    var lp = x < 0 ? 20000 * Math.pow(250 / 20000, -x) : 20000;
    var hp = x > 0 ? 20 * Math.pow(2500 / 20, x) : 20;
    this.userLP.frequency.setTargetAtTime(lp, t, 0.03);
    this.userHP.frequency.setTargetAtTime(hp, t, 0.03);
    var res = Math.abs(x) * 6 + 0.7;
    this.userLP.Q.setTargetAtTime(res, t, 0.05);
    this.userHP.Q.setTargetAtTime(res, t, 0.05);
    this.userEcho = y * 0.7;
    this.echoSend.gain.setTargetAtTime(this.userEcho, t, 0.05);
    this.verbSend.gain.setTargetAtTime(0.06 + y * 0.35, t, 0.05);
  };
  Engine.prototype.releaseXY = function () {
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    this.userLP.frequency.setTargetAtTime(20000, t, 0.12);
    this.userHP.frequency.setTargetAtTime(20, t, 0.12);
    this.userLP.Q.setTargetAtTime(0.9, t, 0.1);
    this.userHP.Q.setTargetAtTime(0.9, t, 0.1);
    this.userEcho = 0;
    this.echoSend.gain.setTargetAtTime(0, t + 0.2, 0.4);
    this.verbSend.gain.setTargetAtTime(0.06, t + 0.2, 0.4);
  };

  Engine.prototype.setLevel = function (which, v) {
    this.levels[which] = v;
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    var node = which === 'song' ? this.deckGain : which === 'beat' ? this.beatGain : which === 'music' ? this.musicGain : this.master;
    node.gain.setTargetAtTime(v, t, 0.03);
  };

  // ---------- Drum voices ----------
  Engine.prototype.env = function (param, t, peak, attack, decay) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  };
  Engine.prototype.noiseSrc = function (t, dur) {
    var s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.05);
    return s;
  };
  Engine.prototype.duck = function (t) {
    var amt = this.genre ? (this.genre.pump != null ? this.genre.pump : 0.5) : 0.5;
    if (amt <= 0) return;
    var low = 1 - 0.65 * amt;
    [this.bassDuck.gain, this.musicDuck.gain].forEach(function (p) {
      p.cancelScheduledValues(t);
      p.setValueAtTime(low, t);
      p.setTargetAtTime(1, t + 0.03, 0.07);
    });
  };

  Engine.prototype.playDrum = function (key, ch, t, vel) {
    switch (key) {
      case 'k': this.kick(t, vel); this.duck(t); break;
      case 's': this.snare(t, vel); break;
      case 'c': this.clap(t, vel); break;
      case 'h': this.hat(t, vel * 0.55, false); break;
      case 'o': this.hat(t, vel * 0.5, true); break;
      default: this.perc(ch, t, vel);
    }
  };

  Engine.prototype.kick = function (t, vel) {
    var ctx = this.ctx, k = this.kit.kick;
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(k.start, t);
    o.frequency.exponentialRampToValueAtTime(k.end, t + 0.07);
    o.frequency.exponentialRampToValueAtTime(k.end * 0.85, t + k.decay);
    this.env(g.gain, t, vel, 0.002, k.decay);
    var out = g;
    if (k.drive > 0) {
      var pre = ctx.createGain(); pre.gain.value = 1 + k.drive * 3;
      var post = ctx.createGain(); post.gain.value = 1 / (1 + k.drive * 1.5);
      var ws = ctx.createWaveShaper(); ws.curve = this.shaper.curve;
      g.connect(pre); pre.connect(ws); ws.connect(post); out = post;
    }
    o.connect(g); out.connect(this.drumBus);
    o.start(t); o.stop(t + k.decay + 0.05);
    if (k.click > 0) {
      var n = this.noiseSrc(t, 0.02), hp = ctx.createBiquadFilter(), ng = ctx.createGain();
      hp.type = 'highpass'; hp.frequency.value = 2500;
      this.env(ng.gain, t, vel * 0.35 * k.click, 0.001, 0.012);
      n.connect(hp); hp.connect(ng); ng.connect(this.drumBus);
    }
  };
  Engine.prototype.snare = function (t, vel) {
    var ctx = this.ctx, sn = this.kit.snare;
    var o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(sn.tone * 1.4, t); o.frequency.exponentialRampToValueAtTime(sn.tone, t + 0.03);
    this.env(og.gain, t, vel * 0.5, 0.001, 0.09);
    o.connect(og); og.connect(this.drumBus); o.start(t); o.stop(t + 0.15);
    var n = this.noiseSrc(t, sn.decay), bp = ctx.createBiquadFilter(), ng = ctx.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.7;
    this.env(ng.gain, t, vel * 0.7, 0.001, sn.decay);
    n.connect(bp); bp.connect(ng); ng.connect(this.drumBus);
  };
  Engine.prototype.clap = function (t, vel) {
    var ctx = this.ctx;
    var n = this.noiseSrc(t, 0.3), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 1.2;
    g.gain.setValueAtTime(0.0001, t);
    [0, 0.011, 0.022].forEach(function (d) {
      g.gain.setValueAtTime(vel * 0.8, t + d);
      g.gain.exponentialRampToValueAtTime(vel * 0.15, t + d + 0.009);
    });
    g.gain.setValueAtTime(vel * 0.7, t + 0.033);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    n.connect(bp); bp.connect(g); g.connect(this.drumBus);
    var vs = ctx.createGain(); vs.gain.value = 0.15; g.connect(vs); vs.connect(this.verb);
  };
  Engine.prototype.hat = function (t, vel, open) {
    var ctx = this.ctx, d = open ? 0.22 : 0.035;
    var n = this.noiseSrc(t, d), hp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = open ? 6500 : 8000;
    this.env(g.gain, t, vel, 0.001, d);
    n.connect(hp); hp.connect(g); g.connect(this.drumBus);
  };
  Engine.prototype.tone = function (t, vel, f0, f1, decay, type, dest) {
    var ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + decay * 0.6);
    this.env(g.gain, t, vel, 0.002, decay);
    o.connect(g); g.connect(dest || this.drumBus);
    o.start(t); o.stop(t + decay + 0.05);
    return g;
  };
  Engine.prototype.tom = function (t, vel, f) { this.tone(t, vel * 0.8, f * 1.3, f * 0.8, 0.25); };
  Engine.prototype.perc = function (ch, t, vel) {
    var ctx = this.ctx;
    switch (ch) {
      case 'd': // kendang "dut": low with upward bend
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(82, t); o.frequency.linearRampToValueAtTime(128, t + 0.12);
        this.env(g.gain, t, vel * 0.9, 0.003, 0.28);
        o.connect(g); g.connect(this.drumBus); o.start(t); o.stop(t + 0.35);
        break;
      case 't': // kendang "tak": slap
        this.tone(t, vel * 0.45, 520, 380, 0.06, 'triangle');
        var n = this.noiseSrc(t, 0.05), bp = ctx.createBiquadFilter(), ng = ctx.createGain();
        bp.type = 'bandpass'; bp.frequency.value = 2800; bp.Q.value = 1.5;
        this.env(ng.gain, t, vel * 0.5, 0.001, 0.045);
        n.connect(bp); bp.connect(ng); ng.connect(this.drumBus);
        break;
      case 'k': this.tone(t, vel * 0.45, 760, 640, 0.08, 'sine'); break; // kendang "ket"
      case 'm': this.tom(t, vel, 150); break;
      case 'r': this.tone(t, vel * 0.3, 1700, 1600, 0.025, 'square'); break;
      case 's': this.hat(t, vel * 0.3, false); break;
      case 'b': this.tone(t, vel * 0.5, 360, 300, 0.12); break;
      case 'n': this.tone(t, vel * 0.55, 240, 200, 0.2); break;
      case 'w':
        this.tone(t, vel * 0.2, 540, 540, 0.25, 'square');
        this.tone(t, vel * 0.2, 800, 800, 0.25, 'square');
        break;
    }
  };

  // ---------- Bass ----------
  Engine.prototype.bassNote = function (midi, t, dur) {
    var ctx = this.ctx, type = this.genre.bass.type, f = mtof(midi);
    var g = ctx.createGain(), dest = this.bassBus;
    if (type === '808') {
      var o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f * 1.6, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
      var len = Math.max(0.25, dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.005);
      g.gain.setValueAtTime(0.9, t + len * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      var ws = ctx.createWaveShaper(); ws.curve = this.shaper.curve;
      var pre = ctx.createGain(); pre.gain.value = 1.8;
      o.connect(pre); pre.connect(ws); ws.connect(g); g.connect(dest);
      o.start(t); o.stop(t + len + 0.05);
    } else if (type === 'sub') {
      var s = ctx.createOscillator(); s.type = 'sine'; s.frequency.value = f;
      var tri = ctx.createOscillator(); tri.type = 'triangle'; tri.frequency.value = f * 2;
      var tg = ctx.createGain(); tg.gain.value = 0.15;
      var l2 = Math.max(0.12, dur * 0.95);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.85, t + 0.008);
      g.gain.setValueAtTime(0.85, t + l2 * 0.8); g.gain.exponentialRampToValueAtTime(0.0001, t + l2);
      s.connect(g); tri.connect(tg); tg.connect(g); g.connect(dest);
      s.start(t); tri.start(t); s.stop(t + l2 + 0.05); tri.stop(t + l2 + 0.05);
    } else if (type === 'bounce') {
      var saw = ctx.createOscillator(); saw.type = 'sawtooth'; saw.frequency.value = f * 2;
      var sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = f;
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 6;
      lp.frequency.setValueAtTime(2400, t); lp.frequency.exponentialRampToValueAtTime(260, t + 0.13);
      var sg = ctx.createGain(); sg.gain.value = 0.7;
      this.env(g.gain, t, 0.75, 0.003, Math.min(0.2, dur + 0.05));
      saw.connect(lp); lp.connect(g); sub.connect(sg); sg.connect(g); g.connect(dest);
      saw.start(t); sub.start(t); saw.stop(t + 0.3); sub.stop(t + 0.3);
    } else if (type === 'reese') {
      var l3 = Math.max(0.2, dur * 0.95);
      var lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 700; lp2.Q.value = 2;
      [-9, 9].forEach(function (cents) {
        var r = ctx.createOscillator(); r.type = 'sawtooth'; r.frequency.value = f; r.detune.value = cents;
        r.connect(lp2); r.start(t); r.stop(t + l3 + 0.05);
      });
      var subr = ctx.createOscillator(); subr.type = 'sine'; subr.frequency.value = f;
      subr.connect(g); subr.start(t); subr.stop(t + l3 + 0.05);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.55, t + 0.01);
      g.gain.setValueAtTime(0.55, t + l3 * 0.85); g.gain.exponentialRampToValueAtTime(0.0001, t + l3);
      lp2.connect(g); g.connect(dest);
    } else if (type === 'log') {
      var lo = ctx.createOscillator(); lo.type = 'sine';
      lo.frequency.setValueAtTime(f * 2.2, t); lo.frequency.exponentialRampToValueAtTime(f, t + 0.04);
      var lw = ctx.createWaveShaper(); lw.curve = this.shaper.curve;
      var lpg = ctx.createGain(); lpg.gain.value = 1.5;
      this.env(g.gain, t, 0.8, 0.003, 0.38);
      lo.connect(lpg); lpg.connect(lw); lw.connect(g); g.connect(dest);
      lo.start(t); lo.stop(t + 0.45);
    }
  };

  // ---------- Chords ----------
  Engine.prototype.chordNotes = function (bar) {
    var prog = this.prog;
    var deg = prog[(bar + (this.variation ? 2 : 0)) % prog.length];
    var notes = [deg, deg + 2, deg + 4].map(function (d) { return degreeSemis(this.scale, d); }, this);
    var base = 48 + this.keyPc;
    return notes.map(function (s) {
      var m = base + s;
      while (m < 55) m += 12;
      while (m > 72) m -= 12;
      return m;
    });
  };
  Engine.prototype.chord = function (bar, t, dur, level) {
    var ctx = this.ctx, type = this.genre.chords.type;
    var notes = this.chordNotes(bar), dest = this.musicBus, self = this;
    var out = ctx.createGain(); out.gain.value = level; out.connect(dest);
    notes.forEach(function (m) {
      var f = mtof(m), g = ctx.createGain();
      if (type === 'supersaw' || type === 'pad') {
        var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = type === 'pad' ? 1400 : 3800;
        var detunes = type === 'pad' ? [-8, 8] : [-14, 0, 14];
        detunes.forEach(function (c) {
          var o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = c;
          o.connect(lp); o.start(t); o.stop(t + dur + 0.8);
        });
        var a = type === 'pad' ? 0.25 : 0.005;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + a);
        g.gain.setValueAtTime(0.22, t + Math.max(a, dur * 0.9));
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur + (type === 'pad' ? 0.7 : 0.15));
        lp.connect(g);
      } else if (type === 'pluck') {
        var po = ctx.createOscillator(); po.type = 'sawtooth'; po.frequency.value = f;
        var pl = ctx.createBiquadFilter(); pl.type = 'lowpass'; pl.Q.value = 3;
        pl.frequency.setValueAtTime(5000, t); pl.frequency.exponentialRampToValueAtTime(500, t + 0.22);
        self.env(g.gain, t, 0.3, 0.002, 0.32);
        po.connect(pl); pl.connect(g); po.start(t); po.stop(t + 0.4);
      } else if (type === 'organ') {
        [1, 2].forEach(function (mul, i) {
          var oo = ctx.createOscillator(); oo.type = i ? 'sine' : 'square'; oo.frequency.value = f * mul;
          var og = ctx.createGain(); og.gain.value = i ? 0.5 : 0.25;
          oo.connect(og); og.connect(g); oo.start(t); oo.stop(t + 0.25);
        });
        self.env(g.gain, t, 0.3, 0.003, 0.18);
      } else { // keys
        var ko = ctx.createOscillator(); ko.type = 'triangle'; ko.frequency.value = f;
        var ks = ctx.createOscillator(); ks.type = 'sine'; ks.frequency.value = f * 2;
        var kg = ctx.createGain(); kg.gain.value = 0.3;
        var kd = Math.min(1.4, dur + 0.4);
        self.env(g.gain, t, 0.35, 0.004, kd);
        ko.connect(g); ks.connect(kg); kg.connect(g); ko.start(t); ks.start(t); ko.stop(t + kd + 0.05); ks.stop(t + kd + 0.05);
      }
      g.connect(out);
    });
  };

  // ---------- Lead ----------
  Engine.prototype.leadNote = function (type, midi, t, dur) {
    var ctx = this.ctx, f = mtof(midi), g = ctx.createGain(), dest = this.leadBus;
    var len = Math.max(0.08, dur * 0.92);
    if (type === 'tuit' || type === 'whistle') {
      var o = ctx.createOscillator(); o.type = type === 'tuit' ? 'square' : 'sine';
      o.frequency.setValueAtTime(f * (type === 'tuit' ? 0.5 : 0.94), t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
      var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 2; bp.Q.value = 1;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
      g.gain.setValueAtTime(0.35, t + len * 0.8); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(bp); bp.connect(g); o.start(t); o.stop(t + len + 0.05);
    } else if (type === 'flute') {
      var fo = ctx.createOscillator(); fo.type = 'sine'; fo.frequency.value = f;
      var vib = ctx.createOscillator(); vib.frequency.value = 5.5;
      var vg = ctx.createGain(); vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(f * 0.012, t + 0.2);
      vib.connect(vg); vg.connect(fo.frequency);
      var br = this.noiseSrc(t, len), bbp = ctx.createBiquadFilter(), bg = ctx.createGain();
      bbp.type = 'bandpass'; bbp.frequency.value = f * 2; bbp.Q.value = 4; bg.gain.value = 0.25;
      br.connect(bbp); bbp.connect(bg); bg.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
      g.gain.setValueAtTime(0.5, t + len * 0.85); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.05);
      fo.connect(g); fo.start(t); vib.start(t); fo.stop(t + len + 0.1); vib.stop(t + len + 0.1);
    } else if (type === 'bell') {
      var c = ctx.createOscillator(); c.frequency.value = f;
      var mo = ctx.createOscillator(); mo.frequency.value = f * 2.76;
      var mg = ctx.createGain(); mg.gain.setValueAtTime(f * 1.5, t); mg.gain.exponentialRampToValueAtTime(1, t + 0.8);
      mo.connect(mg); mg.connect(c.frequency);
      this.env(g.gain, t, 0.35, 0.003, 1.1);
      c.connect(g); c.start(t); mo.start(t); c.stop(t + 1.2); mo.stop(t + 1.2);
    } else if (type === 'cowbell') {
      var bpc = ctx.createBiquadFilter(); bpc.type = 'bandpass'; bpc.frequency.value = f * 2; bpc.Q.value = 2;
      [1, 1.48].forEach(function (mul) {
        var co = ctx.createOscillator(); co.type = 'square'; co.frequency.value = f * mul;
        co.connect(bpc); co.start(t); co.stop(t + 0.35);
      });
      this.env(g.gain, t, 0.5, 0.002, 0.28);
      bpc.connect(g);
    } else { // saw lead
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 2;
      [-7, 7].forEach(function (cents) {
        var so = ctx.createOscillator(); so.type = 'sawtooth'; so.frequency.value = f; so.detune.value = cents;
        so.connect(lp); so.start(t); so.stop(t + len + 0.1);
      });
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.28, t + 0.006);
      g.gain.setValueAtTime(0.28, t + len * 0.85); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.04);
      lp.connect(g);
    }
    g.connect(dest);
    var ls = ctx.createGain(); ls.gain.value = 0.18; g.connect(ls); ls.connect(this.delay);
  };

  // ---------- FX ----------
  Engine.prototype.horn = function (t) {
    var ctx = this.ctx, out = ctx.createGain(); out.gain.value = 0.55;
    var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 0.6;
    var ws = ctx.createWaveShaper(); ws.curve = this.hardShaper.curve;
    var env = ctx.createGain(); env.gain.value = 0;
    var base = 466;
    [1, 1.007, 1.5, 0.5].forEach(function (mul) {
      var o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = base * mul;
      o.frequency.setValueAtTime(base * mul, t + 0.9); o.frequency.linearRampToValueAtTime(base * mul * 0.9, t + 1.3);
      o.connect(env); o.start(t); o.stop(t + 1.35);
    });
    var hits = [[0, 0.14], [0.19, 0.08], [0.3, 0.08], [0.42, 0.9]];
    hits.forEach(function (h) {
      env.gain.setValueAtTime(0, t + h[0]);
      env.gain.linearRampToValueAtTime(0.3, t + h[0] + 0.01);
      env.gain.setValueAtTime(0.3, t + h[0] + h[1] - 0.02);
      env.gain.linearRampToValueAtTime(0, t + h[0] + h[1]);
    });
    env.connect(ws); ws.connect(bp); bp.connect(out); out.connect(this.fxBus);
  };
  Engine.prototype.siren = function (t, dur) {
    var ctx = this.ctx, o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = 820;
    lfo.type = 'sawtooth'; lfo.frequency.value = this.bpm / 60; lg.gain.value = 380;
    lfo.connect(lg); lg.connect(o.frequency);
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2500;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.05);
    g.gain.setValueAtTime(0.12, t + dur - 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp); lp.connect(g); g.connect(this.fxBus);
    var ds = ctx.createGain(); ds.gain.value = 0.3; g.connect(ds); ds.connect(this.delay);
    o.start(t); lfo.start(t); o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
  };
  Engine.prototype.laser = function (t, beat) {
    var ctx = this.ctx;
    for (var i = 0; i < 3; i++) {
      var tt = t + i * beat / 4;
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.setValueAtTime(3200, tt); o.frequency.exponentialRampToValueAtTime(120, tt + 0.22);
      this.env(g.gain, tt, 0.12, 0.002, 0.22);
      o.connect(g); g.connect(this.fxBus);
      var ds = ctx.createGain(); ds.gain.value = 0.4; g.connect(ds); ds.connect(this.delay);
      o.start(tt); o.stop(tt + 0.25);
    }
  };
  Engine.prototype.impact = function (t, amt) {
    var ctx = this.ctx;
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(28, t + 1.6);
    this.env(g.gain, t, 0.9 * amt, 0.003, 1.8);
    o.connect(g); g.connect(this.fxBus); o.start(t); o.stop(t + 1.9);
    var n = this.noiseSrc(t, 1.2), lp = ctx.createBiquadFilter(), ng = ctx.createGain();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(5000, t); lp.frequency.exponentialRampToValueAtTime(200, t + 1);
    this.env(ng.gain, t, 0.35 * amt, 0.002, 1.1);
    n.connect(lp); lp.connect(ng); ng.connect(this.fxBus);
    var vs = ctx.createGain(); vs.gain.value = 0.6; ng.connect(vs); vs.connect(this.verb);
  };
  Engine.prototype.riser = function (t, dur) {
    var ctx = this.ctx;
    var n = this.noiseSrc(t, dur), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    bp.type = 'bandpass'; bp.Q.value = 2;
    bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
    n.connect(bp); bp.connect(g); g.connect(this.fxBus);
    var o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(200, t); o.frequency.exponentialRampToValueAtTime(1600, t + dur);
    og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.06, t + dur);
    og.gain.linearRampToValueAtTime(0, t + dur + 0.02);
    o.connect(og); og.connect(this.fxBus); o.start(t); o.stop(t + dur + 0.05);
  };
  Engine.prototype.downlifter = function (t) {
    var ctx = this.ctx, n = this.noiseSrc(t, 2), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(9000, t); lp.frequency.exponentialRampToValueAtTime(150, t + 2);
    this.env(g.gain, t, 0.25, 0.01, 2);
    n.connect(lp); lp.connect(g); g.connect(this.fxBus);
  };
  Engine.prototype.bassDive = function (t) {
    var ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.9);
    var ws = ctx.createWaveShaper(); ws.curve = this.shaper.curve;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.01);
    g.gain.setValueAtTime(0.9, t + 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + 1);
    o.connect(ws); ws.connect(g); g.connect(this.fxBus); o.start(t); o.stop(t + 1.05);
  };
  Engine.prototype.cekSound = function (t, dur) {
    var ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(28, t);
    o.frequency.exponentialRampToValueAtTime(75, t + dur * 0.5);
    o.frequency.exponentialRampToValueAtTime(30, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.15);
    g.gain.setValueAtTime(0.9, t + dur - 0.2); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.bassBus); o.start(t); o.stop(t + dur + 0.05);
    var beat = dur / 4;
    for (var i = 0; i < 4; i++) this.kick(t + i * beat, 1);
  };
  Engine.prototype.claps = function (t, beat) {
    for (var i = 0; i < 8; i++) {
      var jitter = (Math.random() - 0.5) * 0.02;
      this.clap(t + i * beat / 4 + jitter, 0.4 + 0.5 * (i / 8));
    }
  };
  Engine.prototype.reversedChunk = function (buf, start, len) {
    var ctx = this.ctx, sr = buf.sampleRate;
    var s = Math.max(0, Math.floor(start * sr)), n = Math.min(Math.floor(len * sr), buf.length - s);
    if (n <= 0) return null;
    var out = ctx.createBuffer(buf.numberOfChannels, n, sr);
    for (var c = 0; c < buf.numberOfChannels; c++) {
      var src = buf.getChannelData(c), dst = out.getChannelData(c);
      for (var i = 0; i < n; i++) dst[i] = src[s + n - 1 - i];
    }
    return out;
  };
  Engine.prototype.scratch = function (t, beat) {
    var ctx = this.ctx, buf, pos;
    if (this.song && this.songSrc) { buf = this.song.buffer; pos = this.songPosAt(t); }
    else { buf = this.vox; pos = 0.2; }
    var chunk = 0.35;
    var fwd = buf, rev = this.reversedChunk(buf, pos, chunk);
    var g = ctx.createGain(); g.gain.value = 0.9; g.connect(this.direct);
    var moves = [[0, 'f'], [0.25, 'r'], [0.5, 'f'], [0.625, 'r'], [0.75, 'f']];
    var self = this;
    moves.forEach(function (mv) {
      var tt = t + mv[0] * beat, d = beat * 0.2;
      var s = ctx.createBufferSource();
      var eg = ctx.createGain();
      if (mv[1] === 'f') { s.buffer = fwd; s.start(tt, pos, chunk); }
      else { if (!rev) return; s.buffer = rev; s.start(tt, 0, chunk); }
      s.playbackRate.setValueAtTime(0.4, tt);
      s.playbackRate.linearRampToValueAtTime(1.8, tt + d * 0.5);
      s.playbackRate.linearRampToValueAtTime(0.3, tt + d);
      eg.gain.setValueAtTime(0, tt); eg.gain.linearRampToValueAtTime(1, tt + 0.008);
      eg.gain.setValueAtTime(1, tt + d - 0.01); eg.gain.linearRampToValueAtTime(0, tt + d);
      s.connect(eg); eg.connect(g);
      s.stop(tt + d + 0.02);
    });
    if (this.songSrc) {
      this.deckDuck.gain.setValueAtTime(1, t);
      this.deckDuck.gain.linearRampToValueAtTime(0.15, t + 0.02);
      this.deckDuck.gain.setValueAtTime(0.15, t + beat - 0.02);
      this.deckDuck.gain.linearRampToValueAtTime(1, t + beat);
    }
  };
  Engine.prototype.rewind = function (t, beat) {
    var ctx = this.ctx, bar = beat * 4;
    var buf = this.song ? this.song.buffer : this.vox;
    var pos = this.song && this.songSrc ? this.songPosAt(t) : 1.1;
    var len = Math.min(3, pos);
    var rev = this.reversedChunk(buf, pos - len, len);
    var stepsToBar = (16 - (this.step % 16)) % 16 || 16;
    var back = t + Math.max(beat * 2, stepsToBar * this.stepDur());
    if (rev) {
      var s = ctx.createBufferSource(), g = ctx.createGain();
      s.buffer = rev;
      s.playbackRate.setValueAtTime(1, t);
      s.playbackRate.exponentialRampToValueAtTime(3.2, t + (back - t) * 0.8);
      g.gain.setValueAtTime(0.9, t); g.gain.setValueAtTime(0.9, back - 0.06); g.gain.linearRampToValueAtTime(0, back);
      s.connect(g); g.connect(this.direct); s.start(t); s.stop(back + 0.05);
    }
    this.dryGate.gain.cancelScheduledValues(t);
    this.dryGate.gain.setValueAtTime(1, t);
    this.dryGate.gain.linearRampToValueAtTime(0, t + 0.06);
    this.dryGate.gain.setValueAtTime(0, back - 0.01);
    this.dryGate.gain.linearRampToValueAtTime(1, back + 0.01);
    this.impact(back, 0.9);
    this.horn(back);
  };

  // ---------- Song deck ----------
  Engine.prototype.loadSong = function (buffer, analysis) {
    this.song = Object.assign({ buffer: buffer }, analysis);
    if (this.genre) this.applyGenre(this.genre);
    if (this.playing) {
      this.stopSong();
      this.enqueue({ type: 'songStart' }, 16);
    }
  };
  Engine.prototype.unloadSong = function () {
    this.stopSong();
    this.song = null;
    if (this.ctx) this.bassSwap(false, this.ctx.currentTime);
    if (this.genre) this.applyGenre(this.genre);
  };
  Engine.prototype.foldFactor = function (genreBpm) {
    var s = this.song.bpm, best = 1, bestD = 1e9;
    [0.5, 1, 2].forEach(function (m) {
      var d = Math.abs(Math.log(s * m / genreBpm));
      if (d < bestD) { bestD = d; best = m; }
    });
    return best;
  };
  Engine.prototype.songRate = function (genre) {
    genre = genre || this.genre;
    var m = this.foldFactor(genre.bpm);
    if (this.tempoMode === 'genre') return clamp(genre.bpm / (this.song.bpm * m), 0.8, 1.25);
    if (this.tempoMode === 'speedup') return 1.12;
    return 1;
  };
  Engine.prototype.clockBpmFor = function (genre) {
    var m = this.foldFactor(genre.bpm);
    return this.song.bpm * m * this.songRate(genre);
  };
  Engine.prototype.setTempoMode = function (mode) {
    this.tempoMode = mode;
    if (!this.song || !this.genre) return;
    if (this.playing) {
      this.enqueue({ type: 'genre', genre: this.genre }, 16);
      if (mode !== 'genre') this.enqueue({ type: 'songResync' }, 16);
    } else {
      this.applyGenre(this.genre);
    }
  };
  Engine.prototype.startSong = function (t, offset) {
    if (!this.song) return;
    this.stopSong();
    var ctx = this.ctx, s = ctx.createBufferSource();
    var song = this.song, rate = this.songRate();
    s.buffer = song.buffer;
    s.playbackRate.value = rate;
    var beatSec = 60 / song.bpm;
    var m = this.foldFactor(this.genre.bpm);
    var unit = Math.max(4, 4 / m) * beatSec;
    var avail = song.buffer.duration - song.downbeat;
    var bars = Math.max(1, Math.floor(avail / unit));
    s.loop = true;
    s.loopStart = song.downbeat;
    s.loopEnd = song.downbeat + bars * unit;
    var off = offset;
    if (off >= s.loopEnd) off = song.downbeat;
    s.connect(this.deckEQ);
    s.start(t, off);
    this.songSrc = s;
    this.songT0 = t; this.songOff0 = off; this.songRateNow = rate;
    this.emit('song', { playing: true });
  };
  Engine.prototype.stopSong = function () {
    if (this.songSrc) { try { this.songSrc.stop(); } catch (e) { /* already stopped */ } this.songSrc.disconnect(); this.songSrc = null; }
  };
  Engine.prototype.songPosAt = function (t) {
    if (!this.songSrc) return this.song ? this.song.downbeat : 0;
    var s = this.songSrc;
    var p = this.songOff0 + (t - this.songT0) * this.songRateNow;
    var L = s.loopEnd - s.loopStart;
    if (p > s.loopEnd && L > 0) p = s.loopStart + ((p - s.loopStart) % L);
    return p;
  };
  Engine.prototype.resyncSong = function (t) {
    if (!this.song || !this.songSrc) return;
    // Restart on the song's own bar grid so beats stay aligned at the new rate.
    var pos = this.songPosAt(t);
    var beatSec = 60 / this.song.bpm;
    var m = this.foldFactor(this.genre.bpm);
    var unit = Math.max(4, 4 / m) * beatSec;
    var k = Math.round((pos - this.song.downbeat) / unit);
    this.startSong(t, this.song.downbeat + Math.max(0, k) * unit);
  };
  // Shift where the song's bar starts, in seconds of song time. Applied on the next bar.
  Engine.prototype.nudgeSong = function (sec) {
    if (!this.song) return;
    var barSec = 4 * 60 / this.song.bpm;
    var d = this.song.downbeat + sec;
    while (d < 0) d += barSec;
    this.song.downbeat = d;
    if (this.playing && this.songSrc) this.enqueue({ type: 'songResync' }, 16);
  };
  var origRun = Engine.prototype.runAction;
  Engine.prototype.runAction = function (a, t, step) {
    if (a.type === 'songResync') { this.resyncSong(t); return; }
    if (a.type === 'genre' && this.song && this.songSrc && this.tempoMode !== 'song') {
      origRun.call(this, a, t, step);
      this.resyncSong(t);
      return;
    }
    return origRun.call(this, a, t, step);
  };

  Engine.SCALES = SCALES;
  Engine.PC_NAMES = PC_NAMES;
  Engine.SECTION_LEN = SECTION_LEN;
  window.AIDJEngine = Engine;
})();
