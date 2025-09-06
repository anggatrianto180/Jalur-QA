Goal
Set a custom admin claim (admin=true) on a Firebase Authentication user so your client-side Firestore rules that check request.auth.token.admin == true will allow admin actions.

Prerequisites
- Node.js (>=12) and npm installed on your machine.
- Download a Firebase Service Account JSON from Firebase Console: Project Settings -> Service accounts -> Generate new private key. Save it as `serviceAccountKey.json` in the project folder.
- The target user's UID (you can find it in Firebase Console -> Authentication -> Users -> UID, or in browser console while logged in: `firebase.auth().currentUser.uid`).

Steps (PowerShell)
1) Open PowerShell and change to your project folder:

```powershell
cd 'h:\Pribadi\Web Software quality assurance'
```

2) Initialize (if you haven't) and install dependency:

```powershell
npm init -y
npm install firebase-admin
```

3) Place your downloaded `serviceAccountKey.json` in the folder (or note its path). Run the script to set admin claim:

```powershell
node .\set-admin-claim.js .\serviceAccountKey.json <USER_UID>
```

Replace `<USER_UID>` with the user's UID.

4) After the script succeeds, the client must refresh the token. In the browser (while logged in as that user) run in DevTools console:

```javascript
// force token refresh then reload
firebase.auth().currentUser.getIdToken(true).then(() => location.reload());
```

Or simply logout and login again.

Temporary testing alternative (unsafe for production)
If you want to test immediately without custom claims, you can temporarily relax Firestore rules to allow authenticated users to write to specific collections. Example (testing only):

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if true;
    }
    match /categories/{docId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
    match /learningPaths/{docId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
    match /comments/{docId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}
```

Remember to revert to stricter rules after testing.

Troubleshooting
- If the script fails to authenticate, ensure the service account JSON belongs to the same Firebase project.
- If `getIdToken(true)` doesn't show the claim immediately, logout & login again.
- Confirm the UID is correct.

If you want, I can:
- Add a small client-side helper that shows the current user's UID in the admin login page to make copying easier.
- Or run through the steps with you and verify the result.
