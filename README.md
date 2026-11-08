# SpeechCare — Direct OpenRouter AI (personal Android app)

SpeechCare uses a direct connection from the Android app to the OpenRouter Chat Completions API. Capacitor native HTTP is enabled for Android to avoid WebView CORS restrictions. **AI does not use Firebase Cloud Functions**, so you do not need Firebase Blaze or a Cloud Functions deployment for AI.

Firebase Authentication and Firestore remain in the app for sign-in and cloud sync. They are separate from the AI request path.

## OpenRouter setup inside the installed app

1. Create an API key at https://openrouter.ai/settings/keys.
2. Install the APK built from this project and open SpeechCare.
3. Sign in (or use the app's preview mode, if enabled).
4. Open Settings → AI.
5. Paste the OpenRouter API key.
6. Leave the model as `openrouter/free`, then choose **Save and test**.

SpeechCare permits only `openrouter/free` or model IDs ending in `:free` to help prevent accidental paid-model usage. OpenRouter free models are rate-limited and their availability can change. Check https://openrouter.ai/collections/free-models for current options.

## API key and privacy warning

- The key is entered on the device and stored in the app's local WebView storage (`localStorage`). It is not included in the source files, GitHub repository, or APK at build time.
- Because the key is stored on-device and the app calls OpenRouter directly, someone who can inspect the device/app data or reverse-engineer the APK may be able to retrieve it. Keep the APK and device private. Revoke the key if you suspect exposure.
- AI prompts are sent directly to OpenRouter. Do not send patient names, phone numbers, addresses, or other identifying information. Review and anonymize clinical details before using AI, and follow your applicable privacy obligations.
- Do not paste the API key into GitHub, source files, build logs, or ChatGPT.

## Build the Android APK with GitHub Actions

1. Upload/commit the contents of this `speechcare/` folder to your SpeechCare GitHub repository (the repository root should contain `package.json`, `capacitor.config.json`, `www/`, and `.github/`).
2. Push to the `main` branch, or open **Actions → Build SpeechCare APK (Direct OpenRouter) → Run workflow**.
3. Open the completed workflow run and download the **SpeechCare** artifact. It contains `SpeechCare.apk`.
4. Transfer the APK to your Android phone and install it. You may need to allow installation from that file manager/browser.

The workflow uses Node.js 20 and Java 17, creates the Capacitor Android project, applies the supplied SpeechCare icon assets, and builds a debug APK.

## Firebase notes

- Firebase Authentication and Firestore are still used for account sign-in and optional cloud sync. This project does not deploy or call Firebase Cloud Functions for AI.
- The existing Firebase web app configuration in `www/index.html` identifies the Firebase project; it is not an OpenRouter secret.
- `firestore.rules` is included for reference. Do not change or deploy rules unless you understand the effect on your existing data.

## App icon

`android-res/` contains only valid Android resource folders and launcher image sizes derived from the original SpeechCare logo supplied for this project. The original logo is preserved separately in `assets/SpeechCare_original_logo.png`; it is not copied into Android’s `res/` root.


## Updated navigation and AI experience

- Main navigation is in the bottom bar: Home, Sessions, Patients, and Reports. These items are not duplicated in the side menu. Profile appears at the top of the side menu.
- The floating **AI** button opens one persistent SpeechCare assistant panel. General questions work without selecting a patient; patient context is optional.
- The AI assistant connects directly to OpenRouter. Add the key in Settings → AI and keep the model set to `openrouter/free` (or another model ending in `:free`). Do not commit or share the key.
- The Android launcher icon (home screen + app drawer) is generated from `assets/SpeechCare_app_icon.png`, the Mebarki / SpeechCare logo supplied for this app. The build verifies the icon files and fails if they do not match. This is separate from the in-app login/launch logo (`www/logo.png`, `branding/splash.png`), which is unchanged.
- The in-app UX layer lives in `www/ux-layer.css` and `www/ux-layer.js` (48dp targets, press states, haptics, overlay pickers). New: Toys & materials inventory (side menu).
- The AI panel stays mounted while chat messages update to avoid restarting the panel animation and flickering.


## Arabic / Algerian Darija activity library

SpeechCare includes an original, locally bundled activity library in Arabic and Algerian Darija: target-sound practice, auditory contrast, syllable practice, object functions, following directions, sentence completion, story sequencing, open-ended WH-style scene questions, emotion discussion, social problem-solving, conversation prompts, and categorisation. The activities are original SpeechCare implementations using general speech-language-therapy activity concepts. No Konvoo artwork, audio, characters, proprietary game layouts, or site text is bundled. Activity completion counts are stored locally on the device; they are not a clinical assessment or a standalone measure of progress.

## Arabic keyboard on Android

SpeechCare adds Arabic locale hints and right-to-left input support for text fields, but the keyboard layout is controlled by Android/Gboard. On the phone, open Settings → System → Keyboard → On-screen keyboard → Gboard → Languages, add Arabic, French, and English, then switch with the globe key or by long-pressing the space bar. The Android build workflow sets `android:windowSoftInputMode=adjustResize` so the visible app area can resize around the keyboard.


## Arabic / Algerian Darija activity library

SpeechCare includes an original, locally bundled activity library in Arabic and Algerian Darija: target-sound practice, auditory contrast, syllable practice, object functions, following directions, sentence completion, story sequencing, open-ended WH-style scene questions, emotion discussion, social problem-solving, conversation prompts, and categorisation. The activities are original SpeechCare implementations using general speech-language-therapy activity concepts. No Konvoo artwork, audio, characters, proprietary game layouts, or site text is bundled. Activity completion counts are stored locally on the device; they are not a clinical assessment or a standalone measure of progress.

## Arabic keyboard on Android

SpeechCare adds Arabic locale hints and right-to-left input support for text fields, but the keyboard layout is controlled by Android/Gboard. On the phone, open Settings → System → Keyboard → On-screen keyboard → Gboard → Languages, add Arabic, French, and English, then switch with the globe key or by long-pressing the space bar. The Android build workflow sets `android:windowSoftInputMode=adjustResize` so the visible app area can resize around the keyboard.


## AI language and keyboard behavior

The AI chat supports Auto (respond in the language of the latest message), Arabic/Algerian Darija, and French. Use the language buttons in the AI panel to choose the response language. The floating AI button opens the chat with one tap; dragging is not used. The optional patient context is an in-app animated dropdown rather than a native Android select dialog.

Text fields intentionally do not force an HTML `lang` hint based on the app's display language, so Android/Gboard remains in control of keyboard-language selection. On Android, keyboard language switching is provided by Gboard or the installed keyboard app. If its language picker still closes immediately, update Gboard and Android System WebView/Chrome; there is a Chromium issue reported in recent Android builds where the Gboard language picker disappears in web input fields. This behavior cannot be completely fixed by application JavaScript alone.


### Important note about keyboard language picker

SpeechCare no longer assigns a fixed `lang` attribute to generic editable fields. This prevents the app's display language from nudging Android's input method to a single language. If Gboard's own language picker still disappears, the remaining behavior may be in the Android System WebView/Chromium input-method integration rather than the app: a related Chromium report describes the Gboard language picker closing in Android web input fields on recent Chrome builds. Update Gboard and Android System WebView from Google Play, then retest. Apps cannot directly control or force Gboard's active language.


## Cloud sync (Firebase) — how it works

- **Same cloud paths as before:** `users/{uid}/app/data` and `users/{uid}/app/toys` (plus a rolling safety copy at `users/{uid}/app/backup`). Photos live in Firebase Storage under `users/{uid}/toys/`; Firestore stores only each photo's URL and path.
- **Offline first:** every change is saved on the phone immediately and marked pending. The small pill at the bottom-left shows saving / saved / waiting / offline / error. "Saved to cloud" appears only after Firestore confirms the write. Pending changes survive closing the app and retry automatically (when the connection returns, when the app reopens, and every minute).
- **Two phones:** both phones listen to the cloud documents. Changes are merged record by record (patients, sessions, reports, appointments, workplaces, toys, settings), so edits made on both phones are combined and an old phone cannot overwrite newer cloud data. Deleting on one phone deletes on the other.
- **Never empty over data:** an empty phone never uploads over an existing cloud database, and a sudden empty state is restored from the cloud instead of wiping it.
- **AI key unchanged:** the OpenRouter key and model stay only in each phone's own storage. The sync code never reads, uploads or resets them.
- Tap the pill for details, **Sync now**, and **Test photo storage**.
- Tests: `node tests/sync-test.js` (simulated Firestore/Storage and two phones; also run by the GitHub workflow).

### One-time Firebase Console setup for photos
1. Firebase Console → project `oprthophoniste-organisation` → **Build → Storage → Get started** (production mode, choose a region).
2. **Storage → Rules** → paste the contents of `storage.rules` → **Publish**.
3. **Firestore → Rules**: the existing `firestore.rules` is already correct and unchanged (publish it only if it is not already what you have).
4. In the app, tap the sync pill → **Test photo storage**.
