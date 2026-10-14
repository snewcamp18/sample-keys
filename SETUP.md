# Setting up Sample Keys

Two one-time jobs: a Firebase project for sign-in sync, and GitHub Pages to put the app online.
Both are free. Sample Keys works without either; sync just stays off.

## 1. Firebase (cloud sync)

1. Go to <https://console.firebase.google.com>, sign in with your Google account, and click **Create a project**.
   Name it `sample-keys`. You can turn Google Analytics off.
2. **Turn on sign-in.** In the left menu open **Build → Authentication → Get started**. On the **Sign-in method** tab:
   - enable **Email/Password** and save;
   - enable **Google**, pick your email as the support email, and save.
3. **Create the database.** Open **Build → Firestore Database → Create database**. Pick the location closest to you,
   choose **Start in production mode**, and create it. Then open the **Rules** tab, replace everything with the
   contents of `firestore.rules` from this folder, and click **Publish**.
4. **Register the web app.** Click the gear icon → **Project settings**. Under **Your apps**, click the **`</>`** (Web)
   button, name it `Sample Keys`, leave Firebase Hosting unticked, and click **Register app**.
   Copy the `firebaseConfig = { … }` block it shows.
5. Open `firebase-config.js` and replace `null` with that block, so it reads
   `window.SK_FIREBASE_CONFIG = { apiKey: "…", authDomain: "…", projectId: "…", … };`
6. Once the app is online (step 3 below), go to **Authentication → Settings → Authorized domains → Add domain** and add
   your GitHub Pages address, e.g. `yourname.github.io`. Google sign-in only works on domains in that list.

The values in `firebase-config.js` identify your project; they aren't secret. What protects the data is
`firestore.rules`: each signed-in person can read and write only their own instruments, records must have the
shape the app writes, and each person can store at most 150 MB of sound (change `quota()` in the rules and
`quotaBytes` in `firebase-config.js` together to adjust it). Whenever `firestore.rules` changes, paste the new
version into **Firestore Database → Rules** and click **Publish**.

People can delete their own account and cloud data from **SYNC → Delete my account…**. As the project owner
you can still see everyone's synced data in the Firebase console.

**Free plan limits.** Firestore's free tier allows 1 GiB of storage, 50,000 reads and 20,000 writes per day. Everyone
who signs in to your copy of the app shares those limits. Each sound is stored once per account, however many
instruments use it, and editing an instrument only rewrites its small settings record. Sounds are stored in the
database rather than Firebase Storage because Storage now requires a billing account.

## 2. App Check (blocks requests that don't come from the app)

1. Create a reCAPTCHA key at <https://www.google.com/recaptcha/admin/create>: label `Sample Keys`, type
   **Score based (v3)**, domain `yourname.github.io`. Submit, then copy the **site key** and the **secret key**.
2. In Firebase, open **Security → App Check → Apps**, click your web app, choose **reCAPTCHA**, paste the
   **secret key** and save.
3. Put the **site key** in `firebase-config.js`: `window.SK_APPCHECK_SITE_KEY = "…";` and publish the update.
4. Open the app on its web address and sign in once. Then in **App Check → APIs**, check that Cloud Firestore
   shows verified requests, and click **Enforce** for **Cloud Firestore** and **Authentication**.

App Check is skipped on `localhost`, so local testing keeps working.

## 3. GitHub Pages (hosting)

1. Create a free account at <https://github.com> if you don't have one.
2. Create a new **public** repository named `sample-keys`.
3. Upload every file in this folder (keep the `icons` folder).
4. In the repository, open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**,
   pick `main` and `/ (root)`, and save.
5. After a minute the app is live at `https://yourname.github.io/sample-keys/`.

To publish an update, upload the changed files again. Installed copies pick up the new version the next time they
open with an internet connection.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The app |
| `sync.js` | Sign-in and cloud sync |
| `firebase-config.js` | Your Firebase project settings (`null` = sync off) |
| `firestore.rules` | Database security rules to paste into Firebase |
| `sw.js` | Offline support |
| `manifest.webmanifest`, `icons/` | What lets phones and computers install it as an app |
| `sampler.html` | Forwards old links and bookmarks to `index.html` |
