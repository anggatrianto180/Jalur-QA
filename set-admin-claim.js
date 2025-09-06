// set-admin-claim.js
// Usage: node set-admin-claim.js <path-to-serviceAccountKey.json> <USER_UID>
// Example (PowerShell): node .\set-admin-claim.js .\serviceAccountKey.json 7bX...Z

const admin = require('firebase-admin');
const path = require('path');

const servicePath = process.argv[2];
const uid = process.argv[3];

if (!servicePath || !uid) {
  console.error('Usage: node set-admin-claim.js <path-to-serviceAccountKey.json> <USER_UID>');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = require(path.resolve(servicePath));
} catch (err) {
  console.error('Failed to load service account JSON:', err.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

admin.auth().setCustomUserClaims(uid, { admin: true })
  .then(() => {
    console.log('✅ Custom claim { admin: true } has been set for UID:', uid);
    console.log('The user should sign out and sign in again (or refresh their token) to see the claim in the client.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Failed to set custom claim:', err);
    process.exit(1);
  });
