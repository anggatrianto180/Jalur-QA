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
      // Basic POST with Bearer Authorization. User should configure AI_API_URL appropriate
      // for their provider (e.g. Google Generative API endpoint) and AI_API_KEY as secret.
      try {
        if (typeof fetch === 'undefined') {
          console.warn('Global fetch not available in this Node runtime; cannot call external AI.');
          return null;
        }
        const body = { prompt: promptText };
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify(body),
          timeout: 60000
        });
        if (!r.ok) {
          console.warn('AI provider returned non-OK:', r.status, r.statusText);
          return null;
        }
        const json = await r.json();
        return json;
      } catch (e) {
        console.warn('callExternalAI failed', e && e.message);
        return null;
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

    // Try external AI if configured
    const aiResult = await callExternalAI(textToProcess);
    if (aiResult) {
      // Attempt to normalize provider response into our expected shape
      // If provider returned structured JSON with proper keys, return it. Otherwise, try to find .text or .output.
      if (typeof aiResult === 'object') {
        // If it's already in our expected shape, return directly
        const keys = ['positive','negative','edge','setup','security','api','stress','recommendations'];
        const hasAny = keys.some(k => aiResult[k]);
        if (hasAny) return res.json(aiResult);
        // fallback: if provider includes a text field, try to parse as JSON inside
        const textOut = aiResult.output || aiResult.text || (aiResult.candidates && aiResult.candidates[0] && aiResult.candidates[0].content) || null;
        if (textOut) {
          // try parse JSON
          try { const parsed = typeof textOut === 'string' ? JSON.parse(textOut) : textOut; return res.json(parsed); } catch (e) { return res.json({ raw: textOut }); }
        }
      }
    }

    // Fallback mocked response
    return res.json({
      positive: ["Valid input flows produce expected outputs."],
      negative: ["Missing required fields should return validation errors."],
      edge: ["Extremely long inputs or unusual encodings should be handled."],
      setup: ["Create test accounts and seed data as described."],
      security: ["Check for injections, file upload validation, and auth enforcement."],
      api: ["Validate response codes, payload shapes, and pagination behavior."],
      stress: ["Run load tests with increasing concurrency and measure p99 latency."],
      recommendations: ["Add input size limits, rate limiting, and proper auth checks."]
    });
  } catch (e) {
    console.error('ai-generate failed', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/status', (req, res) => res.json({ ok: true, imagesDir, enableGitCommit: ENABLE_GIT_COMMIT }));

app.listen(PORT, () => console.log(`Upload server listening on http://localhost:${PORT} — images -> ${imagesDir}`));
