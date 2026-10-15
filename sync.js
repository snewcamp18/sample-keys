/* Sample Keys cloud sync — Firebase Auth + Cloud Firestore, free (Spark) plan only.
 *
 * Firestore layout, all private to the signed-in person (see firestore.rules):
 *   users/{uid}/instruments/{id}          settings, pattern, artwork ref and sample list (no audio)
 *   users/{uid}/blobs/{sha256}            file info; written first with done:false, set done:true once every chunk is up
 *   users/{uid}/blobs/{sha256}/chunks/{n} up to 700 KB of the file each (Firestore documents max out at 1 MiB)
 *   users/{uid}/meta/usage                bytes of sound stored; the rules make every chunk upload/delete update it
 *   users/{uid}/public/{sha256}           marks one of your files as readable through a share link
 *   shares/{random id}                    a snapshot of an instrument someone shared; readable by anyone with the link
 *
 * Audio is stored once per distinct file (content hash), so editing an instrument only rewrites its small
 * settings document. Conflicts resolve last-writer-wins on `updated`; deletions are kept as tombstones so
 * other devices learn about them. Files no live instrument uses are cleaned up after GC_MIN_AGE, which
 * leaves time for an upload in progress on another device to be claimed by its instrument.
 */
(() => {
  const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const CHUNK = 700 * 1024;
  const cfg = window.SK_FIREBASE_CONFIG;
  const SK = window.SK;
  const QUOTA = (cfg && cfg.quotaBytes) || 157286400;            // must match quota() in firestore.rules
  const GC_MIN_AGE = cfg && cfg.gcMinAgeMs != null ? cfg.gcMinAgeMs : 30 * 60 * 1000;
  const KNOWN_TTL = 20 * 60 * 1000;                              // re-check cached uploads well inside GC_MIN_AGE
  const enc = new TextEncoder(), dec = new TextDecoder();

  let A = null, F = null, auth = null, fs = null, user = null, unsub = null;
  let state = 'loading', detail = '', queue = Promise.resolve(), sheetOpen = false, busyMsg = '';
  let view = 'main', usageBytes = null, deleting = false;
  const pushTimers = new Map();
  const refused = new Map();  // instrument id -> version the cloud refused; not retried until it changes again
  let known = new Map();   // blob hash -> when it was last confirmed complete in the cloud

  class QuotaError extends Error {
    constructor() { super(`Your cloud storage is full (${mb(QUOTA)}). Remove sounds or instruments you don't need, then tap Sync now.`); this.quota = true }
  }
  const mb = b => (b / 1048576 >= 10 ? Math.round(b / 1048576) : (b / 1048576).toFixed(1)) + ' MB';
  const clean = o => JSON.parse(JSON.stringify(o ?? null));
  const knownKey = () => 'sk-blobs2-' + (user ? user.uid : '');
  const loadKnown = () => { try { known = new Map(JSON.parse(localStorage.getItem(knownKey()) || '[]')) } catch (e) { known = new Map() } };
  const saveKnown = () => { try { localStorage.setItem(knownKey(), JSON.stringify([...known])) } catch (e) {} };

  const ours = () => sheetOpen && !!document.querySelector('#sheet.show #sheetBox [data-owner="sync"]');
  function setState(s, d = '') { state = s; detail = d; SK.setSyncState(s); if (ours() && view === 'main') render() }
  // one sync job at a time, so pulls, pushes and clean-ups never interleave
  function run(fn) {
    queue = queue.then(fn).catch(e => {
      console.error('Sample Keys sync:', e);
      if (e && e.quota) SK.toast(e.message);
      setState(navigator.onLine ? 'error' : 'offline', e && e.message || String(e));
    });
    return queue;
  }

  /* ---------- paths ---------- */
  const U = () => ['users', user.uid];
  const instCol = () => F.collection(fs, ...U(), 'instruments');
  const instDoc = id => F.doc(fs, ...U(), 'instruments', id);
  const blobCol = () => F.collection(fs, ...U(), 'blobs');
  const blobDoc = (h, uid = user.uid) => F.doc(fs, 'users', uid, 'blobs', h);
  const chunkId = i => String(i).padStart(4, '0');
  const chunkDoc = (h, i) => F.doc(fs, ...U(), 'blobs', h, 'chunks', chunkId(i));
  const chunkCol = (h, uid = user.uid) => F.collection(fs, 'users', uid, 'blobs', h, 'chunks');
  const usageDoc = () => F.doc(fs, ...U(), 'meta', 'usage');
  const pubDoc = h => F.doc(fs, ...U(), 'public', h);
  const pubCol = () => F.collection(fs, ...U(), 'public');
  const shareCol = () => F.collection(fs, 'shares');
  const myShares = () => F.getDocs(F.query(shareCol(), F.where('owner', '==', user.uid)));
  const instHashes = r => [...(r.samples || []).map(s => s.hash), r.art].filter(Boolean);
  let fbReadyRes; const fbReady = new Promise(r => fbReadyRes = r);

  const shaMemo = new WeakMap();
  async function sha(buf) {
    if (shaMemo.has(buf)) return shaMemo.get(buf);
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    const h = [...d].map(b => b.toString(16).padStart(2, '0')).join('');
    shaMemo.set(buf, h);
    return h;
  }

  /* ---------- blobs ---------- */
  // each chunk is written in a transaction with the byte counter, as the rules require
  async function putChunk(h, i, part) {
    await F.runTransaction(fs, async tx => {
      const c = await tx.get(chunkDoc(h, i));
      if (c.exists()) return;                     // already uploaded (resumed or racing upload)
      const u = await tx.get(usageDoc()), before = u.exists() ? u.data().bytes : 0;
      if (before + part.length > QUOTA) throw new QuotaError();
      tx.set(chunkDoc(h, i), { d: F.Bytes.fromUint8Array(part) });
      tx.set(usageDoc(), { bytes: before + part.length, last: h + '/' + chunkId(i) });
      usageBytes = before + part.length;
    });
  }
  async function delChunk(h, i, len) {
    try {
      await F.runTransaction(fs, async tx => {
        const u = await tx.get(usageDoc());
        tx.delete(chunkDoc(h, i));
        if (u.exists()) { const b = u.data().bytes - len; tx.set(usageDoc(), { bytes: b, last: 'del:' + h + '/' + chunkId(i) }); usageBytes = b }
      });
    } catch (e) { if (!e || e.code !== 'permission-denied') throw e } // that chunk was never uploaded
  }
  async function ensureBlob(h, buf, mime) {
    const t = known.get(h);
    if (t && Date.now() - t < KNOWN_TTL) return;
    const ref = blobDoc(h), snap = await F.getDoc(ref);
    if (!snap.exists() || snap.data().done === false) {
      const u8 = new Uint8Array(buf), n = Math.max(1, Math.ceil(u8.length / CHUNK));
      if ((usageBytes ?? 0) + u8.length > QUOTA) { await readUsage(); if (usageBytes + u8.length > QUOTA) throw new QuotaError() }
      await F.setDoc(ref, { mime: mime || '', size: u8.length, chunks: n, part: CHUNK, created: Date.now(), done: false });
      for (let i = 0; i < n; i++) {
        busyMsg = n > 1 ? `Uploading sound (${i + 1}/${n})…` : 'Uploading sound…'; if (ours() && view === 'main') render();
        await putChunk(h, i, u8.subarray(i * CHUNK, (i + 1) * CHUNK));
      }
      await F.updateDoc(ref, { done: true });
    }
    known.set(h, Date.now()); saveKnown(); busyMsg = '';
  }
  async function deleteBlob(h, m) {
    const part = m.part || CHUNK, size = m.size || 0, n = m.chunks || 0;
    for (let i = 0; i < n; i++) await delChunk(h, i, Math.max(0, Math.min(part, size - i * part)));
    await F.deleteDoc(blobDoc(h));
    known.delete(h); saveKnown();
  }
  async function fetchBlob(h, owner) {
    const local = await SK.findBytes(h);
    if (local) return local;
    owner = owner || user.uid;
    const meta = await F.getDoc(blobDoc(h, owner));
    const still = 'A sound for this instrument is still uploading from your other device.';
    if (!meta.exists() || meta.data().done === false) throw new Error(still);
    const { size } = meta.data(), out = new Uint8Array(size);
    busyMsg = 'Downloading sound…'; if (ours() && view === 'main') render();
    const snap = await F.getDocs(chunkCol(h, owner)); // ids are zero-padded, so they come back in order
    let o = 0;
    for (const d of snap.docs) { const u = d.data().d.toUint8Array(); out.set(u, o); o += u.length }
    busyMsg = '';
    if (o !== size) throw new Error(still);
    if (user && owner === user.uid) { known.set(h, Date.now()); saveKnown() }
    return out.buffer;
  }
  // remove files that no live instrument uses any more (deleted instruments, removed samples)
  async function gc() {
    const live = new Set();
    (await F.getDocs(instCol())).forEach(d => { const r = d.data(); if (!r.deleted) instHashes(r).forEach(h => live.add(h)) });
    (await myShares()).forEach(d => instHashes(d.data().inst || {}).forEach(h => live.add(h)));
    for (const b of (await F.getDocs(blobCol())).docs) {
      const m = b.data();
      if (!live.has(b.id) && Date.now() - (m.created || 0) >= GC_MIN_AGE) await deleteBlob(b.id, m);
    }
  }
  async function readUsage() {
    const u = await F.getDoc(usageDoc());
    usageBytes = u.exists() ? u.data().bytes : 0;
    return usageBytes;
  }

  /* ---------- push / pull ---------- */
  async function push(id) {
    if (!user || deleting) return;
    const rec = await SK.getRecord(id);
    if (!rec) return;
    if (refused.get(id) === rec.updated) return;
    try { await pushRecord(id, rec); refused.delete(id) }
    catch (e) {
      if (e && e.code === 'permission-denied' && !e.quota) {
        refused.set(id, rec.updated);
        throw new Error(`"${rec.name}" couldn't be saved to the cloud. It may have too many sounds (the limit is 512).`);
      }
      throw e;
    }
  }
  async function pushRecord(id, rec) {
    const hashes = [], list = [];
    for (const s of rec.samples || []) {
      const h = s.hash || await sha(s.bytes);
      hashes.push(h);
      await ensureBlob(h, s.bytes, s.mime);
      list.push({ sid: s.sid || '', name: s.name, mime: s.mime || '', root: s.root, color: s.color || '', p: clean(s.p), hash: h, size: s.bytes.byteLength });
    }
    let art = null;
    if (rec.art) { const b = enc.encode(rec.art).buffer; art = await sha(b); await ensureBlob(art, b, 'text/plain') }
    await F.setDoc(instDoc(id), {
      name: (rec.name || 'Untitled Instrument').slice(0, 200), updated: rec.updated, deleted: false,
      settings: clean(rec.settings || {}), seq: clean(rec.seq), art, samples: list,
    });
    await SK.markPushed(id, rec.updated, hashes);
  }
  async function pull(id, r) {
    const samples = [], got = new Map();
    for (const m of r.samples || []) {
      if (!got.has(m.hash)) got.set(m.hash, await fetchBlob(m.hash));
      samples.push({ sid: m.sid, name: m.name, bytes: got.get(m.hash), mime: m.mime, root: m.root, color: m.color, p: m.p, hash: m.hash });
    }
    const art = r.art ? dec.decode(await fetchBlob(r.art)) : null;
    await SK.putRemote({ id, name: r.name, updated: r.updated, settings: r.settings || {}, seq: r.seq || null, art, samples });
  }
  async function reconcile(id, r) {
    const ix = (await SK.getIndex()).find(x => x.id === id);
    if (r.deleted) { if (ix && ix.updated <= r.updated) await SK.removeLocal(id); return }
    if (!ix || r.updated > ix.updated) await pull(id, r);
    else if (ix.updated > r.updated) await push(id);
  }
  async function pushUnsynced() {
    for (const ix of await SK.getIndex()) if (!ix.pushed) await push(ix.id);
  }
  const syncNow = () => run(async () => { setState('syncing'); await pushUnsynced(); await gc(); await readUsage(); setState('synced') });

  /* ---------- lifecycle ---------- */
  async function start() {
    setState(navigator.onLine ? 'syncing' : 'offline');
    loadKnown(); usageBytes = null; view = 'main';
    await SK.ready;
    let first = true;
    unsub = F.onSnapshot(instCol(), snap => {
      const changes = snap.docChanges().filter(c => c.type !== 'removed' && !c.doc.metadata.hasPendingWrites);
      const isFirst = first; first = false;
      run(async () => {
        if (deleting) return;
        setState('syncing');
        for (const c of changes) await reconcile(c.doc.id, c.doc.data());
        if (!navigator.onLine) { setState('offline'); return }
        if (isFirst) {
          // instruments made on this device before signing in, or while offline
          const remote = new Set(snap.docs.map(d => d.id));
          for (const ix of await SK.getIndex()) if (!remote.has(ix.id) || !ix.pushed) await push(ix.id);
          await gc(); await readUsage();
        }
        setState('synced');
      });
    }, err => { console.error(err); setState('error', err.message) });
  }

  async function load() {
    if (!cfg) { setState('nosetup'); fbReadyRes(); return }
    if (location.protocol === 'file:') { setState('nosetup', 'file'); fbReadyRes(); return }
    setState(navigator.onLine ? 'loading' : 'offline');
    try {
      const [app, a, f] = await Promise.all(['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(n => import(FB + n)));
      A = a; F = f;
      const fbApp = app.initializeApp(cfg);
      // App Check: proves requests come from this app on its real web address (see SETUP.md)
      const siteKey = window.SK_APPCHECK_SITE_KEY;
      if (siteKey && !cfg.useEmulators && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
        const ac = await import(FB + 'firebase-app-check.js');
        ac.initializeAppCheck(fbApp, { provider: new ac.ReCaptchaEnterpriseProvider(siteKey), isTokenAutoRefreshEnabled: true });
      }
      auth = A.getAuth(fbApp); fs = F.getFirestore(fbApp);
      if (cfg.useEmulators) { // local testing only: Firebase's emulator suite on this computer
        A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
        F.connectFirestoreEmulator(fs, '127.0.0.1', 8080);
      }
      fbReadyRes();
      A.onAuthStateChanged(auth, u => {
        if (unsub) { unsub(); unsub = null }
        user = u;
        if (u) start(); else { view = 'main'; setState('signedout') }
      });
    } catch (e) {
      console.warn('Sample Keys sync could not load', e);
      setState('offline');
      window.addEventListener('online', load, { once: true });
    }
  }
  window.addEventListener('online', () => { if (user && !deleting) run(async () => { setState('syncing'); await pushUnsynced(); setState('synced') }) });
  window.addEventListener('offline', () => { if (user) setState('offline') });

  /* ---------- deleting an account ---------- */
  async function deleteAccount(password, alsoLocal, progress) {
    const providers = user.providerData.map(p => p.providerId);
    if (providers.includes('password')) await A.reauthenticateWithCredential(user, A.EmailAuthProvider.credential(user.email, password));
    else if (providers.includes('google.com')) await A.reauthenticateWithPopup(user, new A.GoogleAuthProvider());
    deleting = true;
    pushTimers.forEach(t => clearTimeout(t)); pushTimers.clear();
    if (unsub) { unsub(); unsub = null }
    await queue;
    try {
      progress('Turning off share links…');
      for (const d of (await myShares()).docs) await F.deleteDoc(d.ref);
      for (const d of (await F.getDocs(pubCol())).docs) await F.deleteDoc(d.ref);
      progress('Deleting instruments…');
      for (const d of (await F.getDocs(instCol())).docs) await F.deleteDoc(d.ref);
      const blobs = (await F.getDocs(blobCol())).docs;
      for (let k = 0; k < blobs.length; k++) { progress(`Deleting sounds (${k + 1} of ${blobs.length})…`); await deleteBlob(blobs[k].id, blobs[k].data()) }
      try { await F.deleteDoc(usageDoc()) } catch (e) { console.warn('usage record left behind', e) }
      try { localStorage.removeItem(knownKey()) } catch (e) {}
      if (alsoLocal) await SK.clearLocal();
      progress('Deleting your account…');
      await A.deleteUser(user);
    } finally { deleting = false }
  }

  /* ---------- account sheet ---------- */
  const AUTH_ERRORS = {
    'auth/invalid-credential': "That email and password don't match an account.",
    'auth/wrong-password': "That email and password don't match an account.",
    'auth/user-not-found': "That email and password don't match an account.",
    'auth/user-mismatch': 'That Google account is a different one from the one signed in.',
    'auth/invalid-email': 'Check the email address.',
    'auth/email-already-in-use': 'There is already an account with that email. Sign in instead.',
    'auth/weak-password': 'Use a password with at least 6 characters.',
    'auth/missing-password': 'Enter your password.',
    'auth/network-request-failed': "You're offline. Connect to the internet and try again.",
    'auth/popup-blocked': 'The Google window was blocked. Allow pop-ups, or use email and password.',
    'auth/operation-not-allowed': "This sign-in method isn't turned on in the app's Firebase project.",
    'auth/unauthorized-domain': "This web address isn't on the app's Firebase list of allowed domains.",
    'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
    'auth/requires-recent-login': 'For your security, sign out and back in, then try again.',
  };
  const authMsg = e => AUTH_ERRORS[e && e.code] || (e && e.message) || 'Something went wrong.';

  function render() {
    const esc = SK.esc, close = '<button class="btn" data-close>Close</button>';
    let h;
    if (state === 'nosetup') {
      h = detail === 'file'
        ? `<h3>Sync</h3><p class="sub">This copy is a file on your computer, so it can't sign in. Open Sample Keys from its web address to sync.</p><div class="row">${close}</div>`
        : `<h3>Sync isn't set up</h3><p class="sub">This copy of Sample Keys doesn't have a cloud project yet. Its owner adds one in <code>firebase-config.js</code>; see SETUP.md.</p><div class="row">${close}</div>`;
    } else if (state === 'loading' || (!auth && state === 'offline')) {
      h = `<h3>Sync</h3><p class="sub">${state === 'offline' ? "You're offline. Sync starts when you reconnect; everything keeps working on this device meanwhile." : 'Connecting…'}</p><div class="row">${close}</div>`;
    } else if (!user) {
      h = `<h3>Sign in to sync</h3>
        <p class="sub">Your instruments, sounds and patterns will stay in step on every device you sign in on.</p>
        <button class="btn gbtn" id="skG">Continue with Google</button>
        <div class="or">or use email</div>
        <input class="tx" id="skEmail" type="email" placeholder="Email" autocomplete="email" inputmode="email">
        <input class="tx" id="skPass" type="password" placeholder="Password (6+ characters)" autocomplete="current-password">
        <div class="row"><button class="btn pri" id="skIn">Sign in</button><button class="btn" id="skUp">Create account</button></div>
        <p class="err" id="skErr"></p>
        <div class="row between"><button class="link" id="skReset">Forgot password?</button>${close}</div>`;
    } else if (view === 'delete') {
      const pw = user.providerData.some(p => p.providerId === 'password');
      h = `<h3>Delete your account?</h3>
        <p class="sub">This permanently deletes your Sample Keys account and every instrument and sound stored in the cloud for <b>${esc(user.email || 'this account')}</b>. It can't be undone.</p>
        ${pw ? '<input class="tx" id="skDelPass" type="password" placeholder="Enter your password to confirm" autocomplete="current-password">' : '<p class="sub">You\'ll be asked to confirm with Google.</p>'}
        <label class="chk"><input type="checkbox" id="skDelLocal"> Also remove my instruments from this device</label>
        <p class="err" id="skErr"></p>
        <div class="row"><button class="btn" id="skBack">Cancel</button><button class="btn danger" id="skDelGo">Delete account</button></div>`;
    } else if (view === 'deleting') {
      h = `<h3>Deleting your account</h3><p class="sub" id="skDelMsg">Starting…</p><div class="ambar"><i style="width:100%" class="busy"></i></div>`;
    } else {
      const label = { syncing: busyMsg || 'Syncing…', synced: 'Everything is synced.', offline: "You're offline. Changes sync when you reconnect.", error: 'Sync hit a problem: ' + esc(detail) }[state] || '';
      const used = usageBytes == null ? null : Math.min(1, usageBytes / QUOTA);
      h = `<h3>Sync</h3>
        <p class="sub">Signed in as <b>${esc(user.email || user.displayName || 'you')}</b></p>
        <p class="sub stat ${state}">${label}</p>
        <div class="meter"><div class="meterlbl"><span>Cloud storage</span><span>${usageBytes == null ? '…' : `${mb(usageBytes)} of ${mb(QUOTA)}`}</span></div>
          <div class="ambar"><i style="width:${used == null ? 0 : Math.max(used > 0 ? 1 : 0, used * 100)}%" class="${used > .9 ? 'full' : ''}"></i></div></div>
        <div class="row"><button class="btn pri" id="skNow">Sync now</button><button class="btn" id="skOut">Sign out</button>${close}</div>
        <div class="row between"><button class="link danger" id="skDel">Delete my account…</button></div>`;
      if (usageBytes == null && state !== 'offline') readUsage().then(() => { if (ours() && view === 'main') render() }).catch(() => {});
    }
    SK.openSheet(`<div data-owner="sync">${h}</div>`, () => { sheetOpen = false; if (view === 'delete') view = 'main' });
    sheetOpen = true;
    wire();
  }
  function wire() {
    const $ = id => document.getElementById(id), err = m => { const e = $('skErr'); if (e) e.textContent = m };
    const creds = () => [$('skEmail').value.trim(), $('skPass').value];
    const guard = async (fn) => { err(''); try { await fn() } catch (e) { if (e && e.code === 'auth/popup-closed-by-user') return; err(authMsg(e)) } };
    if ($('skG')) $('skG').onclick = () => guard(() => A.signInWithPopup(auth, new A.GoogleAuthProvider()));
    if ($('skIn')) $('skIn').onclick = () => guard(() => A.signInWithEmailAndPassword(auth, ...creds()));
    if ($('skUp')) $('skUp').onclick = () => guard(() => A.createUserWithEmailAndPassword(auth, ...creds()));
    if ($('skPass')) $('skPass').onkeydown = e => { if (e.key === 'Enter') $('skIn').click() };
    if ($('skReset')) $('skReset').onclick = () => guard(async () => {
      const em = $('skEmail').value.trim(); if (!em) { err('Enter your email first.'); return }
      await A.sendPasswordResetEmail(auth, em); err(''); SK.toast('Password reset email sent to ' + em);
    });
    if ($('skNow')) $('skNow').onclick = syncNow;
    if ($('skOut')) $('skOut').onclick = async () => { await A.signOut(auth); SK.toast('Signed out. Your instruments stay on this device.') };
    if ($('skDel')) $('skDel').onclick = () => { view = 'delete'; render() };
    if ($('skBack')) $('skBack').onclick = () => { view = 'main'; render() };
    if ($('skDelGo')) $('skDelGo').onclick = async () => {
      const pass = $('skDelPass') ? $('skDelPass').value : '', alsoLocal = $('skDelLocal').checked;
      if ($('skDelPass') && !pass) { err('Enter your password to confirm.'); return }
      $('skDelGo').disabled = true; err('');
      try {
        await deleteAccount(pass, alsoLocal, msg => { if (view !== 'deleting') { view = 'deleting'; render() } const m = $('skDelMsg'); if (m) m.textContent = msg });
        view = 'main'; SK.closeSheet();
        SK.toast(alsoLocal ? 'Your account and all your data are deleted.' : 'Your account and cloud data are deleted. Your instruments are still on this device.');
      } catch (e) {
        console.error(e);
        if (view === 'deleting') { view = 'delete'; render() }
        if (e && e.code === 'auth/popup-closed-by-user') return;
        err(authMsg(e)); const b = $('skDelGo'); if (b) b.disabled = false;
      }
    };
  }

  /* ---------- sharing ---------- */
  const appUrl = () => location.origin + location.pathname.replace(/index\.html$/, '');
  const sharer = () => (user.displayName || (user.email || '').split('@')[0] || 'Someone').slice(0, 60);
  const shareSheet = (h, wide) => { sheetOpen = false; SK.openSheet(`<div data-owner="share">${h}</div>`, null, wide) };
  const closeBtn = '<button class="btn" data-close>Close</button>';
  const sizeOf = inst => { const seen = new Map(); (inst.samples || []).forEach(s => seen.set(s.hash, s.size || 0)); return [...seen.values()].reduce((a, b) => a + b, 0) };

  async function shareFor(id) { return (await F.getDocs(F.query(shareCol(), F.where('owner', '==', user.uid), F.where('instId', '==', id)))).docs[0] || null }
  async function publish(id) {
    await SK.flush();
    let err = null;
    await run(async () => { setState('syncing'); try { await push(id) } catch (e) { err = e } setState(err ? 'error' : 'synced', err ? err.message : '') });
    if (err) throw err;
    const snap = await F.getDoc(instDoc(id));
    if (!snap.exists() || snap.data().deleted) throw new Error("This instrument hasn't synced yet. Check SYNC, then try again.");
    const inst = snap.data();
    for (const h of instHashes(inst)) await F.setDoc(pubDoc(h), { at: Date.now() });
    const old = await shareFor(id), ref = old ? old.ref : F.doc(shareCol());
    await F.setDoc(ref, { owner: user.uid, instId: id, by: sharer(), name: inst.name, updated: Date.now(), inst });
    return { link: appUrl() + '#share=' + ref.id, inst };
  }
  async function unpublish(id) {
    const old = await shareFor(id);
    if (old) await F.deleteDoc(old.ref);
    const keep = new Set();
    (await myShares()).forEach(d => instHashes(d.data().inst || {}).forEach(h => keep.add(h)));
    for (const m of (await F.getDocs(pubCol())).docs) if (!keep.has(m.id)) await F.deleteDoc(m.ref);
  }
  const noCloud = () => shareSheet(`<h3>Sharing</h3><p class="sub">Sharing works in the online app. Open Sample Keys from its web address and try again.</p><div class="row">${closeBtn}</div>`);
  async function share(id) {
    await fbReady;
    if (!fs) { noCloud(); return }
    if (!user) {
      shareSheet(`<h3>Share an instrument</h3><p class="sub">Sign in first. Sharing puts a copy of this instrument where family and friends can add it to their own Sample Keys.</p>
        <div class="row">${closeBtn}<button class="btn pri" id="shSignIn">Sign in</button></div>`);
      document.getElementById('shSignIn').onclick = () => { view = 'main'; render() };
      return;
    }
    if (!navigator.onLine) { shareSheet(`<h3>Share an instrument</h3><p class="sub">You're offline. Connect to the internet to share.</p><div class="row">${closeBtn}</div>`); return }
    shareSheet(`<h3>Share an instrument</h3><p class="sub">Preparing a link… uploading any sounds that haven't synced yet.</p><div class="ambar"><i style="width:100%" class="busy"></i></div>`);
    try {
      const { link, inst } = await publish(id);
      const mb = (sizeOf(inst) / 1048576).toFixed(1), n = (inst.samples || []).length;
      shareSheet(`<h3>Share “${SK.esc(inst.name)}”</h3>
        <p class="sub">Anyone with this link can add a copy (${n} sound${n === 1 ? '' : 's'}, ${mb} MB) to their own Sample Keys. They get the instrument as it is now; to send later changes, share it again and the same link updates.</p>
        <input class="tx" id="shLink" readonly value="${SK.esc(link)}">
        <div class="row"><button class="btn pri" id="shCopy">Copy link</button>${navigator.share ? '<button class="btn" id="shSend">Send…</button>' : ''}</div>
        <p class="hint" style="margin:10px 0 0">On iPhone, links open in Safari. If they use the home-screen app, they can paste the link into <b>FILE → Add a shared instrument</b> there instead.</p>
        <div class="row between"><button class="link danger" id="shStop">Stop sharing</button>${closeBtn}</div>`);
      const $ = i => document.getElementById(i);
      $('shLink').onfocus = e => e.target.select();
      $('shCopy').onclick = async () => { try { await navigator.clipboard.writeText(link); SK.toast('Link copied') } catch (e) { $('shLink').focus() } };
      if ($('shSend')) $('shSend').onclick = () => navigator.share({ title: inst.name + ' · Sample Keys', text: `Here's my "${inst.name}" instrument for Sample Keys:`, url: link }).catch(() => {});
      $('shStop').onclick = async () => {
        $('shStop').disabled = true;
        try { await unpublish(id); SK.closeSheet(); SK.toast('Sharing turned off. The link no longer works.') }
        catch (e) { console.error(e); SK.toast("Couldn't turn off sharing: " + e.message); $('shStop').disabled = false }
      };
    } catch (e) {
      console.error(e);
      shareSheet(`<h3>Share an instrument</h3><p class="err">${SK.esc(e.message || String(e))}</p><div class="row">${closeBtn}</div>`);
    }
  }
  function addShared() {
    shareSheet(`<h3>Add a shared instrument</h3><p class="sub">Paste the link someone sent you.</p>
      <input class="tx" id="shPaste" placeholder="https://…#share=…" autocomplete="off" inputmode="url">
      <p class="err" id="shErr"></p>
      <div class="row">${closeBtn}<button class="btn pri" id="shOpen">Continue</button></div>`);
    const go = () => {
      const m = document.getElementById('shPaste').value.match(/share=([A-Za-z0-9]{8,40})/);
      if (!m) { document.getElementById('shErr').textContent = "That doesn't look like a Sample Keys share link."; return }
      openShare(m[1]);
    };
    document.getElementById('shOpen').onclick = go;
    document.getElementById('shPaste').onkeydown = e => { if (e.key === 'Enter') go() };
  }
  async function openShare(sid) {
    if (!navigator.onLine) { shareSheet(`<h3>Shared instrument</h3><p class="sub">You're offline. Connect to the internet, then open the link again.</p><div class="row">${closeBtn}</div>`); return }
    shareSheet(`<h3>Shared instrument</h3><p class="sub">Looking it up…</p>`);
    try {
      await fbReady;
      if (!fs) { noCloud(); return }
      const snap = await F.getDoc(F.doc(fs, 'shares', sid));
      if (!snap.exists()) throw new Error('This link was turned off, or it was copied incompletely.');
      const { owner, by, inst } = snap.data(), n = (inst.samples || []).length, mb = (sizeOf(inst) / 1048576).toFixed(1);
      shareSheet(`<h3>${SK.esc(inst.name)}</h3>
        <p class="sub">Shared by <b>${SK.esc(by || 'someone')}</b> · ${n} sound${n === 1 ? '' : 's'} · ${mb} MB</p>
        <p class="sub">${user ? 'It will be added to your instruments and synced to your devices.' : 'It will be added to this device. Sign in with SYNC to have it on your other devices too.'}</p>
        <div class="row">${closeBtn}<button class="btn pri" id="shAdd">Add to my instruments</button></div>`);
      document.getElementById('shAdd').onclick = async () => {
        try {
          const got = new Map(), list = [], uniq = [...new Set((inst.samples || []).map(s => s.hash))];
          for (let i = 0; i < uniq.length; i++) {
            shareSheet(`<h3>${SK.esc(inst.name)}</h3><p class="sub">Downloading sounds (${i + 1} of ${uniq.length})…</p><div class="ambar"><i style="width:${Math.round(100 * i / uniq.length)}%"></i></div>`);
            got.set(uniq[i], await fetchBlob(uniq[i], owner));
          }
          for (const m of inst.samples || []) list.push({ sid: m.sid, name: m.name, bytes: got.get(m.hash), mime: m.mime, root: m.root, color: m.color, p: m.p, hash: m.hash });
          const art = inst.art ? dec.decode(await fetchBlob(inst.art, owner)) : null;
          const id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
          await SK.importRecord({ id, name: inst.name, updated: Date.now(), settings: inst.settings || {}, seq: inst.seq || null, art, samples: list });
          SK.closeSheet(); SK.toast(`Added "${inst.name}"`);
        } catch (e) { console.error(e); shareSheet(`<h3>${SK.esc(inst.name)}</h3><p class="err">Couldn't download it: ${SK.esc(e.message || String(e))}</p><div class="row">${closeBtn}</div>`) }
      };
    } catch (e) {
      console.error(e);
      shareSheet(`<h3>Shared instrument</h3><p class="err">${SK.esc(e.message || String(e))}</p><div class="row">${closeBtn}</div>`);
    }
  }

  window.SKSync = {
    open() { view = 'main'; render() },
    share, addShared, openShare,
    changed(id) {
      if (!user || deleting) return;
      clearTimeout(pushTimers.get(id));
      pushTimers.set(id, setTimeout(() => { pushTimers.delete(id); run(async () => { setState('syncing'); await push(id); setState('synced') }) }, 1500));
    },
    deleted(id) {
      if (!user || deleting) return;
      clearTimeout(pushTimers.get(id));
      run(async () => { await F.setDoc(instDoc(id), { deleted: true, updated: Date.now(), name: '', samples: [] }); await gc(); await readUsage() });
    },
  };
  load();
})();
