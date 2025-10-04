const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { exec } = require('child_process');
// file parsing libraries
let pdfParse = null;
let mammoth = null;
try { pdfParse = require('pdf-parse'); } catch (e) { console.warn('pdf-parse not installed, PDF parsing disabled'); }
try { mammoth = require('mammoth'); } catch (e) { console.warn('mammoth not installed, DOCX parsing disabled'); }
// Ensure fetch is available in Node runtimes that don't provide global fetch
if (typeof fetch === 'undefined') {
  try {
    // node-fetch v2 is CommonJS-friendly
    const nf = require('node-fetch');
    global.fetch = nf;
    console.log('node-fetch polyfill installed as global.fetch');
  } catch (e) {
    console.warn('node-fetch not installed; external AI calls may not work in this Node version');
  }
}

const PORT = process.env.PORT || 4000;
const ENABLE_GIT_COMMIT = process.env.ENABLE_GIT_COMMIT === '1';
const GIT_COMMIT_MESSAGE = process.env.GIT_COMMIT_MESSAGE || 'Add uploaded image';

const imagesDir = path.join(process.cwd(), 'images');
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, imagesDir); },
  filename: function (req, file, cb) {
    const safe = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safe);
  }
});

const upload = multer({ storage });
const app = express();
app.use(cors());
app.use(express.json());

// ensure uploads dir exists for AI endpoint
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// serve images statically
app.use('/images', express.static(imagesDir));

// serve project static files (so index.html can be opened via http://localhost:PORT)
app.use(express.static(process.cwd()));

app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const relPath = `/images/${req.file.filename}`;
  // Optionally commit to git if enabled
  if (ENABLE_GIT_COMMIT) {
    // stage and commit the file
    exec(`git add "${path.join('images', req.file.filename)}" && git commit -m "${GIT_COMMIT_MESSAGE}: ${req.file.filename}"`, { cwd: process.cwd() }, (err, stdout, stderr) => {
      if (err) {
        console.warn('Git commit failed:', err && err.message);
        return res.json({ url: relPath, warn: 'git-commit-failed', message: err && err.message });
      }
      // optionally push if repo has a configured remote and credentials
      if (process.env.ENABLE_GIT_PUSH === '1') {
        exec('git push', { cwd: process.cwd() }, (perr, pstdout, pstderr) => {
          if (perr) console.warn('Git push failed:', perr && perr.message);
          return res.json({ url: relPath, git: 'committed-and-pushed' });
        });
      } else {
        return res.json({ url: relPath, git: 'committed' });
      }
    });
  } else {
    return res.json({ url: relPath });
  }
});

