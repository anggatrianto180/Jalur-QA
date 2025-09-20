const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { exec } = require('child_process');

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

// serve images statically
app.use('/images', express.static(imagesDir));

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

app.get('/status', (req, res) => res.json({ ok: true, imagesDir, enableGitCommit: ENABLE_GIT_COMMIT }));

app.listen(PORT, () => console.log(`Upload server listening on http://localhost:${PORT} — images -> ${imagesDir}`));
