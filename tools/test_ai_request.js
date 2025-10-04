const fetch = require('node-fetch');
(async () => {
  try {
    const body = {
      text: 'This document describes a user registration flow with email verification and file upload for profile picture. It also mentions an admin panel for role management and an API endpoint /api/users.'
    };
    const res = await fetch('http://localhost:4000/ai-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 60000
    });
    const text = await res.text();
    console.log('STATUS', res.status, res.statusText);
    try { console.log('JSON:', JSON.stringify(JSON.parse(text), null, 2)); }
    catch (e) { console.log('RAW:', text); }
  } catch (e) {
    console.error('Request failed:', e && e.message);
    process.exit(1);
  }
})();
