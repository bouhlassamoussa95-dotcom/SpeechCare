// Copies the Firebase compat bundles next to index.html so the app loads them from the APK.
const fs = require('fs'), path = require('path');
const out = path.join(__dirname, '..', 'www', 'vendor');
fs.mkdirSync(out, { recursive: true });
for (const f of ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js', 'firebase-storage-compat.js']) {
  fs.copyFileSync(path.join(__dirname, '..', 'node_modules', 'firebase', f), path.join(out, f));
}
console.log('Firebase bundles copied to www/vendor');
