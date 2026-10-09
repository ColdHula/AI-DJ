/* AI DJ interface: pads, coach, crate, song loader, recorder, pack updates. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var engine = window.aidj = new window.AIDJEngine();
  var BUNDLED = window.AIDJ_PACK;
  var pack = BUNDLED;
  var genre = null;
  var filter = 'all';

  function store(key, val) {
    try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) { return null; }
  }

  // ---------- Pads ----------
  var ROWS = [
    { label: 'Transisi', cls: 'g-trans', pads: [
      { id: 'build', name: 'BUILD UP', hint: 'naik pelan, siap meledak', key: 'b' },
      { id: 'drop', name: 'DROP!', hint: 'ledakan utama', key: 'd' },
      { id: 'break', name: 'BREAK', hint: 'tenang sejenak', key: 'k' },
      { id: 'echo', name: 'ECHO OUT', hint: 'gema lalu hening', key: 'e' }
    ] },
    { label: 'Efek', cls: 'g-fx', pads: [
      { id: 'horn', name: 'AIR HORN', hint: 'terompet DJ', key: 'h' },
      { id: 'siren', name: 'SIRENE', hint: 'naik turun 2 bar', key: 's' },
      { id: 'laser', name: 'LASER', hint: 'pew pew pew', key: 'l' },
      { id: 'impact', name: 'BOOM', hint: 'dentuman besar', key: 'i' }
    ] },
    { label: 'Trik DJ', cls: 'g-trick', pads: [
      { id: 'roll', name: 'ROLL', hint: 'tahan tombolnya', key: 'r', hold: true },
      { id: 'scratch', name: 'SCRATCH', hint: 'gosok piringan', key: 'c' },
      { id: 'rewind', name: 'REWIND', hint: 'tarik mundur, masuk lagi', key: 'w' },
      { id: 'fill', name: 'FILL', hint: 'tom sebelum bar baru', key: 'f' }
    ] },
    { label: 'Bass', cls: 'g-bass', pads: [
      { id: 'bassdive', name: 'BASS DIVE', hint: 'bass jatuh dalam', key: 'v' },
      { id: 'ceksound', name: 'CEK SOUND', hint: 'tes sub-bass horeg', key: 'x' },
      { id: 'claps', name: 'TEPUK', hint: 'penonton tepuk tangan', key: 't' },
      { id: 'variation', name: 'VARIASI', hint: 'ganti nada & melodi', key: 'n' }
    ] }
  ];
  var PAD = {}, KEYMAP = {};
  ROWS.forEach(function (r) { r.pads.forEach(function (p) { PAD[p.id] = p; KEYMAP[p.key] = p.id; }); });

  function buildPads() {
    var wrap = $('pads');
    ROWS.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'pad-row';
      var lab = document.createElement('div'); lab.className = 'rowlab'; lab.textContent = r.label; row.appendChild(lab);
      r.pads.forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'pad ' + r.cls; b.id = 'pad-' + p.id; b.type = 'button';
        b.innerHTML = '<kbd>' + p.key.toUpperCase() + '</kbd><b>' + p.name + '</b><small>' + p.hint + '</small>';
        if (p.hold) {
          b.addEventListener('pointerdown', function (e) { e.preventDefault(); rollOn(); });
          ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { b.addEventListener(ev, rollOff); });
        } else {
          b.addEventListener('pointerdown', function (e) { e.preventDefault(); press(p.id); });
          b.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); press(p.id); } });
        }
        row.appendChild(b);
      });
      wrap.appendChild(row);
    });
  }

  function flashPad(id, delay) {
    var el = $('pad-' + id); if (!el) return;
    el.classList.add('queued');
    setTimeout(function () {
      el.classList.remove('queued'); el.classList.add('hit');
      setTimeout(function () { el.classList.remove('hit'); }, 180);
    }, Math.max(0, delay * 1000));
  }

  function press(id) {
    engine.init().then(function () {
      var wait = engine.trigger(id);
      flashPad(id, wait || 0);
      coachPressed(id);
    });
  }
  var rollTimer = null, rolling = false;
  function rollOn() {
    if (rolling) return;
    rolling = true;
    engine.init().then(function () {
      engine.setRoll(1);
      $('pad-roll').classList.add('hit');
      rollTimer = setTimeout(function () { engine.setRoll(2); }, 700);
      coachPressed('roll');
    });
  }
  function rollOff() {
    if (!rolling) return;
    rolling = false;
    clearTimeout(rollTimer);
    engine.setRoll(0);
    $('pad-roll').classList.remove('hit');
  }

  // ---------- Transport ----------
  var wakeLock = null;
  function setPlayUI(on) {
    var b = $('play');
    b.classList.toggle('on', on);
    b.textContent = on ? 'STOP' : 'MAIN';
    if (!on) { setCoach('Tekan MAIN untuk mulai', '', 'AI langsung memutar beat. Kamu tinggal ikuti arahan.'); clearSuggest(); }
  }
  $('play').addEventListener('click', function () {
    if (engine.playing) { engine.stop(); return; }
    engine.start().then(function () {
      try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {}); } catch (e) { /* optional */ }
    });
  });
  engine.on('play', function (on) {
    setPlayUI(on);
    if (!on && wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
    if (on) { coach.sectionCount = 0; coach.cue = null; }
  });

  function bindToggle(id, init, fn) {
    var el = $(id);
    el.setAttribute('aria-pressed', init ? 'true' : 'false');
    el.addEventListener('click', function () {
      var v = el.getAttribute('aria-pressed') !== 'true';
      el.setAttribute('aria-pressed', v ? 'true' : 'false');
      fn(v, el);
    });
  }
  bindToggle('tPilot', true, function (v) { engine.autopilot = v; });
  bindToggle('tCoach', true, function (v) {
    coach.on = v;
    if (!v) { clearSuggest(); setCoach('', '', ''); }
  });
  bindToggle('tRec', false, function (v, el) {
    if (v) startRec(el); else stopRec();
  });

  // ---------- Coach ----------
  var coach = { on: true, cue: null, sectionCount: 0, score: 0, combo: 0, hype: 0 };

  function cueTable(g) {
    var id = g ? g.id : '';
    var warm = id === 'horeg' ? 'ceksound' : 'claps';
    var mid = id === 'phonk' ? 'bassdive' : (id === 'koplo-remix' || id === 'hipdut' || id === 'breakbeat-indo') ? 'scratch' : 'laser';
    var lift = id === 'funkot' ? 'siren' : 'horn';
    return {
      intro: [
        { from: 0, to: 2, text: 'Dengarkan ketukannya', why: 'Anggukkan kepala ikut kick. DJ pro selalu kelihatan menikmati.' },
        { from: 2, to: 4, pad: warm, text: 'Tekan ' + PAD[warm].name },
        { from: 4, to: 6, text: 'Geser FX PAD ke kiri, lalu lepas', why: 'Suara meredup lalu terbuka lagi. Trik klasik DJ.' },
        { from: 6, to: 8, pad: 'build', text: 'Tekan BUILD UP' }
      ],
      build: [
        { from: 0, to: 99, pad: 'drop', text: 'Siap-siap... tekan DROP!', why: 'Angkat satu tangan ke atas sambil menunggu.' }
      ],
      drop: [
        { from: 0, to: 2, text: 'MELEDAK! Goyang!', why: 'Biarkan drop jalan dulu.' },
        { from: 2, to: 4, pad: lift, text: 'Tekan ' + PAD[lift].name },
        { from: 5, to: 7, pad: 'roll', text: 'Tahan ROLL sebentar', why: 'Tahan satu sampai dua ketuk, lalu lepas.' },
        { from: 9, to: 11, pad: mid, text: 'Tekan ' + PAD[mid].name },
        { from: 12, to: 14, pad: 'fill', text: 'Tekan FILL' },
        { from: 14, to: 16, pad: 'echo', text: 'Tekan ECHO OUT', why: 'Gema menutup drop dengan rapi.' }
      ],
      break: [
        { from: 0, to: 3, text: 'Santai dulu. Mainkan FX PAD', why: 'Geser ke atas untuk gema, ke kanan untuk suara tipis.' },
        { from: 3, to: 5, pad: 'variation', text: 'Tekan VARIASI', why: 'Nada dan melodi berganti supaya tidak monoton.' },
        { from: 5, to: 8, pad: 'build', text: 'Tekan BUILD UP' }
      ]
    };
  }

  function findCue(info) {
    var list = cueTable(genre)[info.section] || [];
    var len = info.secLen;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var from = c.from, to = Math.min(c.to, len);
      if (info.section === 'build') from = Math.max(0, len - 2);
      if (info.section === 'intro' || info.section === 'break') {
        if (c.to >= 8) { from = Math.max(0, len - 2); to = len; }
      }
      if (info.secBar >= from && info.secBar < to) {
        return { pad: c.pad, text: c.text, why: c.why || '', from: from, to: to, key: coach.sectionCount + ':' + info.section + ':' + from };
      }
    }
    return null;
  }

  function setCoach(ask, count, why) {
    $('coachAsk').textContent = ask;
    $('coachCount').textContent = count;
    $('coachWhy').textContent = why;
  }
  function clearSuggest() {
    var s = document.querySelectorAll('.pad.suggest');
    for (var i = 0; i < s.length; i++) s[i].classList.remove('suggest');
  }

  function onBar(info) {
    if (info.secBar === 0) coach.sectionCount++;
    var next = findCue(info);
    var cur = coach.cue;
    if (cur && (!next || next.key !== cur.key)) {
      if (!cur.done && cur.pad) {
        coach.combo = 0;
        var isTransition = cur.pad === 'build' || cur.pad === 'drop';
        if (engine.autopilot && !isTransition && cur.pad !== 'roll') {
          var wait = engine.trigger(cur.pad);
          flashPad(cur.pad, wait || 0);
          toast('AI bantu: ' + PAD[cur.pad].name, 'var(--cyan)');
        }
      }
      coach.cue = null;
    }
    if (next && (!coach.cue || coach.cue.key !== next.key)) coach.cue = next;
    renderCoach(info, 0);
    updateScore();
  }

  function renderCoach(info, beatInBar) {
    clearSuggest();
    if (!coach.on || !engine.playing) return;
    var c = coach.cue;
    if (!c) { setCoach('', '', ''); return; }
    if (c.done) { setCoach('Mantap!', '', 'Tunggu arahan berikutnya.'); return; }
    var beatsLeft = (c.to - info.secBar) * 4 - beatInBar;
    if (c.pad) {
      $('pad-' + c.pad).classList.add('suggest');
      var countTxt = info.section === 'build' ? 'DROP masuk dalam ' + beatsLeft + ' ketuk' : 'dalam ' + beatsLeft + ' ketuk';
      setCoach(c.text, countTxt, c.why);
    } else {
      setCoach(c.text, '', c.why);
    }
  }

  function coachPressed(id) {
    coach.hype = Math.min(100, coach.hype + 9);
    if (!engine.playing) return;
    var c = coach.cue;
    if (coach.on && c && !c.done && c.pad === id) {
      c.done = true;
      coach.combo++;
      coach.score += 100 * coach.combo;
      toast(coach.combo > 2 ? 'PERFECT x' + coach.combo : 'PERFECT!', 'var(--good)');
      clearSuggest();
      setCoach('Mantap!', '', 'Tunggu arahan berikutnya.');
    } else {
      coach.score += 25;
    }
    updateScore();
  }

  function updateScore() {
    $('score').textContent = coach.score;
    $('combo').textContent = 'x' + coach.combo;
    $('hype').style.width = coach.hype + '%';
  }

  var toastTimer = null;
  function toast(text, color) {
    var t = $('toast');
    t.textContent = text; t.style.color = color || 'var(--good)';
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 900);
  }

  // Timeline + per-beat UI, scheduled to match what is heard
  var pulse = 0, dropGlow = 0;
  engine.on('step', function (e) {
    if (e.s16 % 4 !== 0) return;
    var info = engine.sectionInfo();
    var delay = Math.max(0, (e.t - engine.ctx.currentTime) * 1000);
    var beat = e.s16 / 4;
    setTimeout(function () {
      pulse = 1;
      if (info.section === 'drop') dropGlow = 1;
      if (beat === 0) onBar(info);
      else renderCoach(info, beat);
      updateTimeline(info, beat);
      coach.hype = Math.max(0, coach.hype - 0.6);
      if (beat === 0) updateScore();
    }, delay);
  });
  function updateTimeline(info, beat) {
    var segs = document.querySelectorAll('#timeline .seg');
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i], on = s.getAttribute('data-s') === info.section;
      s.classList.toggle('on', on);
      s.querySelector('i').style.width = on ? Math.min(100, ((info.secBar + beat / 4 + 0.25) / info.secLen) * 100) + '%' : '0';
    }
  }

  // ---------- Visualizer ----------
  var cv = $('viz'), cx = cv.getContext('2d');
  var spin = 0, freq = null;
  function sizeCanvas() {
    var r = cv.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.max(300, Math.round(r.width * d)); cv.height = Math.round(r.height * d);
  }
  window.addEventListener('resize', sizeCanvas);
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function draw() {
    var W = cv.width, H = cv.height;
    cx.clearRect(0, 0, W, H);
    var playing = engine.playing;
    var level = 0;
    if (engine.analyser) {
      if (!freq) freq = new Uint8Array(engine.analyser.frequencyBinCount);
      engine.analyser.getByteFrequencyData(freq);
      for (var i = 0; i < 24; i++) level += freq[i];
      level = level / (24 * 255);
    }
    // Stage beams
    var beams = 6, hot = dropGlow;
    for (var b = 0; b < beams; b++) {
      var x0 = W * (b + 0.5) / beams;
      var sway = Math.sin(spin * 0.6 + b * 1.3) * W * 0.12;
      var a = playing ? 0.05 + 0.18 * pulse * (0.6 + level) : 0.04;
      var grad = cx.createLinearGradient(x0, 0, x0 + sway, H);
      var col = b % 2 ? '255,178,46' : (hot > 0.2 ? '255,63,134' : '155,124,255');
      grad.addColorStop(0, 'rgba(' + col + ',' + a.toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(' + col + ',0)');
      cx.fillStyle = grad;
      cx.beginPath(); cx.moveTo(x0 - 6, 0); cx.lineTo(x0 + 6, 0); cx.lineTo(x0 + sway + W * 0.07, H); cx.lineTo(x0 + sway - W * 0.07, H); cx.closePath(); cx.fill();
    }
    // Platter
    var R = Math.min(W, H) * 0.3, X = W / 2, Y = H * 0.52;
    var bump = 1 + 0.04 * pulse;
    if (freq) {
      var bars = 72;
      for (var k = 0; k < bars; k++) {
        var v = freq[Math.floor(4 + k * 2.4)] / 255;
        var ang = (k / bars) * Math.PI * 2 - Math.PI / 2;
        var r1 = R * bump + 6, r2 = r1 + v * R * 0.6;
        cx.strokeStyle = k % 3 === 0 ? 'rgba(255,63,134,' + (0.3 + v * 0.7) + ')' : 'rgba(255,178,46,' + (0.25 + v * 0.7) + ')';
        cx.lineWidth = Math.max(2, W / 260);
        cx.beginPath(); cx.moveTo(X + Math.cos(ang) * r1, Y + Math.sin(ang) * r1); cx.lineTo(X + Math.cos(ang) * r2, Y + Math.sin(ang) * r2); cx.stroke();
      }
    }
    cx.save(); cx.translate(X, Y); cx.rotate(spin); cx.scale(bump, bump);
    cx.fillStyle = '#0b0812'; cx.beginPath(); cx.arc(0, 0, R, 0, Math.PI * 2); cx.fill();
    cx.strokeStyle = 'rgba(255,255,255,0.06)'; cx.lineWidth = 1;
    for (var g = 0.45; g < 1; g += 0.07) { cx.beginPath(); cx.arc(0, 0, R * g, 0, Math.PI * 2); cx.stroke(); }
    cx.fillStyle = hot > 0.2 ? '#ff3f86' : '#ffb22e';
    cx.beginPath(); cx.arc(0, 0, R * 0.32, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = '#120d1b'; cx.fillRect(-R * 0.02, -R * 0.3, R * 0.04, R * 0.18);
    cx.beginPath(); cx.arc(0, 0, R * 0.04, 0, Math.PI * 2); cx.fill();
    cx.restore();

    if (playing && !reduce) spin += (engine.bpm / 60) * (Math.PI * 2 / 4) / 60 * 0.5;
    pulse *= 0.88; dropGlow *= 0.985;
    requestAnimationFrame(draw);
  }

  // ---------- Genres ----------
  function versionOf(p) { return (p && p.version) || '0'; }
  function parsePack(text) {
    var a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('format');
    var p = JSON.parse(text.slice(a, b + 1));
    if (!p || !Array.isArray(p.genres) || !p.genres.length) throw new Error('format');
    p.genres = p.genres.filter(function (g) { return g && g.id && g.name && g.bpm && g.drums; });
    if (!p.genres.length) throw new Error('format');
    return p;
  }
  function mergePack(base, add) {
    var byId = {};
    base.genres.forEach(function (g) { byId[g.id] = g; });
    add.genres.forEach(function (g) { byId[g.id] = g; });
    var ids = base.genres.map(function (g) { return g.id; });
    add.genres.forEach(function (g) { if (ids.indexOf(g.id) < 0) ids.push(g.id); });
    return Object.assign({}, base, add, { genres: ids.map(function (id) { return byId[id]; }) });
  }
  function usePack(p, persist) {
    pack = p;
    if (persist) store('aidj-pack', JSON.stringify(p));
    $('packInfo').textContent = 'Paket genre ' + p.version + ' · ' + p.genres.length + ' genre';
    var keep = genre && p.genres.filter(function (g) { return g.id === genre.id; })[0];
    renderCrate();
    if (keep) selectGenre(keep, true);
  }

  function renderCrate() {
    var crate = $('crate'); crate.textContent = '';
    pack.genres.filter(function (g) { return filter === 'all' || g.tag === filter; }).forEach(function (g) {
      var b = document.createElement('button');
      b.className = 'gcard'; b.type = 'button';
      b.setAttribute('aria-pressed', genre && genre.id === g.id ? 'true' : 'false');
      var isNew = g.addedAt && g.addedAt > (BUNDLED.updated || '');
      var flames = new Array((g.trend || 0) + 1).join('▲');
      b.innerHTML = '<div class="t"><b></b><span class="bpm"></span></div><div><span class="tag"></span>' + (isNew ? '<span class="tag baru">Baru</span>' : '') + '<span class="flames" title="Seberapa ramai"></span></div><p></p>';
      b.querySelector('b').textContent = g.name;
      b.querySelector('.bpm').textContent = g.bpm + ' BPM';
      var tag = b.querySelector('.tag'); tag.textContent = g.tag; tag.className = 'tag ' + (g.tag === 'Lokal' ? 'lokal' : 'global');
      b.querySelector('.flames').textContent = flames;
      b.querySelector('p').textContent = g.desc;
      b.addEventListener('click', function () { selectGenre(g); });
      crate.appendChild(b);
    });
  }

  function selectGenre(g, silent) {
    genre = g;
    engine.setGenre(g);
    store('aidj-genre', g.id);
    $('genreNow').textContent = g.name;
    $('genreTip').textContent = g.tip || g.desc;
    var cards = document.querySelectorAll('.gcard');
    for (var i = 0; i < cards.length; i++) cards[i].setAttribute('aria-pressed', cards[i].querySelector('b').textContent === g.name ? 'true' : 'false');
    if (!silent && engine.playing) toast('Ganti ke ' + g.name, 'var(--amber)');
  }
  engine.on('genre', function () {
    var minorish = engine.scale !== window.AIDJEngine.SCALES.major;
    $('keyNow').textContent = window.AIDJEngine.PC_NAMES[engine.keyPc] + (minorish ? ' minor' : ' mayor');
  });
  engine.on('bpm', function (b) { $('bpmNow').textContent = Math.round(b); });

  $('filters').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    filter = b.getAttribute('data-f');
    var chips = this.querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) chips[i].setAttribute('aria-pressed', chips[i] === b ? 'true' : 'false');
    renderCrate();
  });

  function checkUpdate(silent) {
    var st = $('updStatus');
    if (!silent) { st.className = 'status'; st.textContent = 'Mengecek paket genre terbaru...'; }
    var urls = (pack.updateUrls || BUNDLED.updateUrls || []).slice();
    function tryNext() {
      if (!urls.length) {
        if (!silent) { st.className = 'status err'; st.textContent = 'Server update tidak bisa dihubungi. Paket yang ada tetap dipakai.'; }
        return Promise.resolve();
      }
      var url = urls.shift();
      return fetch(url + (url.indexOf('?') < 0 ? '?t=' : '&t=') + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(function (txt) {
          var p = parsePack(txt);
          if (versionOf(p) > versionOf(pack)) {
            var before = pack.genres.length;
            usePack(mergePack(pack, p), true);
            var added = pack.genres.length - before;
            st.className = 'status ok';
            st.textContent = 'Diperbarui ke ' + p.version + (added > 0 ? ' · ' + added + ' genre baru' : '');
          } else if (!silent) {
            st.className = 'status ok'; st.textContent = 'Sudah versi terbaru (' + pack.version + ').';
          }
        })
        .catch(tryNext);
    }
    return tryNext();
  }
  $('checkUpdate').addEventListener('click', function () { checkUpdate(false); });
  $('packFile').addEventListener('change', function () {
    var f = this.files && this.files[0]; if (!f) return;
    var st = $('updStatus');
    f.text().then(function (txt) {
      var p = parsePack(txt);
      usePack(mergePack(pack, p), true);
      st.className = 'status ok'; st.textContent = 'Paket diimpor: ' + p.genres.length + ' genre.';
    }).catch(function () {
      st.className = 'status err'; st.textContent = 'File itu bukan paket genre AI DJ. Pilih file genres.js atau .json yang benar.';
    });
    this.value = '';
  });

  // ---------- Mixer + FX pad ----------
  [['vSong', 'song'], ['vBeat', 'beat'], ['vMusic', 'music'], ['vMaster', 'master']].forEach(function (p) {
    $(p[0]).addEventListener('input', function () { engine.setLevel(p[1], parseFloat(this.value)); });
  });
  (function () {
    var xy = $('xy'), dot = $('xyDot'), active = false;
    function move(e) {
      var r = xy.getBoundingClientRect();
      var px = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      var py = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      dot.style.left = (px * 100) + '%'; dot.style.top = (py * 100) + '%';
      var x = (px - 0.5) * 2; if (Math.abs(x) < 0.08) x = 0;
      engine.setXY(x, 1 - py);
    }
    xy.addEventListener('pointerdown', function (e) {
      engine.init().then(function () {});
      active = true; xy.classList.add('active');
      try { xy.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
      move(e);
      coach.hype = Math.min(100, coach.hype + 3);
    });
    xy.addEventListener('pointermove', function (e) { if (active) move(e); });
    function up() {
      if (!active) return;
      active = false; xy.classList.remove('active');
      dot.style.left = '50%'; dot.style.top = '100%';
      engine.releaseXY();
    }
    xy.addEventListener('pointerup', up); xy.addEventListener('pointercancel', up);
  })();

  // ---------- Song loader ----------
  function bestGenreFor(bpm) {
    var best = null, bestS = 1e9;
    pack.genres.forEach(function (g) {
      [0.5, 1, 2].forEach(function (m) {
        var s = Math.abs(Math.log(bpm * m / g.bpm)) + (m === 1 ? 0 : 0.12) + (g.tag === 'Lokal' ? -0.01 : 0);
        if (s < bestS) { bestS = s; best = g; }
      });
    });
    return best;
  }
  function loadSongFile(file) {
    var st = $('songStatus');
    if (!file) return;
    st.className = 'status'; st.textContent = 'Membaca "' + file.name + '"...';
    engine.init().then(function () { return file.arrayBuffer(); })
      .then(function (ab) {
        return new Promise(function (res, rej) { engine.ctx.decodeAudioData(ab, res, rej); });
      })
      .then(function (buf) {
        st.textContent = 'Menganalisis tempo dan nada...';
        return new Promise(function (res) { setTimeout(function () { res({ buf: buf, a: window.AIDJAnalyze.analyze(buf) }); }, 30); });
      })
      .then(function (r) {
        var a = r.a;
        engine.loadSong(r.buf, a);
        $('songInfo').hidden = false;
        $('songName').textContent = file.name.replace(/\.[^.]+$/, '');
        $('sBpm').textContent = Math.round(a.bpm * 10) / 10;
        $('sKey').textContent = a.key ? a.key.name.replace(' minor', 'm').replace(' mayor', '') : '—';
        var best = bestGenreFor(a.bpm);
        var m = $('sMatch'); m.textContent = best ? best.name : '—';
        m.onclick = null;
        if (best) { m.style.cursor = 'pointer'; m.title = 'Pakai genre ini'; m.onclick = function () { selectGenre(best); renderCrate(); }; }
        $('vMusic').value = 0.4; engine.setLevel('music', 0.4);
        st.className = 'status ok';
        st.textContent = (a.confidence < 0.25 ? 'Tempo kurang jelas, hasil bisa sedikit meleset. ' : '') + 'Siap. Tekan MAIN: lagu dan beat jalan bareng. Ketuk nama genre cocok untuk memakainya.';
        if (engine.playing) st.textContent = 'Lagu masuk di bar berikutnya.';
      })
      .catch(function (err) {
        console.error(err);
        st.className = 'status err';
        st.textContent = 'Lagu tidak bisa dibuka. Coba file MP3 atau WAV lain.';
      });
  }
  $('songFile').addEventListener('change', function () { loadSongFile(this.files && this.files[0]); this.value = ''; });
  (function () {
    var z = $('dropZone');
    z.addEventListener('dragover', function (e) { e.preventDefault(); z.classList.add('over'); });
    z.addEventListener('dragleave', function () { z.classList.remove('over'); });
    z.addEventListener('drop', function (e) {
      e.preventDefault(); z.classList.remove('over');
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadSongFile(f);
    });
  })();
  $('songRemove').addEventListener('click', function () {
    engine.unloadSong();
    $('songInfo').hidden = true;
    $('songStatus').textContent = 'Lagu dilepas. Beat AI jalan sendiri.';
    $('vMusic').value = 0.8; engine.setLevel('music', 0.8);
  });
  $('tempoMode').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var btns = this.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', btns[i] === b ? 'true' : 'false');
    engine.setTempoMode(b.getAttribute('data-m'));
  });

  $('nudge').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b || !engine.song) return;
    var n = parseFloat(b.getAttribute('data-n'));
    var sec = Math.abs(n) >= 1 ? n * 60 / engine.song.bpm : n;
    engine.nudgeSong(sec);
    $('songStatus').className = 'status';
    $('songStatus').textContent = engine.playing ? 'Digeser. Berlaku di bar berikutnya.' : 'Digeser. Berlaku saat MAIN.';
  });

  // ---------- Recorder ----------
  var rec = null, chunks = [], recMime = '';
  function startRec(el) {
    engine.init().then(function () {
      if (!engine.recDest || !window.MediaRecorder) {
        el.setAttribute('aria-pressed', 'false');
        toast('Rekam tidak didukung di sini', 'var(--pink)');
        return;
      }
      var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      recMime = '';
      for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(types[i])) { recMime = types[i]; break; }
      chunks = [];
      rec = new MediaRecorder(engine.recDest.stream, recMime ? { mimeType: recMime } : undefined);
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = saveRec;
      rec.start(1000);
      toast('Merekam...', 'var(--pink)');
    });
  }
  function stopRec() { if (rec && rec.state !== 'inactive') rec.stop(); }
  function saveRec() {
    var type = (rec && rec.mimeType) || recMime || 'audio/webm';
    var blob = new Blob(chunks, { type: type });
    var ext = type.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
    var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var name = 'ai-dj-set-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.' + ext;
    var useCap = window.claude && typeof window.claude.use === 'function' ? window.claude.use('downloads') : Promise.resolve(null);
    useCap.then(function (dl) {
      if (dl) {
        return dl.save({ filename: name, data: blob }).then(function () { toast('Rekaman disimpan', 'var(--good)'); })
          .catch(function (err) { if (err && err.code !== 'declined') toast('Gagal menyimpan rekaman', 'var(--pink)'); });
      }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('Rekaman disimpan', 'var(--good)');
    }).catch(function () { toast('Gagal menyimpan rekaman', 'var(--pink)'); });
  }

  // ---------- Keyboard ----------
  document.addEventListener('keydown', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (e.repeat) return;
    if (e.code === 'Space' && !(e.target && e.target.classList && e.target.classList.contains('pad'))) {
      e.preventDefault(); $('play').click(); return;
    }
    var id = KEYMAP[e.key.toLowerCase()];
    if (!id) return;
    if (id === 'roll') rollOn(); else press(id);
  });
  document.addEventListener('keyup', function (e) { if (e.key.toLowerCase() === 'r') rollOff(); });

  // ---------- Boot ----------
  buildPads();
  try {
    var cached = store('aidj-pack');
    if (cached) { var cp = parsePack(cached); if (versionOf(cp) > versionOf(BUNDLED)) pack = mergePack(BUNDLED, cp); }
  } catch (e) { /* cached pack unreadable, use bundled */ }
  usePack(pack, false);
  var savedId = store('aidj-genre');
  var first = pack.genres.filter(function (g) { return g.id === savedId; })[0] || pack.genres[0];
  selectGenre(first, true);
  renderCrate();
  sizeCanvas();
  requestAnimationFrame(draw);
  setTimeout(function () { checkUpdate(true); }, 1500);
})();
