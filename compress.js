/* Compress: turn big uncompressed recordings (WAV/AIFF/CAF/FLAC, e.g. 32-bit float takes from a Zoom recorder)
 * into AAC in an .m4a file — the same format as iPhone Voice Memos — before they're stored and synced.
 * A 4-minute stereo 32-bit float WAV (~90 MB) becomes about 6 MB.
 *
 * Encoding uses the browser's WebCodecs AudioEncoder; the .m4a container is written here. AAC encoders put a
 * short run of "priming" silence before the audio. The file records it twice: in a standard edit list, which
 * most decoders apply, and in a small 'skpk' tag (priming, length, rate) that decodeAudio() in index.html reads,
 * so every device ends up with sample-exact audio whether or not its decoder honours the edit list. The
 * encoder's priming is measured on this device rather than assumed.
 *
 * Every result is decoded again and checked against the original; if anything is off, or the browser can't
 * encode AAC, the file is stored as 16-bit WAV instead (still half the size of a 32-bit float file).
 */
(() => {
  const MIN_BYTES = 1.5 * 1048576;
  const RAW = /\.(wav|wave|bwf|aif|aiff|aifc|caf|flac)$/i;
  const enc = s => new TextEncoder().encode(s);

  // ---- tiny MP4 writer ----
  const cat = parts => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length } return o };
  const u32 = v => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v >>> 0); return a };
  const u16 = v => { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, v); return a };
  const box = (type, ...parts) => { const body = cat(parts); return cat([u32(8 + body.length), enc(type), body]) };
  const full = (type, version, flags, ...parts) => box(type, Uint8Array.of(version, flags >> 16 & 255, flags >> 8 & 255, flags & 255), ...parts);
  const zeros = n => new Uint8Array(n);
  const matrix = cat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  const desc = (tag, body) => cat([Uint8Array.of(tag, 0x80, 0x80, 0x80, body.length), body]);

  function mux({ frames, asc, sr, ch, length, delay, bitrate }) {
    const n = frames.length, mediaDur = n * 1024;
    const esds = full('esds', 0, 0, desc(3, cat([u16(1), Uint8Array.of(0),
      desc(4, cat([Uint8Array.of(0x40, 0x15, 0, 0, 0), u32(bitrate), u32(bitrate), desc(5, asc)])),
      desc(6, Uint8Array.of(2))])));
    const mp4a = box('mp4a', zeros(6), u16(1), zeros(8), u16(ch), u16(16), u16(0), u16(0), u32(sr * 65536), esds);
    const stbl = off => box('stbl',
      full('stsd', 0, 0, u32(1), mp4a),
      full('stts', 0, 0, u32(1), u32(n), u32(1024)),
      full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
      full('stsz', 0, 0, u32(0), u32(n), ...frames.map(f => u32(f.length))),
      full('stco', 0, 0, u32(1), u32(off)));
    const moov = off => box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(sr), u32(length), u32(0x10000), u16(0x100), zeros(10), matrix, zeros(24), u32(2)),
      box('trak',
        full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(length), zeros(8), u16(0), u16(0), u16(0x100), u16(0), matrix, u32(0), u32(0)),
        box('edts', full('elst', 0, 0, u32(1), u32(length), u32(delay), u16(1), u16(0))),
        box('mdia',
          full('mdhd', 0, 0, u32(0), u32(0), u32(sr), u32(mediaDur), u16(0x55c4), u16(0)),
          full('hdlr', 0, 0, u32(0), enc('soun'), zeros(12), enc('SoundHandler\0')),
          box('minf', full('smhd', 0, 0, u16(0), u16(0)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl(off)))),
      box('udta', box('skpk', u32(delay), u32(length), u32(sr))));
    const ftyp = box('ftyp', enc('M4A '), u32(0), enc('M4A '), enc('mp42'), enc('isom'));
    const off = ftyp.length + moov(0).length + 8;
    return cat([ftyp, moov(off), u32(8 + frames.reduce((a, f) => a + f.length, 0)), enc('mdat'), ...frames]).buffer;
  }

  // ---- AAC encoding ----
  async function config(sr, ch) {
    if (!window.AudioEncoder || !window.AudioData) return null;
    for (const bitrate of ch > 1 ? [192000, 160000, 128000] : [128000, 96000]) {
      const c = { codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch, bitrate, aac: { format: 'aac' } };
      try { if ((await AudioEncoder.isConfigSupported(c)).supported) return c } catch (e) {}
    }
    return null;
  }
  const SR_INDEX = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
  async function encode(planes, cfg, onProgress) {
    const frames = [], ch = cfg.numberOfChannels, sr = cfg.sampleRate, N = planes[0].length, F = 4096;
    let asc = null, failed = null;
    const e = new AudioEncoder({
      output: (chunk, meta) => {
        const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); frames.push(b);
        if (!asc && meta && meta.decoderConfig && meta.decoderConfig.description) asc = new Uint8Array(meta.decoderConfig.description.buffer || meta.decoderConfig.description).slice();
      },
      error: err => { failed = err },
    });
    e.configure(cfg);
    for (let i = 0; i < N; i += F) {
      const n = Math.min(F, N - i), data = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) data.set(planes[c].subarray(i, i + n), c * n);
      e.encode(new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(i / sr * 1e6), data }));
      while (e.encodeQueueSize > 24) await new Promise(r => setTimeout(r, 0));
      if (failed) throw failed;
      if (onProgress && (i / F) % 64 === 0) onProgress(i / N);
    }
    await e.flush(); e.close();
    if (failed) throw failed;
    if (!asc) { const si = SR_INDEX.indexOf(sr); asc = Uint8Array.of((2 << 3) | (si >> 1), ((si & 1) << 7) | (ch << 3)) }
    return { frames, asc, bitrate: cfg.bitrate };
  }

  // how much silence this device's encoder puts first: encode a click at a known spot and find it again
  const delayCache = new Map();
  async function encoderDelay(cfg) {
    const key = cfg.sampleRate + '/' + cfg.numberOfChannels;
    if (delayCache.has(key)) return delayCache.get(key);
    const sr = cfg.sampleRate, len = Math.round(sr * .4), at = 6000, planes = [];
    for (let c = 0; c < cfg.numberOfChannels; c++) { const p = new Float32Array(len); p[at] = .9; p[at + 1] = -.9; planes.push(p) }
    const out = await encode(planes, cfg);
    const bytes = mux({ ...out, sr, ch: cfg.numberOfChannels, length: out.frames.length * 1024, delay: 0 });
    const dec = await new OfflineAudioContext(1, 1, sr).decodeAudioData(bytes);
    const d = dec.getChannelData(0); let pk = 0, pos = 0;
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > pk) { pk = v; pos = i } }
    const delay = Math.max(0, pos - at);
    delayCache.set(key, delay);
    return delay;
  }

  // ---- 16-bit WAV fallback ----
  function wav16(planes, sr) {
    const ch = planes.length, n = planes[0].length, bytes = n * ch * 2, b = new ArrayBuffer(44 + bytes), v = new DataView(b);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, bytes, true);
    let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, planes[c][i])) * 32767, true);
    return b;
  }

  // does the stored file decode back to the same audio, lined up to the sample?
  function sameAudio(a, b) {
    if (Math.abs(a.length - b.length) > 2 || a.numberOfChannels !== b.numberOfChannels) return false;
    const x = a.getChannelData(0), y = b.getChannelData(0);
    let pk = 0; for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
    if (!pk) return true;
    const first = d => { for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > pk * .25) return i; return 0 };
    return Math.abs(first(x) - first(y)) <= Math.round(a.sampleRate * .001);
  }

  const worth = (file, bytes) => bytes.byteLength >= MIN_BYTES && (RAW.test(file.name || '') || /wav|aiff|flac|caf/i.test(file.type || ''));

  // raw: the file decoded by this page (decodeAudio). Returns {bytes, mime, raw, kind} or null to keep the original.
  async function compress(file, raw, bytes, onProgress) {
    const sr = raw.sampleRate, ch = Math.min(2, raw.numberOfChannels), planes = [];
    for (let c = 0; c < ch; c++) planes.push(raw.getChannelData(c));
    const cfg = await config(sr, ch);
    if (cfg) {
      try {
        const delay = await encoderDelay(cfg);
        const out = await encode(planes, cfg, onProgress);
        const m4a = mux({ ...out, sr, ch, length: raw.length, delay });
        const back = await decodeAudio(m4a);
        if (m4a.byteLength < bytes.byteLength && sameAudio(raw, back)) return { bytes: m4a, mime: 'audio/mp4', raw: back, kind: 'AAC' };
        console.warn('Compressed audio did not match the original; keeping WAV');
      } catch (e) { console.warn('AAC compression failed', e) }
    }
    const w = wav16(planes, sr);
    if (w.byteLength > bytes.byteLength * .85) return null;   // already 16-bit: nothing to gain
    const back = await decodeAudio(w);
    return { bytes: w, mime: 'audio/wav', raw: back, kind: '16-bit WAV' };
  }

  const mb = b => (b / 1048576 >= 10 ? Math.round(b / 1048576) : (b / 1048576).toFixed(1)) + ' MB';
  window.SKCompress = { worth, compress, mb };
})();
