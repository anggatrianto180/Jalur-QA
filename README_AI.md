AI Testcase generator — local run instructions

This project includes a simple `/ai-generate` endpoint (in `upload-server.js`) that accepts either:
- multipart form upload (`file` field) with PDF/DOCX, or
- POST JSON `{ "text": "..." }`.

By default the endpoint returns a mocked structured response (useful for local development). To enable calling a real AI provider (e.g. Gemini / other REST endpoint), set the following environment variables:

- `AI_API_URL` — the full POST endpoint to call (e.g. your AI proxy or provider REST URL)
- `AI_API_KEY` — the API key or bearer token

Important: Do NOT commit your API key into source control. Use environment variables or a secrets manager.

PowerShell example (temporary environment for a single command):

```powershell
# Start server with AI integration enabled (example)
$env:AI_API_URL = 'https://api.example.com/v1/generate'
$env:AI_API_KEY = 'REPLACE_WITH_YOUR_KEY'
node upload-server.js
```

Or, to set for the session interactively:

```powershell
$env:AI_API_KEY = 'REPLACE_WITH_YOUR_KEY'
$env:AI_API_URL = 'https://api.example.com/v1/generate'
npm run start
```

Notes on production integration
- The server attempts to call the external AI using a simple JSON body: `{ prompt: "..." }` with `Authorization: Bearer <AI_API_KEY>`.
- The response is expected to be JSON. The server will try to normalize typical provider responses but you should adapt `upload-server.js` to parse the exact provider response format (Gemini / PaLM, OpenAI, etc.).
- Consider adding:
  - File parsing (PDF/DOCX -> text) via `pdf-parse` and `mammoth`.
  - Rate limiting (e.g. `express-rate-limit`).
  - Input sanitization and max upload size limits.
  - Background processing or queuing for long-running AI calls.

If you want, I can add a concrete Gemini/OpenAI example wiring (with prompt engineering) next — I will need to know which provider and exact endpoint you want to use.

Quick start (serve UI and API from same server)

1. Start the upload server (this will also serve `index.html` on the same port):

```powershell
node upload-server.js
```

2. Open your browser to http://localhost:4000 and navigate to the "AI Testcase" menu.

3. Use the drag & drop area or paste text and click "✨ Generate Test Cases".

If you set `AI_API_URL` and `AI_API_KEY` in your environment before starting the server, the backend will attempt to call the configured AI provider. Otherwise it returns a mocked response for UI testing.

Install dependencies for file parsing (optional but recommended if you want PDF/DOCX extraction):

```powershell
npm install pdf-parse mammoth
```