// AI generate endpoint: accepts multipart file (field 'file') OR JSON { text }
const aiUpload = multer({ dest: uploadsDir });
app.post('/ai-generate', aiUpload.single('file'), async (req, res) => {
  try {
    // helper: call external AI endpoint if configured
    const callExternalAI = async (promptText) => {
      const url = process.env.AI_API_URL;
      const key = process.env.AI_API_KEY;
      if (!url || !key) return null;
      try {
        if (typeof fetch === 'undefined') {
          console.warn('Global fetch not available in this Node runtime; cannot call external AI.');
          return null;
        }

        // Some Google API setups provide an "API key" (starts with "AIza...") that must be
        // sent as a query param (key=...), whereas other providers expect a Bearer token
        // in the Authorization header. Detect the common Google API key format and append
        // it as a query param when appropriate.
        let fetchUrl = url;
        const headers = { 'Content-Type': 'application/json' };
        const looksLikeGoogleApiKey = typeof key === 'string' && key.indexOf('AIza') === 0;
        if (looksLikeGoogleApiKey) {
          fetchUrl = url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
        } else {
          headers['Authorization'] = `Bearer ${key}`;
        }

        // Logging: indicate we are about to call the provider. Do NOT log the API key.
        try {
          console.log('[AI] Calling external AI provider at', fetchUrl, 'promptLength=', (promptText || '').length);
        } catch (e) { /* ignore logging errors */ }

        // Build a request body tailored for Generative/Vertex/PaLM endpoints when the URL
        // indicates such an endpoint. Otherwise keep a simple { prompt } body.
        let body;
        if (/generateText|generativelanguage|text-bison|predict/.test(fetchUrl)) {
          body = { prompt: { text: promptText }, temperature: 0.2, maxOutputTokens: 1200 };
        } else {
          body = { prompt: promptText };
        }

        const r = await fetch(fetchUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          timeout: 60000
        });
        if (!r.ok) {
          // capture provider response body for diagnostics and return structured error
          let bodyText = '';
          try { bodyText = await r.text(); } catch (e) { bodyText = `<failed to read body: ${e && e.message}>`; }
          console.warn('[AI] Provider returned non-OK:', r.status, r.statusText, 'bodySnippet=', String(bodyText).slice(0,1000));
          return { error: true, status: r.status, statusText: r.statusText, body: bodyText };
        }
        // parse JSON, but guard against text-only responses
        let json = null;
        try { json = await r.json(); } catch (e) {
          try { const t = await r.text(); json = { rawText: t }; } catch (e2) { json = null; }
        }
        // also log a small snippet of the provider JSON for debugging (non-sensitive)
        try { console.log('[AI] Provider response parsed. keys=', Object.keys(json || {}).slice(0,10)); } catch (e) {}
        return json;
      } catch (e) {
        console.warn('callExternalAI failed', e && e.message);
        return { error: true, message: e && e.message };
      }
    };

    // assemble the text to send to AI
    let textToProcess = null;
    if (req.is('application/json') && req.body && req.body.text) {
      textToProcess = req.body.text;
    }
    if (req.file && !textToProcess) {
      const savedPath = path.join(uploadsDir, req.file.filename);
      const target = path.join(uploadsDir, Date.now() + '-' + (req.file.originalname || req.file.filename).replace(/[^a-zA-Z0-9._-]/g, '_'));
      fs.renameSync(savedPath, target);
      const ext = path.extname(target).toLowerCase();
      let extracted = null;
      try {
        if (ext === '.pdf' && pdfParse) {
          const dataBuffer = fs.readFileSync(target);
          const pdfData = await pdfParse(dataBuffer);
          extracted = (pdfData && pdfData.text) ? pdfData.text : null;
        } else if ((ext === '.docx' || ext === '.doc') && mammoth) {
          const result = await mammoth.extractRawText({ path: target });
          extracted = result && result.value ? result.value : null;
        }
      } catch (e) {
        console.warn('File parsing failed for', target, e && e.message);
      }
      if (extracted && extracted.trim()) {
        textToProcess = extracted;
      } else {
        // fallback: include filename context
        textToProcess = `Uploaded file: ${path.basename(target)}. Please extract meaningful text and generate detailed test cases.`;
      }
    }

    if (!textToProcess) return res.status(400).json({ error: 'No text or file provided' });

    // Try external AI if configured. Build a structured prompt asking for JSON output.
    const buildPrompt = (content) => {
      return `You are an expert Software Quality Assurance engineer. Given the following specification or feature description, generate detailed test cases grouped into sections: positive, negative, edge, setup, security, api, stress, and recommendations. For each test case include: title, steps (ordered list), inputs (if any), expected result, severity (Low/Medium/High/Critical), and notes. Return the answer as a JSON object with keys: positive, negative, edge, setup, security, api, stress, recommendations. Each key should map to an array of test case objects. Example output schema:\n{ "positive": [{ "title":"...", "steps":["..."], "inputs":[], "expected":"...", "severity":"Medium", "notes":"..." }], "negative": [...], ... }\nNow analyze the following content:\n\n${content}`;
    };

    const aiResult = await callExternalAI(buildPrompt(textToProcess));
    // If provider returned a structured error, surface it to client so UI can show details
    if (aiResult && aiResult.error) {
      console.warn('[AI] External provider error, returning to client', aiResult && (aiResult.status || aiResult.message));
      return res.status(502).json({ error: 'AI provider error', details: aiResult });
    }
    if (aiResult) {
      // Attempt to normalize provider response into our expected shape
      // If provider returned structured JSON with proper keys, return it. Otherwise, try to find .text or .output.
      if (typeof aiResult === 'object') {
        // If it's already in our expected shape, return directly
        const keys = ['positive','negative','edge','setup','security','api','stress','recommendations'];
        const hasAny = keys.some(k => aiResult[k]);
        if (hasAny) return res.json(aiResult);
        // fallback: if provider includes a text field, try to parse as JSON inside
        // provider typical fields
        // Prefer common provider fields (candidates[0].output/content, predictions[0].content, choices, etc.)
        const textOut = aiResult.output
          || aiResult.text
          || (aiResult.candidates && aiResult.candidates[0] && (aiResult.candidates[0].content || aiResult.candidates[0].output))
          || (aiResult.predictions && aiResult.predictions[0] && aiResult.predictions[0].content)
          || (aiResult.choices && aiResult.choices[0] && (aiResult.choices[0].message && aiResult.choices[0].message.content ? aiResult.choices[0].message.content : aiResult.choices[0].text))
          || aiResult.generated_text
          || (typeof aiResult.rawText === 'string' ? aiResult.rawText : null)
          || null;
        if (textOut) {
          // try parse JSON directly first
            try { const parsed = typeof textOut === 'string' ? JSON.parse(textOut) : textOut; return res.json(parsed); } catch (e) {
            // fallback: try to extract JSON substring from text
            const maybe = String(textOut).match(/\{[\s\S]*\}$/m);
            if (maybe && maybe[0]) {
              try { return res.json(JSON.parse(maybe[0])); } catch (e2) { /* fall through */ }
            }
            // last resort: return raw text under a field so UI can show it
            return res.json({ raw: String(textOut) });
          }
        }
      }
    }

    // Fallback mocked structured response generated from keywords in the content
    // makeCase is backwards-compatible: callers may pass the old positional args or a single
    // object. Always return an object containing extended metadata useful for detailed test
    // case rendering (preconditions, postconditions, apiSample, automation hints, priority,
    // estimatedMinutes, tags). This helps the frontend show richer information.
    const makeCase = (...args) => {
      if (args.length === 1 && typeof args[0] === 'object' && args[0].title) {
        // ensure defaults for missing extended fields
        const base = args[0];
        return Object.assign({ preconditions: [], postconditions: [], apiSample: null, automation: null, priority: base.severity || 'Medium', estimatedMinutes: null, tags: [] }, base);
      }
      const [title, steps, inputs, expected, severity, notes] = args;
      return {
        title: title || 'Untitled test',
        steps: Array.isArray(steps) ? steps : (steps ? [String(steps)] : []),
        inputs: inputs || [],
        expected: expected || '',
        severity: severity || 'Medium',
        notes: notes || '',
        preconditions: [],
        postconditions: [],
        apiSample: null,
        automation: null,
        priority: severity || 'Medium',
        estimatedMinutes: null,
        tags: []
      };
    };
    const text = String(textToProcess || '').toLowerCase();
    const sections = { positive: [], negative: [], edge: [], setup: [], security: [], api: [], stress: [], recommendations: [] };
    const push = (sec, c) => { if (!sections[sec]) sections[sec]=[]; sections[sec].push(c); };

    const addLoginCases = () => {
      push('positive', makeCase('Successful login with valid credentials', [
        'Open the application login page (https://.../login).',
        'Ensure network connectivity and that the backend auth service is reachable.',
        'Enter a known valid email in the username field (e.g. user@example.com).',
        'Enter the correct password for that account.',
        'Click the Login / Submit button.',
        'Assert the UI navigates to the user dashboard and the user name is displayed, and that the HTTP response code from the login API is 200.'
      ], [{ username: 'user@example.com', password: 'CorrectPass!23' }], 'User is authenticated, session cookie or token issued, dashboard visible and user-specific data loaded', 'Medium', 'Preconditions: test account exists and email verified. Postconditions: session created. Automation tip: assert Set-Cookie header or presence of auth token in localStorage; add cleanup to log out at end.') );

      push('positive', makeCase('Login with Remember Me and persistent session', [
        'Open login page and enter valid credentials.',
        'Check "Remember me" checkbox when logging in.',
        'Submit and close the browser tab or restart the browser session.',
        'Reopen the app and verify the user remains logged in or is auto-logged in according to spec.'
      ], [], 'User session persists across browser restarts as per Remember Me policy; long-lived cookie or token present', 'Low', 'Validate cookie expiry, secure flag, and token refresh policy. Automation: simulate browser restart and assert authenticated state.') );

      push('positive', makeCase('Login via OTP / Email code (if supported)', [
        'Open login or passwordless auth page.',
        'Enter the registered email and request a one-time code.',
        'Retrieve the code from test mailbox and submit it.',
        'Assert successful authentication and access to dashboard.'
      ], [], 'One-time code authentication succeeds; session established', 'Medium', 'Ensure code expiry and single-use semantics; test delivery and handling of expired codes.') );

      push('negative', makeCase('Login rejected with missing password', [
        'Open the login page.',
        'Enter a valid username/email into the username field.',
        'Leave the password field empty.',
        'Click Login.',
        'Observe client-side validation and any server-side response; assert user is not authenticated.'
      ], [{ username: 'user@example.com' }], 'Client shows validation message "Password is required" and server returns 400/422 if payload submitted; no session is created', 'High', 'Verify both client and server validation. Automation: validate presence of validation message and that no auth token is stored.') );

      push('edge', makeCase('Very long username input', [
        'Open the login page.',
        'Paste a username string of length 5000 characters into the username field.',
        'Enter a valid password.',
        'Click Login and observe app and server behavior.'
      ], [{ username: 'a'.repeat(5000) }], 'App should either reject input with validation or truncate safely; server returns an error rather than crashing', 'Low', 'Check DB column limits, request size limits, and character encoding handling. Ensure no stack overflow or OOM on server.') );

      push('security', makeCase('Prevent SQL injection in login', [
        'Open login page.',
        "Attempt login using a username containing SQL payload: ' OR 1=1 --",
        'Observe response and authentication result.'
      ], [{ username: "' OR 1=1 --", password: 'anything' }], 'Authentication must not bypass checks; login must fail and inputs treated as data', 'Critical', 'Ensure prepared statements/ORM are used. Pen-test suggestion: assert DB logs show safe parameterization; check for error messages that leak DB info.') );

      push('stress', makeCase('Sustained concurrent logins', [
        'Prepare a load test with 500 concurrent login attempts using valid credentials.',
        'Execute load for 10 minutes while monitoring response latencies and error rates.',
        'Observe server CPU, memory, DB connections and auth throughput metrics.'
      ], [], 'System remains available, error rate stays below SLA threshold; average latency within acceptable bounds', 'High', 'Measure bottlenecks (DB/ratelimit). Use idempotency/backoff, and ensure rate-limiting/throttling for abusive traffic.') );
    };

    const addRegistrationCases = () => {
      push('positive', makeCase('Successful registration with email verification', [
        'Open the registration page (https://.../register).',
        'Complete all required fields with valid values (name, email, password).',
        'Optionally attach a profile picture if supported.',
        'Submit the registration form.',
        'Assert API returns 201 and a verification email is queued/sent.',
        'Open the verification email, click the verification link, and assert the account status changes to verified.'
      ], [{ email: 'newuser@example.com', password: 'ValidPass123!' }], 'Account created in pending state, verification link sent; after clicking link user becomes verified and can log in', 'Medium', 'Preconditions: email provider configured; check email delivery logs, token expiry policy, and resend link behavior. Automation: use test SMTP or mailbox API to retrieve verification link.') );

      push('positive', makeCase('Registration with optional profile picture', [
        'Open the registration page.',
        'Fill required fields and upload a small JPEG/PNG as avatar.',
        'Submit form and wait for upload to finish.',
        'Assert that profile shows thumbnail/URL and image content-type is valid.'
      ], [{ file: 'profile.jpg', maxSizeMB: 2 }], 'Profile created with avatar URL; image stored and served correctly', 'Low', 'Verify image is resized, stored under sanitized filename, and content-type checks are enforced. Automation tip: assert returned avatar URL responds with 200 and correct MIME type.') );

      push('negative', makeCase('Reject duplicate email registration', [
        'Attempt to register using an email already present in the system.',
        'Submit the form and observe response.'
      ], [{ email: 'existing@example.com' }], 'System returns an error message "Email already in use" and does not create duplicate account', 'High', 'Test for race conditions by submitting two near-simultaneous registration requests with same email; DB unique constraint should prevent duplicates.') );

      push('positive', makeCase('Registration with minimal required fields (no optional profile picture)', [
        'Open registration page.',
        'Fill only required fields (name,email,password) with valid data.',
        'Submit and verify account creation and welcome/verification email behavior.',
      ], [], 'Account created in pending state and verification email sent; user can proceed after verification', 'Low', 'Checks basic path without optional data; useful for smoke tests and automation.') );

      push('positive', makeCase('Registration via social sign-on (OAuth) if available', [
        'Click Sign up with Google / Facebook button.',
        'Complete OAuth consent flow and allow permissions.',
        'Assert account is created/linked and user is logged in.',
      ], [], 'Account created with linked social identity; no duplicate account created', 'Low', 'Ensure OAuth callback handling and account linking are correct. Automation: mock OAuth provider or use test app credentials.') );

      push('negative', makeCase('Reject weak password', [
        'Fill registration with common/weak password (e.g., "password123").',
        'Submit and observe validation response.'
      ], [{ password: 'password123' }], 'Registration rejected; validation message indicates password policy requirements', 'High', 'Enforce complexity, length, and banlists. Automation: check error codes and messages match API contract.') );

      push('negative', makeCase('Reject invalid email format', [
        'Enter malformed email like "user@@example" and submit.',
        'Observe client and server validation results.'
      ], [], 'Client shows immediate validation; server returns structured error 400 if invalid payload submitted', 'Medium', 'Ensure validation patterns align across client and server.') );

      push('edge', makeCase('Expired verification token', [
        'Register a new user; retrieve verification token.',
        'Simulate token expiry (advance clock or wait), then attempt verification using token.',
        'Observe response and ability to request a new token.'
      ], [], 'Verification fails with informative message; user can request a new token', 'Medium', 'Test token TTL, resend flows and race conditions for multiple tokens.') );

      push('edge', makeCase('Very long input fields (name, bio)', [
        'Submit registration with extremely long strings in name/bio fields (e.g., 100k chars).',
        'Observe server and DB behavior.'
      ], [], 'System handles input without crashing and either truncates or returns validation error per spec', 'Low', 'Check DB column sizes, request size limits, and truncation/escaping behavior.') );

      push('security', makeCase('Prevent account enumeration', [
        'Attempt to register with an email known to exist and measure response timing and messages.',
        'Attempt password reset or registration flows for both existing and non-existing emails and compare responses.'
      ], [], 'Responses do not reveal whether an email is registered (or mitigations are in place such as uniform responses and rate-limiting)', 'High', 'Consider uniform success messages and implement rate-limiting/monitoring for abuse. Automation: assert messages are identical for existing/non-existing emails where required.') );

      push('api', makeCase('Registration API validation', [
        'Call POST /api/register with missing or malformed fields via API client.',
        'Observe structured validation errors and HTTP status code.'
      ], [], 'Return 400 with clear structured validation errors indicating which fields failed', 'Medium', 'Ensure API returns machine-readable errors for automation. Add schema tests for all required fields.') );

      push('stress', makeCase('High-volume registrations', [
        'Simulate bulk user signups (thousands/hour) while monitoring email queue and DB write throughput.',
        'Observe system degradation and email provider throttling behavior.'
      ], [], 'System remains stable or gracefully degrades; email sending scales or is queued', 'High', 'Test backpressure, queueing, and idempotency; verify monitoring/alerts on queue length and error rates.') );
    };

    const addAdminCases = () => {
      push('positive', makeCase('Admin assigns role to user', [
        'Login as an admin user and navigate to the User Management page.',
        'Search or locate a target user by email or id.',
        'Open the role/permissions editor, select the desired role (e.g., moderator), and save changes.',
        'Assert that the API returns 200 and that the user now sees moderator UI elements after next login or token refresh.'
      ], [], 'User role updated in DB, audit log entry created, and permissions applied on next token refresh', 'High', 'Verify audit log contains admin id, target id, timestamp, and changed role. Automation: assert API returns updated role and audit record exists.') );

      push('negative', makeCase('Non-admin cannot access admin panel', [
        'Login as a non-privileged user.',
        'Attempt to access /admin UI and call admin API endpoints.',
        'Observe responses and any redirects.'
      ], [], 'Access denied with 403 or redirect to login; no admin data returned', 'Critical', 'Enforce server-side checks regardless of client-side UI restrictions. Check that UI links are hidden and server returns proper status codes.') );

      push('edge', makeCase('Role removal during active session', [
        'While a target user is logged in with admin rights, an admin removes their admin role via the admin panel.',
        'Attempt admin-only actions from the target user without re-login and after token refresh.'
      ], [], 'Active sessions should either lose elevated privileges after token refresh or require re-auth; subsequent admin actions are denied', 'High', 'Test token lifetime, revocation, and how quickly permissions propagate. Automation: simulate token refresh flows.') );

      push('security', makeCase('Privilege escalation check', [
        'Attempt to call admin endpoints with a normal user token via API client.',
        'Also attempt to tamper with client-side role flags to enable admin UI and call APIs.'
      ], [], 'All admin endpoints must deny access for non-admin tokens; UI tampering must not grant server-side privileges', 'Critical', 'Include penetration tests and verify RBAC enforcement across all APIs. Log attempts and rate-limit suspicious activity.') );

      push('api', makeCase('Admin API pagination and filters', [
        'Call GET /api/users?page=2&role=admin&sort=createdAt to validate pagination and filtering.',
        'Assert response includes total count, page size, and items for requested page.'
      ], [], 'Return paginated, filtered results with performance acceptable for large datasets', 'Medium', 'Test with large user sets and check DB indexing and query plans.') );
    };

    const addUploadCases = () => {
      push('positive', makeCase('Successful file upload', [
        'Open the upload page/form.',
        'Select a supported file type (PDF, JPG) under allowed size limits.',
        'Submit the upload and wait for server response and processing to finish.',
        'Assert API returns 201 and response includes file URL and metadata (size, mimeType).',
        'Fetch the returned file URL and assert content-type and content length are reasonable.'
      ], [{ file: 'sample.pdf', maxSizeMB: 5, allowedTypes: ['application/pdf','image/jpeg','image/png'] }], 'File stored, scanned, and accessible via returned URL; metadata correct', 'Medium', 'Verify virus scanning, content-type normalization, storage path, and thumbnails if applicable. Automation: download file and validate checksum or content headers.') );

      push('positive', makeCase('Replace existing file (versioning) or update avatar', [
        'Upload a second file for the same field (e.g., update profile picture).',
        'Ensure previous file is archived or overwritten according to spec.',
        'Assert new file URL reflects updated content and previous file is either removed or versioned.'
      ], [], 'New file is active and accessible; previous file handled per retention policy', 'Low', 'Test storage/versioning behavior and cleanup policies.') );

      push('negative', makeCase('Reject unsupported file type', [
        'Attempt to upload an .exe or other disallowed file type via the form and via direct API call.',
        'Observe response codes and messages.'
      ], [{ file: 'malware.exe' }], 'Upload rejected with 400/415 and descriptive message; file not stored', 'High', 'Validate by MIME type and extension; ensure server does not rely solely on client checks.') );

      push('security', makeCase('Prevent arbitrary file write', [
        'Attempt path traversal in filename or metadata (e.g., filename = "../secrets.txt") by submitting via API.',
        'Observe whether the server writes outside of allowed upload directory.'
      ], [], 'Server must sanitize paths and never write outside the configured uploads directory', 'Critical', 'Check filename sanitization, storage driver and permissions. Include checks for symbolic link attacks and ACL/permission enforcement.') );
    };

    const addPaymentCases = () => {
      push('positive', makeCase('Payment succeeds with valid card', [
        'Add items to cart and proceed to checkout.',
        'Enter valid card details and billing info.',
        'Submit payment and wait for gateway response.',
        'Assert order is created, payment status is captured, and user receives confirmation.'
      ], [], 'Payment accepted, order status = paid, transaction recorded with id and receipt sent', 'High', 'Test gateway integration and 3D Secure flows; verify webhook handling for asynchronous confirmations.') );

      push('positive', makeCase('Payment with saved card / tokenized payment', [
        'Choose saved payment method and confirm payment.',
        'Assert transaction completes using stored token and no new card entry is required.',
      ], [], 'Payment accepted via stored payment token; no duplicate card data stored', 'Medium', 'Verify tokenization and vaulting behavior; test expired/removed token handling.') );

      push('negative', makeCase('Reject expired card', [
        'At checkout use a card number with an expiry date in the past.',
        'Submit payment and observe error code and message from gateway.'
      ], [], 'Payment rejected with explicit message such as "Card expired" and no order created', 'High', 'Ensure gateway errors are surfaced clearly to the user and logged for reconciliation.') );

      push('api', makeCase('Retry payment idempotency', [
        'Simulate a network retry by resubmitting the same payment request idempotently.',
        'Assert that only one charge is created by the gateway and the server returns the same transaction id.'
      ], [], 'No duplicate charges; idempotency keys honored', 'High', 'Implement idempotency keys and test with simulated timeouts and retries.') );
    };

    const addSearchCases = () => {
      push('positive', makeCase('Search returns relevant results', [
        'Ensure a dataset is indexed with known items.',
        'Search for a keyword expected to match specific items.',
        'Assert that returned results contain expected items in relevant order and total count is correct.'
      ], [], 'Search returns relevant, ranked results and response time is within SLA', 'Medium', 'Test tokenization, stemming, synonyms and ranking; record sample queries and results for regression tests.') );

      push('edge', makeCase('Very long query', [
        'Submit a 1000-character search query and observe response.',
        'Assert that query length is either truncated or rejected per spec.'
      ], [], 'System handles long queries gracefully (reject/truncate) and returns meaningful error or empty results', 'Low', 'Enforce maximum query length and test against injection-like payloads.') );
    };

  if (text.includes('login') || text.includes('sign in') || text.includes('authentication')) addLoginCases();
  if (text.includes('register') || text.includes('sign up') || text.includes('registration') || text.includes('email verification')) addRegistrationCases();
    if (text.includes('upload') || text.includes('file')) addUploadCases();
    if (text.includes('pay') || text.includes('payment') || text.includes('checkout')) addPaymentCases();
    if (text.includes('search') || text.includes('find')) addSearchCases();
  if (text.includes('admin') || text.includes('role management') || text.includes('admin panel')) addAdminCases();

    // if no keywords matched, create generic cases based on content length
    if (Object.values(sections).every(arr => arr.length === 0)) {
      push('positive', makeCase('Happy path from spec', ['Follow main scenario in spec'], [], 'Main flow works as expected', 'Medium', 'Derived from provided document'));
      push('negative', makeCase('Validation errors', ['Try missing required fields'], [], 'Clear validation errors shown', 'High', 'Check both client and server'));
    }

    // Add a baseline recommendation
    push('recommendations', makeCase('General recommendations', [], [], 'Add monitoring, rate-limiting, and input validation', 'Low', 'See security and performance sections'));

    return res.json(sections);
  } catch (e) {
    console.error('ai-generate failed', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/status', (req, res) => res.json({ ok: true, imagesDir, enableGitCommit: ENABLE_GIT_COMMIT }));

app.listen(PORT, () => console.log(`Upload server listening on http://localhost:${PORT} — images -> ${imagesDir}`));
