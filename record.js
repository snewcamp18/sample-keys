/* Record: sample straight from this device's microphone.
 *
 * Voice-call processing (echo cancellation, noise suppression, automatic gain) is switched off, since it
 * chops note tails and pumps the volume. The take is saved as AAC in .m4a when the browser can record it
 * (Safari, recent Chrome) — the same format as iPhone Voice Memos, which every device can decode — and as a
 * 16-bit WAV otherwise, so a recording made on one device always plays on the others after syncing.
 *
 * Any input the device offers can be picked (a USB recorder or audio interface such as a Zoom H4essential in
 * audio-interface mode shows up as a microphone); the choice is remembered. Stereo inputs are kept in stereo.
 *
 * Shares the page's global scope with index.html (ctx, ensureAudio, addFiles, openSheet, …).
 */
(() => {
  const MAX_SECONDS = 10 * 60;
  let stream = null, recorder = null, chunks = [], proc = null, pcm = [], analyser = null, srcNode = null;
  let t0 = 0, raf = 0, take = null, count = 1, peaks = [];

  const MIC_KEY = 'sk-mic';
  const savedMic = () => { try { return localStorage.getItem(MIC_KEY) || '' } catch (e) { return '' } };
  const saveMic = id => { try { localStorage.setItem(MIC_KEY, id) } catch (e) {} };
  // fill the microphone list; names only appear once the browser has been allowed to use a microphone
  async function listMics() {
    const sel = document.getElementById('rcDev'); if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications');
    const want = savedMic();
    sel.innerHTML = '<option value="">Default microphone</option>' + mics.filter(d => d.deviceId && d.deviceId !== 'default')
      .map((d, i) => `<option value="${esc(d.deviceId)}"${d.deviceId === want ? ' selected' : ''}>${esc(d.label || 'Microphone ' + (i + 1))}</option>`).join('');
    document.getElementById('rcDevWrap').hidden = mics.length < 2 && !mics.some(d => d.label);
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', () => listMics().catch(() => {}));

  const mp4Type = () => window.MediaRecorder && ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac'].find(t => MediaRecorder.isTypeSupported(t));
  const fmt = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

  function sheet(body) {
    openSheet(`<h3>Record a sound</h3>${body}`, cleanup, true);
  }
  function idle(msg = '') {
    sheet(`<p class="sub">Uses this device's microphone. Find a quiet spot; for a piano, hold the phone close to the strings with the lid open.</p>
      <label class="tf" id="rcDevWrap" style="margin-bottom:12px">Microphone <select id="rcDev" style="flex:1;min-width:0"><option value="">Default microphone</option></select></label>
      <p class="hint" style="margin:-4px 0 12px">Using a USB recorder like a Zoom H4essential? Plug it in, set it to audio-interface mode, and pick it here.</p>
      <canvas class="amwave" id="rcWave"></canvas>
      <div class="rctime" id="rcTime">0:00.0</div>
      ${msg ? `<p class="err">${msg}</p>` : ''}
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn pri" id="rcGo">● Start recording</button></div>`);
    document.getElementById('rcGo').onclick = start;
    document.getElementById('rcDev').onchange = e => saveMic(e.target.value);
    listMics().catch(() => {});
  }

  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      idle("This browser can't record here. Open Sample Keys from its web address in Safari or Chrome."); return;
    }
    ensureAudio();
    try { await ctx.resume() } catch (e) {}
    try {
      const dev = (document.getElementById('rcDev') || {}).value || savedMic();
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
      if (dev) audio.deviceId = { exact: dev };
      try { stream = await navigator.mediaDevices.getUserMedia({ audio }) }
      catch (e) {
        if (!dev || (e && e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError')) throw e;
        saveMic(''); delete audio.deviceId;               // the remembered device was unplugged: use the default
        stream = await navigator.mediaDevices.getUserMedia({ audio });
        toast('That microphone isn\'t connected, so the default one is being used.');
      }
    } catch (e) {
      const name = e && e.name;
      idle(name === 'NotAllowedError' || name === 'SecurityError'
        ? "Sample Keys isn't allowed to use the microphone. Allow it in your browser's site settings (on iPhone: Settings → Apps → Safari → Microphone), then try again."
        : name === 'NotFoundError' ? 'No microphone was found on this device.' : "Couldn't start the microphone: " + (e && e.message || e));
      return;
    }
    srcNode = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser(); analyser.fftSize = 2048; srcNode.connect(analyser);
    const type = mp4Type();
    if (type) {
      chunks = [];
      recorder = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 160000 });
      recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data) };
      recorder.start(1000);
    } else {
      // no AAC recorder in this browser: capture raw samples and write a WAV
      pcm = [];
      const chs = Math.min(2, (stream.getAudioTracks()[0].getSettings().channelCount) || 1);
      proc = ctx.createScriptProcessor(4096, chs, chs);
      const mute = ctx.createGain(); mute.gain.value = 0;
      proc.onaudioprocess = e => { const b = e.inputBuffer; pcm.push([...Array(b.numberOfChannels)].map((_, c) => new Float32Array(b.getChannelData(c)))) };
      srcNode.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    }
    t0 = performance.now(); peaks = [];
    const track = stream.getAudioTracks()[0], st = track.getSettings ? track.getSettings() : {};
    const from = track.label ? `${esc(track.label)}${st.channelCount === 2 ? ' · stereo' : ''}` : '';
    sheet(`<p class="sub">Recording${from ? ' from <b>' + from + '</b>' : ''}… Play your notes, then tap Stop.</p>
      <canvas class="amwave" id="rcWave"></canvas>
      <div class="rctime rec" id="rcTime">0:00.0</div>
      <div class="row"><button class="btn danger" id="rcStop">■ Stop</button></div>`);
    document.getElementById('rcStop').onclick = stop;
    meter();
  }

  // live level: a scrolling strip of peaks, so it's obvious the microphone is hearing the instrument
  function meter() {
    cancelAnimationFrame(raf);
    const buf = new Float32Array(analyser.fftSize);
    const loop = () => {
      const cv = document.getElementById('rcWave'), tl = document.getElementById('rcTime');
      if (!analyser || !cv) return;
      analyser.getFloatTimeDomainData(buf);
      let pk = 0; for (const v of buf) { const a = Math.abs(v); if (a > pk) pk = a }
      peaks.push(pk); if (peaks.length > 600) peaks.shift();
      const r = dpr(), W = cv.width = Math.round(cv.clientWidth * r), H = cv.height = Math.round(cv.clientHeight * r), g = cv.getContext('2d');
      const n = Math.min(peaks.length, Math.floor(W / (2 * r)));
      for (let i = 0; i < n; i++) {
        const v = peaks[peaks.length - n + i], h = Math.max(r, Math.min(1, v) * H * .95);
        g.fillStyle = v > .98 ? '#ff6b6b' : '#f2a23a';
        g.fillRect(W - (n - i) * 2 * r, (H - h) / 2, r * 1.4, h);
      }
      const secs = (performance.now() - t0) / 1000;
      if (tl) tl.textContent = fmt(secs);
      if (secs >= MAX_SECONDS) { stop(); return }
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  async function stop() {
    cancelAnimationFrame(raf);
    const secs = (performance.now() - t0) / 1000;
    let blob, ext;
    if (recorder) {
      const done = new Promise(r => recorder.onstop = r);
      recorder.stop(); await done;
      blob = new Blob(chunks, { type: 'audio/mp4' }); ext = 'm4a';
    } else {
      blob = wav(pcm, ctx.sampleRate); ext = 'wav';
    }
    release();
    if (secs < .3 || blob.size < 1000) { idle("That recording was empty. Check the microphone and try again."); return }
    take = { blob, ext, secs, url: URL.createObjectURL(blob) };
    const name = `Recording ${count}`;
    sheet(`<p class="sub">${fmt(secs)} recorded. Listen back, then add it as one sound or let Auto-map split it into notes.</p>
      <audio controls src="${take.url}" class="rcplay"></audio>
      <label class="tf" style="margin:12px 0">Name <input class="tx" id="rcName" value="${esc(name)}" autocomplete="off" style="margin:0"></label>
      <p class="hint" style="margin:0 0 12px">Tip: a note name in the name, like <code>Cello C3</code>, sets which key it plays on.</p>
      <div class="row"><button class="btn" id="rcAgain">Record again</button><button class="btn" id="rcMap">Auto-map notes…</button><button class="btn pri" id="rcAdd">Add as a sound</button></div>`);
    const file = () => new File([take.blob], `${(document.getElementById('rcName').value.trim() || name).replace(/[\\/:*?"<>|]+/g, ' ')}.${take.ext}`, { type: take.blob.type || (take.ext === 'wav' ? 'audio/wav' : 'audio/mp4') });
    document.getElementById('rcAgain').onclick = () => idle();
    document.getElementById('rcAdd').onclick = async () => {
      const f = file(); count++; closeSheet();
      await addFiles([f]);
      // recordings start with a moment of silence before the first sound: trim it
      if (sel && sel.name === f.name.replace(/\.[^.]+$/, '')) document.getElementById('bTrim').click();
      toast(`Added "${sel ? sel.name : f.name}"`);
    };
    document.getElementById('rcMap').onclick = () => { const f = file(); count++; window.SKAutoMap ? SKAutoMap.analyse(f) : toast('Auto-map could not load.') };
  }

  function wav(blocks, sr) {
    const ch = blocks.length ? blocks[0].length : 1, n = blocks.reduce((a, p) => a + p[0].length, 0), bytes = n * ch * 2;
    const b = new ArrayBuffer(44 + bytes), v = new DataView(b), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, bytes, true);
    let o = 44;
    for (const blk of blocks) for (let i = 0; i < blk[0].length; i++) for (let c = 0; c < ch; c++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, blk[c][i])) * 32767, true);
    return new Blob([b], { type: 'audio/wav' });
  }
  function release() {
    if (recorder && recorder.state !== 'inactive') try { recorder.stop() } catch (e) {}
    if (proc) { try { proc.disconnect() } catch (e) {} proc.onaudioprocess = null }
    if (srcNode) try { srcNode.disconnect() } catch (e) {}
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = recorder = proc = srcNode = analyser = null; pcm = []; chunks = [];
  }
  function cleanup() {
    cancelAnimationFrame(raf); release();
    if (take) { URL.revokeObjectURL(take.url); take = null }
  }

  window.SKRecord = { open: () => idle() };
})();
