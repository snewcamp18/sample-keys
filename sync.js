/* Sample Keys cloud sync — Firebase Auth + Cloud Firestore, free (Spark) plan only.
 *
 * Firestore layout, all private to the signed-in person (see firestore.rules):
 *   users/{uid}/instruments/{id}          settings, pattern, artwork ref and sample list (no audio)
 *   users/{uid}/blobs/{sha256}            mime, size, chunk count — written last, so it marks a complete upload
 *   users/{uid}/blobs/{sha256}/chunks/{n} up to 700 KB of the file each (Firestore documents max out at 1 MiB)
 *
 * Audio is stored once per distinct file (content hash), so editing an instrument only rewrites its small
 * settings document. Conflicts resolve last-writer-wins on `updated`; deletions are kept as tombstones so
 * other devices learn about them.
 */
(() => {
  const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const CHUNK = 700 * 1024;
  const cfg = window.SK_FIREBASE_CONFIG;
  const SK = window.SK;
  const enc = new TextEncoder(), dec = new TextDecoder();

  let A = null, F = null, auth = null, fs = null, user = null, unsub = null;
  let state = 'loading', detail = '', queue = Promise.resolve(), sheetOpen = false, busyMsg = '';
  const pushTimers = new Map();
  let known = new Set();   // blob hashes already confirmed in the cloud

  const clean = o => JSON.parse(JSON.stringify(o ?? null));
  const knownKey = () => 'sk-blobs-' + (user ? user.uid : '');
  const loadKnown = () => { try { known = new Set(JSON.parse(localStorage.getItem(knownKey()) || '[]')) } catch (e) { known = new Set() } };
  const saveKnown = () => { try { localStorage.setItem(knownKey(), JSON.stringify([...known])) } catch (e) {} };

  function setState(s, d = '') { state = s; detail = d; SK.setSyncState(s); if (sheetOpen) render() }
  // one sync job at a time, so pulls and pushes never interleave
  function run(fn) {
    queue = queue.then(fn).catch(e => {
      console.error('Sample Keys sync:', e);
      setState(navigator.onLine ? 'error' : 'offline', e && e.message || String(e));
    });
    return queue;
  }

  /* ---------- paths ---------- */
  const U = () => ['users', user.uid];
  const instCol = () => F.collection(fs, ...U(), 'instruments');
  const instDoc = id => F.doc(fs, ...U(), 'instruments', id);
  const blobDoc = h => F.doc(fs, ...U(), 'blobs', h);
  const chunkDoc = (h, i) => F.doc(fs, ...U(), 'blobs', h, 'chunks', String(i).padStart(4, '0'));
  const chunkCol = h => F.collection(fs, ...U(), 'blobs', h, 'chunks');

  const shaMemo = new WeakMap();
  async function sha(buf) {
    if (shaMemo.has(buf)) return shaMemo.get(buf);
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    const h = [...d].map(b => b.toString(16).padStart(2, '0')).join('');
    shaMemo.set(buf, h);
    return h;
  }

  /* ---------- blobs ---------- */
  async function ensureBlob(h, buf, mime) {
    if (known.has(h)) return;
    const meta = await F.getDoc(blobDoc(h));
    if (!meta.exists()) {
      const u8 = new Uint8Array(buf), n = Math.max(1, Math.ceil(u8.length / CHUNK));
      for (let i = 0; i < n; i++) {
        busyMsg = n > 1 ? `Uploading sound (${i + 1}/${n})…` : 'Uploading sound…'; if (sheetOpen) render();
        await F.setDoc(chunkDoc(h, i), { d: F.Bytes.fromUint8Array(u8.slice(i * CHUNK, (i + 1) * CHUNK)) });
      }
      await F.setDoc(blobDoc(h), { mime: mime || '', size: u8.length, chunks: n });
    }
    known.add(h); saveKnown(); busyMsg = '';
  }
  async function fetchBlob(h) {
    const local = await SK.findBytes(h);
    if (local) return local;
    const meta = await F.getDoc(blobDoc(h));
    if (!meta.exists()) throw new Error('A sound for this instrument is still uploading from your other device.');
    const { size } = meta.data(), out = new Uint8Array(size);
    busyMsg = 'Downloading sound…'; if (sheetOpen) render();
    const snap = await F.getDocs(chunkCol(h)); // ids are zero-padded, so they come back in order
    let o = 0;
    for (const d of snap.docs) { const u = d.data().d.toUint8Array(); out.set(u, o); o += u.length }
    busyMsg = '';
    if (o !== size) throw new Error('A sound for this instrument is still uploading from your other device.');
    known.add(h); saveKnown();
    return out.buffer;
  }

  /* ---------- push / pull ---------- */
  async function push(id) {
    if (!user) return;
    const rec = await SK.getRecord(id);
    if (!rec) return;
    const hashes = [], list = [];
    for (const s of rec.samples || []) {
      const h = s.hash || await sha(s.bytes);
      hashes.push(h);
      await ensureBlob(h, s.bytes, s.mime);
      list.push({ name: s.name, mime: s.mime || '', root: s.root, color: s.color || '', p: clean(s.p), hash: h, size: s.bytes.byteLength });
    }
    let art = null;
    if (rec.art) { const b = enc.encode(rec.art).buffer; art = await sha(b); await ensureBlob(art, b, 'text/plain') }
    await F.setDoc(instDoc(id), {
      name: rec.name || 'Untitled Instrument', updated: rec.updated, deleted: false,
      settings: clean(rec.settings || {}), seq: clean(rec.seq), art, samples: list,
    });
    await SK.markPushed(id, rec.updated, hashes);
  }
  async function pull(id, r) {
    const samples = [], got = new Map();
    for (const m of r.samples || []) {
      if (!got.has(m.hash)) got.set(m.hash, await fetchBlob(m.hash));
      samples.push({ name: m.name, bytes: got.get(m.hash), mime: m.mime, root: m.root, color: m.color, p: m.p, hash: m.hash });
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

  /* ---------- lifecycle ---------- */
  async function start() {
    setState(navigator.onLine ? 'syncing' : 'offline');
    loadKnown();
    await SK.ready;
    let first = true;
    unsub = F.onSnapshot(instCol(), snap => {
      const changes = snap.docChanges().filter(c => c.type !== 'removed' && !c.doc.metadata.hasPendingWrites);
      const isFirst = first; first = false;
      run(async () => {
        setState('syncing');
        for (const c of changes) await reconcile(c.doc.id, c.doc.data());
        if (!navigator.onLine) { setState('offline'); return }
        if (isFirst) {
          // instruments made on this device before signing in, or while offline
          const remote = new Set(snap.docs.map(d => d.id));
          for (const ix of await SK.getIndex()) if (!remote.has(ix.id) || !ix.pushed) await push(ix.id);
        }
        setState('synced');
      });
    }, err => { console.error(err); setState('error', err.message) });
  }

  async function load() {
    if (!cfg) { setState('nosetup'); return }
    if (location.protocol === 'file:') { setState('nosetup', 'file'); return }
    setState(navigator.onLine ? 'loading' : 'offline');
    try {
      const [app, a, f] = await Promise.all(['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(n => import(FB + n)));
      A = a; F = f;
      const fbApp = app.initializeApp(cfg);
      auth = A.getAuth(fbApp); fs = F.getFirestore(fbApp);
      if (cfg.useEmulators) { // local testing only: Firebase's emulator suite on this computer
        A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
        F.connectFirestoreEmulator(fs, '127.0.0.1', 8080);
      }
      A.onAuthStateChanged(auth, u => {
        if (unsub) { unsub(); unsub = null }
        user = u;
        if (u) start(); else setState('signedout');
      });
    } catch (e) {
      console.warn('Sample Keys sync could not load', e);
      setState('offline');
      window.addEventListener('online', load, { once: true });
    }
  }
  window.addEventListener('online', () => { if (user) run(async () => { setState('syncing'); await pushUnsynced(); setState('synced') }) });
  window.addEventListener('offline', () => { if (user) setState('offline') });

  /* ---------- account sheet ---------- */
  const AUTH_ERRORS = {
    'auth/invalid-credential': "That email and password don't match an account.",
    'auth/wrong-password': "That email and password don't match an account.",
    'auth/user-not-found': "That email and password don't match an account.",
    'auth/invalid-email': 'Check the email address.',
    'auth/email-already-in-use': 'There is already an account with that email. Sign in instead.',
    'auth/weak-password': 'Use a password with at least 6 characters.',
    'auth/missing-password': 'Enter your password.',
    'auth/network-request-failed': "You're offline. Connect to the internet and try again.",
    'auth/popup-blocked': 'The Google window was blocked. Allow pop-ups, or use email and password.',
    'auth/operation-not-allowed': "This sign-in method isn't turned on in the app's Firebase project.",
    'auth/unauthorized-domain': "This web address isn't on the app's Firebase list of allowed domains.",
    'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
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
    } else {
      const label = { syncing: busyMsg || 'Syncing…', synced: 'Everything is synced.', offline: "You're offline. Changes sync when you reconnect.", error: "Sync hit a problem: " + esc(detail) }[state] || '';
      h = `<h3>Sync</h3>
        <p class="sub">Signed in as <b>${esc(user.email || user.displayName || 'you')}</b></p>
        <p class="sub stat ${state}">${label}</p>
        <div class="row"><button class="btn pri" id="skNow">Sync now</button><button class="btn" id="skOut">Sign out</button>${close}</div>`;
    }
    SK.openSheet(h, () => { sheetOpen = false });
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
    if ($('skNow')) $('skNow').onclick = () => run(async () => { setState('syncing'); await pushUnsynced(); setState('synced') });
    if ($('skOut')) $('skOut').onclick = async () => { await A.signOut(auth); SK.toast('Signed out. Your instruments stay on this device.') };
  }

  window.SKSync = {
    open: render,
    changed(id) {
      if (!user) return;
      clearTimeout(pushTimers.get(id));
      pushTimers.set(id, setTimeout(() => { pushTimers.delete(id); run(async () => { setState('syncing'); await push(id); setState('synced') }) }, 1500));
    },
    deleted(id) {
      if (!user) return;
      clearTimeout(pushTimers.get(id));
      run(() => F.setDoc(instDoc(id), { deleted: true, updated: Date.now(), name: '', samples: [] }));
    },
  };
  load();
})();
