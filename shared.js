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

  // Attempt to resolve an image element's src using resolveImageUrl when the
  // current src fails to load. imgEl should be an <img> element.
  window.sharedHelpers.tryResolveAndSetImg = async function(imgEl){
    try {
      if (!imgEl) return;
      // inject spinner CSS once
      if (!window.sharedHelpers._spinnerCssInjected) {
        try {
          const style = document.createElement('style');
          style.textContent = `
            .shared-img-spinner{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:28px;height:28px;border:3px solid rgba(0,0,0,0.12);border-top-color:rgba(0,0,0,0.6);border-radius:50%;animation:shared-spin 1s linear infinite;z-index:50;pointer-events:none}
            @keyframes shared-spin{to{transform:rotate(360deg)}}
          `;
          document.head.appendChild(style);
        } catch (e) { /* ignore style injection failures */ }
        window.sharedHelpers._spinnerCssInjected = true;
      }
      const orig = imgEl.dataset && imgEl.dataset.orig ? imgEl.dataset.orig : (imgEl.getAttribute && imgEl.getAttribute('data-orig')) || imgEl.src || '';
      if (!orig) return;
      // ensure parent positioned so spinner can overlay
      const parent = imgEl.parentElement || imgEl.closest('div') || document.body;
      const prevPosition = parent.style && parent.style.position ? parent.style.position : '';
      if (!prevPosition || prevPosition === 'static') parent.style.position = 'relative';
      // avoid duplicate spinner
      let spinner = parent.querySelector && parent.querySelector('.shared-img-spinner');
      if (!spinner) {
        spinner = document.createElement('span'); spinner.className = 'shared-img-spinner';
        try { parent.appendChild(spinner); } catch(e){}
      }
      // attempt resolve
      let resolved = null;
      try {
        resolved = await window.sharedHelpers.resolveImageUrl(orig);
      } catch (e) { console.warn('resolveImageUrl failed inside tryResolveAndSetImg', e); }
      // if resolved and different, set and clear onerror to avoid loops
      if (resolved && resolved !== imgEl.src) {
        try { imgEl.onerror = null; } catch(e){}
        imgEl.src = resolved;
      } else {
        // annotate last resolve attempt for debugging
        try { imgEl.dataset.resolveInfo = JSON.stringify(window.sharedHelpers._lastResolveAttempt || {}); } catch(e){}
      }
      // cleanup spinner
      try { if (spinner && spinner.parentElement) spinner.parentElement.removeChild(spinner); } catch(e){}
      // if resolve failed, show small detail button overlay
      try {
        const info = window.sharedHelpers._lastResolveAttempt || {};
        if ((!resolved || resolved === imgEl.src) && (info && (info.error || info.fallback))) {
          // create detail button
          let btn = parent.querySelector && parent.querySelector('.shared-img-detail-btn');
          if (!btn) {
            btn = document.createElement('button'); btn.className = 'shared-img-detail-btn';
            btn.style.position = 'absolute'; btn.style.right = '6px'; btn.style.bottom = '6px'; btn.style.zIndex = '60'; btn.style.padding = '6px 8px'; btn.style.fontSize = '12px'; btn.style.borderRadius = '6px'; btn.style.background = 'rgba(0,0,0,0.6)'; btn.style.color = '#fff'; btn.textContent = 'Detail';
            parent.appendChild(btn);
            btn.addEventListener('click', (ev) => {
              ev.preventDefault();
              const json = JSON.stringify(window.sharedHelpers._lastResolveAttempt || {}, null, 2);
              const m = document.createElement('div'); m.className = 'modal-overlay'; m.innerHTML = `<div class="bg-white rounded-lg p-6 max-w-lg"><h3 class="text-lg font-bold mb-2">Resolve Info</h3><pre style="white-space:pre-wrap;max-height:60vh;overflow:auto">${json}</pre><div class="mt-4 text-right"><button id="close-resolve-info" class="bg-gray-200 px-3 py-1 rounded">Tutup</button></div></div>`;
              document.body.appendChild(m);
              document.getElementById('close-resolve-info').addEventListener('click', () => m.remove());
            });
          }
        }
      } catch (e) { console.warn('failed to show resolve detail button', e); }
      // restore parent position if we modified it
      try { if (prevPosition === '' || prevPosition === 'static') parent.style.position = prevPosition; } catch(e){}
    } catch (e) { console.warn('tryResolveAndSetImg failed', e); }
  };

  // Auto-scan images on page load and try to resolve any images that have
  // `data-orig` set (useful when src failed or is a storage path). Waits a
  // short time for firebase/storage initialization before attempting resolves.
  (function autoResolveImagesOnLoad(){
    const waitForStorage = async (timeoutMs = 3000) => {
      const start = Date.now();
      while (!(window.sharedHelpers && window.sharedHelpers.storage) && (Date.now() - start) < timeoutMs) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise(r => setTimeout(r, 200));
      }
    };

    const run = async () => {
      try {
        await waitForStorage(3000);
        const imgs = Array.from(document.querySelectorAll('img[data-orig]'));
        for (const img of imgs) {
          try {
            // attempt resolve regardless of current src so we normalise path -> url
            await window.sharedHelpers.tryResolveAndSetImg(img);
          } catch (e) {
            console.warn('autoResolveImagesOnLoad: failed to resolve', img, e);
          }
        }
      } catch (e) { console.warn('autoResolveImagesOnLoad runner failed', e); }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
  })();

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
      if (!storage) {
        window.sharedHelpers._lastResolveAttempt = { candidate, resolved: null, fallback: null, error: 'storage-not-initialized' };
        return s;
      }
      const url = await storage.ref().child(candidate).getDownloadURL();
      window.sharedHelpers._lastResolveAttempt = { candidate, resolved: url, fallback: null, error: null };
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
          window.sharedHelpers._lastResolveAttempt = { candidate, resolved: null, fallback, error: e && e.message };
          return fallback;
        }
      } catch (e2) {
        console.warn('resolveImageUrl fallback build failed', e2);
      }
      window.sharedHelpers._lastResolveAttempt = { candidate, resolved: null, fallback: null, error: e && e.message };
      console.warn('resolveImageUrl final fallback returning original src for', s, e);
      return s;
    }
  };

})(window);
