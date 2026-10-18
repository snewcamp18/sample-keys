/* Auto-map: split one recording of many single notes (e.g. every key of a piano, one after another)
 * into samples, one per key.
 *
 * 1. Note starts: the recording is rendered through six band-pass filters (OfflineAudioContext, so it runs
 *    natively), and a new note shows up as a sudden rise in level across the bands ("spectral flux"). Using
 *    rises rather than levels finds a note even while the previous one is still ringing.
 * 2. Pitch: YIN pitch detection on a short window just after each attack.
 * 3. Keys: when the notes were played in order, a best-path search (dynamic programming) finds the run of keys
 *    that fits the heard pitches best while only moving one way along the keyboard. Repeated strikes, skipped
 *    keys and stray triggers are allowed, so a few wrong pitch readings on bass notes can't shift the rest.
 *    Keys struck more than once become "takes": the clearest one is used, or the quieter and louder ones can
 *    become the soft and loud velocity layers.
 * All notes reference the same recording; each sample's start/end marks its slice.
 *
 * Shares the page's global scope with index.html (samples, makeSample, build, noteName, …).
 */
(() => {
  const BAND_SR = 11025, HOP = 128, BANDS = [90, 180, 360, 720, 1440, 2880];
  const MIN_GAP = 0.25, PRE = 0.004;
  let A = null;          // the current analysis
  let previewSrc = null;

  const tick = () => new Promise(r => setTimeout(r, 0));
  const pct = (arr, q) => { const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))] };
  const fmtT = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

  function progress(msg) {
    openSheet(`<h3>Auto-map a recording</h3><p class="sub">${msg}</p><div class="ambar"><i style="width:${Math.round((A && A.prog || 0) * 100)}%"></i></div>`, () => { if (A) A.cancel = true }, true);
  }

  /* ---------- analysis ---------- */
  async function analyse(file) {
    ensureAudio();
    A = { file, cancel: false, prog: 0 };
    progress('Reading the recording…');
    const bytes = await file.arrayBuffer();
    let raw;
    try { raw = await decodeAudio(bytes) } catch (e) { closeSheet(); toast(`Couldn't read "${file.name}". Try exporting it as WAV or M4A.`); A = null; return }
    if (raw.duration < 0.5) { closeSheet(); toast('That recording is too short to contain several notes.'); A = null; return }
    Object.assign(A, { bytes, mime: file.type || 'audio/wav', raw, sr: raw.sampleRate });
    // big uncompressed takes (e.g. 32-bit float WAV from a field recorder) are stored as AAC; analyse what's stored
    if (window.SKCompress && SKCompress.worth(file, bytes)) {
      A.prog = .05; progress(`Compressing the recording (${SKCompress.mb(bytes.byteLength)})…`);
      try {
        const c = await SKCompress.compress(file, raw, bytes, f => { A.prog = .05 + .05 * f; progress(`Compressing the recording (${SKCompress.mb(bytes.byteLength)})… ${Math.round(f * 100)}%`) });
        if (c) Object.assign(A, { bytes: c.bytes, mime: c.mime, raw: c.raw, sr: c.raw.sampleRate, compressed: `${SKCompress.mb(bytes.byteLength)} → ${SKCompress.mb(c.bytes.byteLength)}` });
      } catch (e) { console.warn('Could not compress', e) }
      if (A.cancel) return;
      raw = A.raw;
    }

    // mono mix at the recording's own rate, for exact note starts and pitch
    const n = raw.length, mono = new Float32Array(n), chs = raw.numberOfChannels;
    for (let c = 0; c < chs; c++) { const d = raw.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / chs }
    A.mono = mono;

    A.prog = .1; progress('Listening for notes…');
    const oc = new OfflineAudioContext(BANDS.length, Math.ceil(raw.duration * BAND_SR), BAND_SR);
    const src = oc.createBufferSource(); src.buffer = raw;
    const merger = oc.createChannelMerger(BANDS.length);
    BANDS.forEach((f, b) => { const bp = oc.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 1.2; src.connect(bp); bp.connect(merger, 0, b) });
    merger.connect(oc.destination); src.start();
    const bands = await oc.startRendering();
    if (A.cancel) return;

    // level per band per hop (dB), plus broadband level from the full-rate mix
    const T = Math.floor(bands.length / HOP), hopSrc = HOP * A.sr / BAND_SR;
    const E = BANDS.map(() => new Float32Array(T)), BB = new Float32Array(T);
    for (let b = 0; b < BANDS.length; b++) {
      const d = bands.getChannelData(b), e = E[b];
      for (let t = 0; t < T; t++) { let s = 0; for (let i = t * HOP, j = i + HOP; i < j; i++) s += d[i] * d[i]; e[t] = 10 * Math.log10(s / HOP + 1e-12) }
      const floor = Math.max(-90, pct(e, .99) - 70); for (let t = 0; t < T; t++) if (e[t] < floor) e[t] = floor;
    }
    for (let t = 0; t < T; t++) {
      const a = Math.floor(t * hopSrc), z = Math.min(n, Math.floor((t + 1) * hopSrc)); let s = 0;
      for (let i = a; i < z; i++) s += mono[i] * mono[i];
      BB[t] = 10 * Math.log10(s / Math.max(1, z - a) + 1e-12);
    }
    const bbFloor = pct(BB, .1);
    for (let t = 0; t < T; t++) if (BB[t] < bbFloor) BB[t] = bbFloor;
    const flux = new Float32Array(T);
    for (let t = 2; t < T; t++) {
      let f = 2 * Math.max(0, BB[t] - BB[t - 2]);
      for (let b = 0; b < BANDS.length; b++) f += Math.max(0, E[b][t] - E[b][t - 2]);
      flux[t] = f;
    }
    Object.assign(A, { T, hopSec: HOP / BAND_SR, flux, BB, bbFloor, fluxRef: pct(flux, .995) || 1, pitchCache: new Map() });
    A.prog = .45; progress('Finding each note…');
    await pick(.5);
    if (A.cancel) return;
    review();
  }

  // choose note starts at a sensitivity (0 = only clear attacks … 1 = catch quiet ones too)
  async function pick(sens) {
    A.sens = sens;
    const { T, flux, BB, bbFloor, hopSec, fluxRef } = A, W = Math.round(.35 / hopSec), delta = fluxRef * (.5 - .44 * sens);
    const peaks = [];
    let sum = 0; for (let t = 0; t < Math.min(T, W); t++) sum += flux[t];
    for (let t = 0; t < T; t++) {
      if (t + W < T) sum += flux[t + W]; if (t - W - 1 >= 0) sum -= flux[t - W - 1];
      const mean = sum / (Math.min(T - 1, t + W) - Math.max(0, t - W - 1));
      const f = flux[t];
      if (f <= mean + delta) continue;
      let isMax = true; for (let k = -3; k <= 3; k++) if (k && flux[t + k] > f) { isMax = false; break }
      if (!isMax) continue;
      if (BB[Math.min(T - 1, t + 3)] < bbFloor + 10) continue;
      const time = (t - 1) * hopSec;
      if (peaks.length && time - peaks[peaks.length - 1].frameTime < MIN_GAP) continue;
      peaks.push({ frameTime: time, t, strength: f });
    }
    // exact start: the hammer/pluck click is a burst of high frequencies, sharp at every pitch, so track the
    // first difference of the signal (a simple high-pass) in 1 ms blocks and take the first block that rises
    // a quarter of the way from the level before the note to the attack's peak
    const { mono, sr } = A, w = Math.max(16, Math.round(sr * .001));
    for (const p of peaks) {
      const a = Math.max(1, Math.floor((p.frameTime - .05) * sr)), z = Math.min(mono.length, Math.floor((p.frameTime + .06) * sr));
      const env = [];
      for (let i = a; i + w <= z; i += w) { let e = 0; for (let k = i; k < i + w; k++) { const d = mono[k] - mono[k - 1]; e += d * d } env.push(e) }
      const before = env.slice(0, Math.round(.03 * sr / w)).sort((x, y) => x - y), pre = before[before.length >> 1] || 0;
      const peak = Math.max(...env), thr = pre + .25 * (peak - pre);
      const j = Math.max(0, env.findIndex(e => e >= thr));
      p.start = Math.max(0, (a + j * w) / sr - PRE);
    }
    // ends: the next note's start, or where this one has faded into the room noise
    for (let k = 0; k < peaks.length; k++) {
      const p = peaks[k], next = k + 1 < peaks.length ? peaks[k + 1].start - .005 : A.raw.duration;
      let end = next, quiet = 0;
      for (let t = p.t + 5; t < A.T && t * hopSec < next; t++) {
        if (A.BB[t] < bbFloor + 4) { if (++quiet * hopSec > .2) { end = (t - quiet) * hopSec + .1; break } } else quiet = 0;
      }
      p.end = Math.max(p.start + .05, Math.min(next, end, p.start + 20));
    }
    // pitch of each note (cached, since moving the sensitivity slider re-picks)
    for (let k = 0; k < peaks.length; k++) {
      const p = peaks[k], key = Math.round(p.start * 1000);
      if (!A.pitchCache.has(key)) A.pitchCache.set(key, detectPitch(p.start, p.end));
      p.pitch = A.pitchCache.get(key);
      if (k % 8 === 7) { A.prog = .45 + .5 * k / peaks.length; if (A.reviewing) { } else progress(`Working out pitches… ${k + 1} of ${peaks.length}`); await tick(); if (A.cancel) return }
    }
    A.rows = peaks.map(p => ({ start: p.start, end: p.end, pitch: p.pitch, level: levelOf(p.start, p.end), on: true, key: null }));
    if (!A.order) A.order = 'up';
    assign();
  }

  // how hard a note was struck: its peak in the first 300 ms
  function levelOf(start, end) {
    const { mono, sr } = A, a = Math.floor(start * sr), z = Math.min(mono.length, Math.floor(Math.min(end, start + .3) * sr));
    let pk = 0; for (let i = a; i < z; i++) { const v = mono[i] < 0 ? -mono[i] : mono[i]; if (v > pk) pk = v }
    return pk;
  }
  function detectPitch(start, end) {
    const { mono, sr } = A, dec = Math.max(1, Math.round(sr / 16000)), fs = sr / dec;
    const a0 = start + Math.min(.06, (end - start) * .25), len = Math.min(end - a0, .16);
    const N = Math.floor(len * fs); if (N < 200) return null;
    const x = new Float32Array(N), base = Math.floor(a0 * sr);
    for (let i = 0; i < N; i++) { let s = 0; for (let k = 0; k < dec; k++) s += mono[base + i * dec + k] || 0; x[i] = s / dec }
    return yin(x, fs);
  }
  function yin(x, fs) {
    const tauMax = Math.min(Math.floor(fs / 26), Math.floor(x.length / 2)), tauMin = Math.max(2, Math.floor(fs / 4500)), W = x.length - tauMax;
    if (W < 64) return null;
    const d = new Float32Array(tauMax + 1), c = new Float32Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) { let s = 0; for (let j = 0; j < W; j++) { const v = x[j] - x[j + tau]; s += v * v } d[tau] = s }
    let run = 0; c[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; c[tau] = run ? d[tau] * tau / run : 1 }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) if (c[t] < .15) { while (t + 1 <= tauMax && c[t + 1] < c[t]) t++; tau = t; break }
    if (tau < 0) { let m = 1e9; for (let t = tauMin; t <= tauMax; t++) if (c[t] < m) { m = c[t]; tau = t } if (m > .4) return null }
    const p0 = c[tau - 1], p1 = c[tau], p2 = tau + 1 <= tauMax ? c[tau + 1] : p1, den = p0 - 2 * p1 + p2;
    const f = fs / (tau + (den ? .5 * (p0 - p2) / den : 0));
    const midi = 69 + 12 * Math.log2(f / 440);
    return midi >= 20 && midi <= 110 ? midi : null;
  }

  // How well a heard pitch fits a key, in semitones (capped). Piano notes are often heard an octave, an octave and
  // a fifth, or two octaves too high (strong overtones, weak fundamental in the bass), so those cost a little more.
  function fit(r, k) {
    if (r.pitch == null) return .6;
    const p = r.pitch;
    return Math.min(2.5, Math.abs(p - k), Math.abs(p - 12 - k) + .5, Math.abs(p - 19 - k) + .7, Math.abs(p - 24 - k) + .7, Math.abs(p + 12 - k) + .8);
  }
  // Costs for the path search. Striking a key a second time is normal; a third or later time at the normal
  // playing pace is unusual, so it costs more (this keeps a few misheard bass notes from being lumped onto one key).
  // A strike within RETRIGGER seconds of the previous one is usually a stray trigger, so it stays cheap.
  const REPEAT = .4, REPEAT_MORE = 1.5, RETRIGGER = .8, RETRIGGER_COST = .1, SKIP = 1.5;
  // keys for each included note, from the playing order
  function assign(firstOverride) {
    A.rows.forEach(r => { r.key = null; r.manual = false });
    const rows = A.rows.filter(r => r.on);
    if (!rows.length) { groupTakes(); return }
    if (A.order === 'any') { for (const r of rows) r.key = r.pitch == null ? null : Math.round(r.pitch) }
    else {
      // state = (key index j, normal-pace repeats so far c ∈ 0..2); dp holds the cheapest path cost ending there
      const dir = A.order === 'down' ? -1 : 1, K = HIGH - LOW + 1, C = 3, keyAt = j => dir > 0 ? LOW + j : HIGH - j, n = rows.length;
      let dp = new Float64Array(K * C).fill(Infinity);
      for (let j = 0; j < K; j++) if (firstOverride == null || keyAt(j) === firstOverride) dp[j * C] = fit(rows[0], keyAt(j));
      const back = [];
      for (let i = 1; i < n; i++) {
        const nd = new Float64Array(K * C).fill(Infinity), bk = new Int32Array(K * C).fill(-1);
        const quick = rows[i].start - rows[i - 1].start < RETRIGGER;
        // best way to be on each key with any repeat count, for moving on to a later key
        const best = new Float64Array(K), bestAt = new Int32Array(K);
        for (let j = 0; j < K; j++) { let m = Infinity, at = -1; for (let c = 0; c < C; c++) if (dp[j * C + c] < m) { m = dp[j * C + c]; at = j * C + c } best[j] = m; bestAt[j] = at }
        let runMin = Infinity, runAt = -1;
        for (let j = 0; j < K; j++) {
          const f = fit(rows[i], keyAt(j));
          for (let c = 0; c < C; c++) {   // strike the same key again
            const from = j * C + c; if (dp[from] === Infinity) continue;
            const c2 = quick ? c : Math.min(c + 1, C - 1), cost = dp[from] + (quick ? RETRIGGER_COST : c === 0 ? REPEAT : REPEAT_MORE) + f;
            if (cost < nd[j * C + c2]) { nd[j * C + c2] = cost; bk[j * C + c2] = from }
          }
          let mv = Infinity, mvAt = -1;
          if (j >= 1) { mv = best[j - 1]; mvAt = bestAt[j - 1] }                        // the next key
          if (j >= 2) {                                                                   // jumped over j-j'-1 keys
            const v = best[j - 2] - SKIP * (j - 2); if (v < runMin) { runMin = v; runAt = bestAt[j - 2] }
            const sk = runMin + SKIP * (j - 1); if (sk < mv) { mv = sk; mvAt = runAt }
          }
          if (mv + f < nd[j * C]) { nd[j * C] = mv + f; bk[j * C] = mvAt }
        }
        back.push(bk); dp = nd;
      }
      let st = 0; for (let x = 1; x < K * C; x++) if (dp[x] < dp[st]) st = x;
      for (let i = n - 1; i >= 0; i--) { rows[i].key = keyAt(Math.floor(st / C)); if (i) st = back[i - 1][st] }
      A.first = rows[0].key;
    }
    groupTakes();
  }
  // Keys struck more than once: keep the clearest take, or use the quieter and louder ones as soft and loud layers.
  function groupTakes() {
    const by = new Map();
    A.rows.forEach(r => { r.extra = false; r.layer = null; if (r.on && r.key != null) { if (!by.has(r.key)) by.set(r.key, []); by.get(r.key).push(r) } });
    A.multi = 0;
    for (const takes of by.values()) {
      if (takes.length < 2) continue;
      A.multi++;
      if (A.dupMode === 'layers') {
        const s = [...takes].sort((a, b) => a.level - b.level);
        s[0].layer = 'soft'; s[s.length - 1].layer = 'loud';
        s.slice(1, -1).forEach(r => r.extra = true);
      } else {
        const score = r => (r.pitch == null ? 1 : Math.min(1, Math.abs(r.pitch - r.key))) - Math.min(r.end - r.start, 3) * .3;
        const best = takes.reduce((a, b) => score(b) < score(a) ? b : a);
        takes.forEach(r => { if (r !== best) r.extra = true });
      }
    }
    A.keys = by.size;
  }

  /* ---------- review ---------- */
  function review() {
    A.reviewing = true;
    const base = A.file.name.replace(/\.[^.]+$/, '');
    openSheet(`<h3 id="amTitle"></h3>
      <p class="sub">From “${esc(A.file.name)}” (${fmtT(A.raw.duration)}${A.compressed ? `, compressed ${A.compressed}` : ''}). Check the list, preview anything that looks off, then map the notes to keys.</p>
      <canvas class="amwave" id="amWave"></canvas>
      <div class="amopts">
        <label class="tf">Played <select id="amOrder"><option value="up">in order, low to high</option><option value="down">in order, high to low</option><option value="any">in any order</option></select></label>
        <label class="tf" id="amFirstWrap">First note <select id="amFirst"></select></label>
        <label class="tf" id="amDupWrap">Keys played more than once <select id="amDup"><option value="best">use the clearest take</option><option value="layers">quieter = soft, louder = loud layer</option></select></label>
        <label class="tf">Note detection <span class="hint">fewer</span><input type="range" id="amSens" min="0" max="1" step="0.01" value="${A.sens}"><span class="hint">more</span></label>
      </div>
      <div class="amlist" id="amList"></div>
      <div class="amdest">
        <label class="tf" id="amLayerWrap">Velocity layer <select id="amLayer"><option value="all">All velocities (one take)</option><option value="soft">Soft layer: velocity 1–79</option><option value="loud">Loud layer: velocity 80–127</option></select></label>
        <p class="hint" style="margin:0">For soft and loud layers, record the keys twice. Map the first take as a new instrument, then the second with “Add to”.</p>
        <label class="chk"><input type="radio" name="amDest" value="new" checked> New instrument named</label>
        <input class="tx" id="amName" value="${esc(base)}" autocomplete="off">
        <label class="chk"><input type="radio" name="amDest" value="cur"> Add to “${esc(cur.name)}” (replaces sounds on the same keys and layer)</label>
      </div>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn pri" id="amGo"></button></div>`,
      () => { stopPreview(); A = null }, true);
    const $ = id => document.getElementById(id);
    $('amOrder').value = A.order;
    $('amOrder').onchange = e => { A.order = e.target.value; assign(); refresh() };
    $('amFirst').onchange = e => { assign(+e.target.value); refresh() };
    $('amDup').value = A.dupMode || 'best';
    $('amDup').onchange = e => { A.dupMode = e.target.value; groupTakes(); refresh() };
    let sensT;
    $('amSens').oninput = e => { clearTimeout(sensT); sensT = setTimeout(async () => { await pick(+e.target.value); refresh() }, 150) };
    $('amGo').onclick = apply;
    refresh();
  }
  function refresh() {
    const $ = id => document.getElementById(id); if (!A || !$('amList')) return;
    const used = A.rows.filter(r => r.on && r.key != null && !r.extra), flagged = A.rows.filter(r => r.on && flag(r)).length;
    const extras = A.rows.filter(r => r.on && r.extra).length, layered = A.dupMode === 'layers' && A.multi > 0;
    $('amTitle').textContent = `Found ${A.rows.length} note${A.rows.length === 1 ? '' : 's'}`;
    $('amFirstWrap').hidden = A.order === 'any';
    $('amFirst').innerHTML = keyOpts(A.first ?? 21);
    $('amDupWrap').hidden = !A.multi;
    $('amLayerWrap').hidden = layered;
    const nk = new Set(used.map(r => r.key)).size;
    $('amGo').textContent = nk ? `Map ${nk} key${nk === 1 ? '' : 's'}${layered ? ' with soft and loud layers' : ''}` : 'Nothing to map';
    $('amGo').disabled = !nk;
    const keys = used.map(r => r.key);
    $('amList').innerHTML = `<div class="amsum">${nk ? `${noteName(Math.min(...keys))} to ${noteName(Math.max(...keys))} · ${nk} keys` : ''}${A.multi ? ` · ${A.multi} played more than once` : ''}${extras ? ` · ${extras} extra take${extras === 1 ? '' : 's'} not used` : ''}${flagged ? ` · <b>${flagged} to check</b> (⚠)` : ''}</div>` +
      A.rows.map((r, i) => `<div class="amrow ${r.on && !r.extra ? '' : 'off'} ${r.on && flag(r) ? 'warn' : ''}" data-i="${i}">
        <input type="checkbox" ${r.on ? 'checked' : ''} aria-label="Include note ${i + 1}">
        <span class="amn">${i + 1}</span><span class="amt">${fmtT(r.start)}</span>
        <span class="amp">${r.pitch == null ? 'pitch unclear' : 'heard ' + noteName(Math.round(r.pitch)) + ' ' + cents(r.pitch)}${r.on && r.extra ? ' · extra take' : r.layer ? ' · ' + r.layer : ''}</span>
        <select ${r.on ? '' : 'disabled'} aria-label="Key for note ${i + 1}"><option value="">—</option>${keyOpts(r.key)}</select>
        <button class="btn sm" title="Preview">▶</button></div>`).join('');
    $('amList').querySelectorAll('.amrow').forEach(el => {
      const r = A.rows[+el.dataset.i];
      el.querySelector('input').onchange = e => { r.on = e.target.checked; assign(A.order === 'any' ? undefined : A.first); refresh() };
      el.querySelector('select').onchange = e => { r.key = e.target.value === '' ? null : +e.target.value; r.manual = true; groupTakes(); refresh() };
      el.querySelector('button').onclick = () => preview(r);
    });
    drawOverview();
  }
  const cents = m => { const c = Math.round((m - Math.round(m)) * 100); return c ? `${c > 0 ? '+' : '−'}${Math.abs(c)}¢` : '' };
  // a note whose heard pitch disagrees with its key (ignoring octave slips, which are common on piano bass notes)
  const flag = r => !r.extra && !r.manual && (r.key == null || (r.pitch != null && Math.abs(((Math.round(r.pitch) - r.key) % 12 + 12) % 12) > 0));

  function drawOverview() {
    const cv = document.getElementById('amWave'); if (!cv) return;
    const r = dpr(), W = cv.width = Math.round(cv.clientWidth * r), H = cv.height = Math.round(cv.clientHeight * r), g = cv.getContext('2d');
    const m = A.mono, step = m.length / W;
    g.fillStyle = '#ffffff40';
    for (let x = 0; x < W; x++) {
      let pk = 0; for (let i = Math.floor(x * step), z = Math.floor((x + 1) * step); i < z; i += 4) { const v = Math.abs(m[i]); if (v > pk) pk = v }
      const h = Math.max(1, pk * H * .9); g.fillRect(x, (H - h) / 2, 1, h);
    }
    for (const row of A.rows) { g.fillStyle = !row.on || row.extra ? '#ffffff30' : flag(row) ? '#ff6b6b' : '#f2a23a'; g.fillRect(row.start / A.raw.duration * W, 0, Math.max(1, r), H) }
  }
  function stopPreview() { if (previewSrc) { try { previewSrc.stop() } catch (e) {} previewSrc = null } }
  function preview(r) {
    ensureAudio(); if (ctx.state !== 'running') return;
    stopPreview();
    const s = ctx.createBufferSource(); s.buffer = A.raw; s.connect(inBus);
    s.start(0, r.start, Math.min(r.end - r.start, 3)); previewSrc = s;
  }

  /* ---------- apply ---------- */
  async function apply() {
    const use = A.rows.filter(r => r.on && r.key != null && !r.extra), seen = new Set(use.map(r => r.key));
    const toNew = document.querySelector('input[name=amDest]:checked').value === 'new';
    const name = (document.getElementById('amName').value.trim() || 'Recorded instrument');
    const RANGE = { all: [1, 127], soft: [1, 79], loud: [80, 127] };
    // one take per key: the chosen velocity layer; keys with soft/loud takes: each take its own layer
    const layered = A.dupMode === 'layers' && A.multi > 0;
    const layer = layered ? 'both' : document.getElementById('amLayer').value, [vlo, vhi] = layered ? [1, 127] : RANGE[layer];
    const rangeOf = r => layered ? RANGE[r.layer || 'all'] : [vlo, vhi];
    const overlaps = s => s.p.vlo <= vhi && vlo <= s.p.vhi;
    const { bytes, mime, raw } = A;
    stopPreview();
    A.reviewing = false;
    closeSheet();
    if (toNew) {
      await flush();
      await loadInstrument({ ...blankInst(), name });
    } else {
      samples = samples.filter(s => !(seen.has(s.root) && overlaps(s)));
    }
    S.mode = 'melodic';
    const label = toNew ? name : name.slice(0, 40);
    // one volume boost for the whole take, so the notes keep their natural balance. When this take is a second
    // velocity layer, both layers share the smaller boost so the soft take stays softer than the loud one.
    let boost = autoGain(peakOf(raw));
    const otherLayer = toNew || layer === 'all' || layered ? [] : samples.filter(s => !overlaps(s));
    if (otherLayer.length) {
      const theirs = Math.max(...otherLayer.map(s => s.p.gain));
      if (boost < theirs) otherLayer.forEach(s => { s.p.gain = +(s.p.gain - (theirs - boost)).toFixed(1) });
      else boost = theirs;
    }
    const keyList = [...seen].sort((a, b) => a - b);
    use.sort((a, b) => a.key - b.key || (a.layer === 'loud') - (b.layer === 'loud')).forEach(r => {
      const tag = layered ? r.layer || '' : layer === 'all' ? '' : layer, [lo, hi] = rangeOf(r);
      const s = makeSample(`${label} ${noteName(r.key)}${tag ? ' ' + tag : ''}`, bytes, mime, raw, r.key, COLORS[keyList.indexOf(r.key) % COLORS.length]);
      Object.assign(s.p, { start: r.start, end: r.end, loopStart: r.start, loopEnd: r.end, fadeIn: .002, fadeOut: Math.min(.06, (r.end - r.start) * .2), vlo: lo, vhi: hi, gain: boost });
      normalizeP(s.p, raw.duration); build(s); samples.push(s);
    });
    selectSample(samples.find(s => s.root === keyList[0]) || samples[0] || null);
    seqScrollTo = true;
    updateFace(); renderSamples(); refreshZones(); syncFields(); renderSeq(); markDirty();
    toast(`Mapped ${keyList.length} key${keyList.length === 1 ? '' : 's'}${keyList.length ? ` from ${noteName(keyList[0])} to ${noteName(keyList[keyList.length - 1])}` : ''}${layered ? ' with soft and loud layers' : layer === 'all' ? '' : ` as the ${layer} layer`}${boost >= 3 ? ` · volume raised ${boost} dB` : ''}`);
  }

  /* ---------- entry points ---------- */
  const input = document.getElementById('autoFile');
  input.addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) analyse(f).catch(err => { console.error(err); closeSheet(); toast("Couldn't analyse that recording.") }) });
  window.SKAutoMap = { open: () => input.click(), analyse };
})();
