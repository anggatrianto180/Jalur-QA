// Shared helper for small site: init firebase and fetchCollection
// Designed to be included after Firebase compat scripts are loaded.
(function(window){
  window.sharedHelpers = window.sharedHelpers || {};

  window.sharedHelpers.initFirebase = function(firebaseConfig){
    try {
      if (!window.firebase) { console.warn('Firebase not loaded yet'); return; }
      // keep a copy of config for helpers
      window.sharedHelpers.firebaseConfig = firebaseConfig || window.sharedHelpers.firebaseConfig || {};
      window.firebase.initializeApp(firebaseConfig);
      window.sharedHelpers.firestore = window.firebase.firestore();
      window.sharedHelpers.auth = window.firebase.auth();
      try {
        if (window.firebase.storage) window.sharedHelpers.storage = window.firebase.storage();
      } catch (e) { console.warn('Firebase storage init failed', e); }
    } catch(e){
      console.warn('initFirebase failed', e);
    }
  };

  window.sharedHelpers.fetchCollection = async function(collectionName, options = {}){
    try{
      let q = window.sharedHelpers.firestore.collection(collectionName);
      if (options.orderBy) q = q.orderBy(options.orderBy, options.direction || 'asc');
      const snap = await q.get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch(e){
      console.warn('shared fetchCollection fallback', collectionName, e);
      const snap = await window.sharedHelpers.firestore.collection(collectionName).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
  };

  // Firebase Storage helpers (compat SDK)
  window.sharedHelpers.uploadFileToStorage = async function(file, destPath){
    if (!file) throw new Error('No file provided');
    // prefer stored reference to firebase.storage() if initFirebase set it
    const storage = window.sharedHelpers.storage || (window.firebase && window.firebase.storage && window.firebase.storage());
    if (!storage) throw new Error('Firebase Storage not initialized');
    const storageRef = storage.ref().child(destPath);
    const uploadTask = storageRef.put(file);
    // wait for completion and log progress
    await new Promise((resolve, reject) => {
      uploadTask.on('state_changed',
        (snapshot) => {
          const pct = ((snapshot.bytesTransferred / snapshot.totalBytes) * 100).toFixed(1);
          console.debug('Storage upload progress:', pct + '%', snapshot);
        },
        (err) => {
          console.error('Storage upload error:', err);
          reject(err);
        },
        () => resolve()
      );
    });
    const url = await storageRef.getDownloadURL();
    console.debug('Storage upload complete, downloadURL=', url);
    return url;
  };

  window.sharedHelpers.getStorageDownloadUrl = async function(path){
    const storage = window.sharedHelpers.storage || (window.firebase && window.firebase.storage && window.firebase.storage());
    if (!storage) throw new Error('Firebase Storage not initialized');
    return await storage.ref().child(path).getDownloadURL();
  };

  // Delete a file from Firebase Storage. Accepts either a storage path like 'images/..'
  // or a full download URL and will attempt to resolve to a reference.
  window.sharedHelpers.deleteFileFromStorage = async function(pathOrUrl){
    if (!pathOrUrl) throw new Error('No path or URL provided');
    const s = String(pathOrUrl).trim();
    const storage = window.sharedHelpers.storage || (window.firebase && window.firebase.storage && window.firebase.storage());
    if (!storage) throw new Error('Firebase Storage not initialized');
    // if it's a full URL from getDownloadURL, try to extract object path
    try {
      let candidate = s;
      if (/^https?:\/\//i.test(s)) {
        // try to parse firebase storage download URL pattern
        const m = s.match(/\/o\/([^?]+)/);
        if (m && m[1]) candidate = decodeURIComponent(m[1]);
        else {
          // fallback: if it's not a googleapis URL, throw to let caller handle
          candidate = null;
        }
      }
      if (!candidate) throw new Error('Unable to resolve storage path from URL');
      const ref = storage.ref().child(candidate.replace(/^\//, ''));
      await ref.delete();
      console.debug('Deleted storage object', candidate);
      return true;
    } catch (e) {
      console.error('deleteFileFromStorage failed for', pathOrUrl, e);
      throw e;
    }
  };

  // Resolve an image value that might be a Storage path (e.g. 'images/..') or a full URL.
  // Returns a URL string that can be used directly in <img src="...">.
  window.sharedHelpers.resolveImageUrl = async function(src) {
    if (!src) return '';
    const s = String(src).trim();
    // already a web URL -> return as-is
    if (/^https?:\/\//i.test(s) || /^data:/i.test(s)) return s;
    // common case: stored storage path like 'images/xxx.png' or '/images/xxx.png'
    const candidate = s.replace(/^\//, '');
    try {
      const storage = window.sharedHelpers.storage || (window.firebase && window.firebase.storage && window.firebase.storage());
      if (!storage) return s;
      const url = await storage.ref().child(candidate).getDownloadURL();
      return url || s;
    } catch (e) {
      // If getDownloadURL failed (permissions or other), try a best-effort
      // public "alt=media" URL for Firebase Storage. This only works if
      // the object is publicly readable, but helps when token-based access
      // is not available.
      try {
        console.warn('resolveImageUrl getDownloadURL failed, trying alt=media fallback for', s, e && e.message);
        const cfg = window.sharedHelpers.firebaseConfig || (window.firebase && window.firebase.app && window.firebase.app().options) || {};
        const bucket = (cfg && (cfg.storageBucket || cfg.bucket)) || '';
        if (bucket) {
          const encoded = encodeURIComponent(candidate);
          const fallback = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encoded}?alt=media`;
          return fallback;
        }
      } catch (e2) {
        console.warn('resolveImageUrl fallback build failed', e2);
      }
      console.warn('resolveImageUrl final fallback returning original src for', s, e);
      return s;
    }
  };

})(window);
