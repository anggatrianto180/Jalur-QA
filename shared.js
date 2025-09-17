// Shared helper for small site: init firebase and fetchCollection
// Designed to be included after Firebase compat scripts are loaded.
(function(window){
  window.sharedHelpers = window.sharedHelpers || {};
  window.sharedHelpers.initFirebase = function(firebaseConfig){
    try { if (!window.firebase) { console.warn('Firebase not loaded yet'); return; } window.firebase.initializeApp(firebaseConfig); window.sharedHelpers.firestore = window.firebase.firestore(); window.sharedHelpers.auth = window.firebase.auth(); }
    catch(e){ console.warn('initFirebase failed', e); }
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

})(window);
