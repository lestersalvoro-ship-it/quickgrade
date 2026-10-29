# QuickGrade

**Scan bubble answer sheets with a phone, grade them instantly, and understand where a class needs help.**

QuickGrade is a web app (installable PWA) for teachers, tutors and review centres. Teachers build a quiz and its answer key and print matching answer sheets. They photograph the filled sheets, review anything the scanner was unsure about, and save scores. Analytics and optional AI insights are built from the saved results.

- **Core grading works fully offline from any AI provider.** Scores are always computed deterministically from the answer key.
- **The scanner never silently guesses.** Faint, partial, erased or double marks are flagged, and the server refuses to save a sheet until every flag has been reviewed.
- **Student data stays on your server.** Only anonymised, aggregated statistics are ever sent to the AI provider, and only when you ask for an AI feature.

---

## Contents

1. [Quick start](#quick-start)
2. [What is implemented (and how it was verified)](#feature-status)
3. [Architecture](#architecture)
4. [Database schema](#database-schema)
5. [Answer sheets and scanning](#answer-sheets-and-scanning)
6. [Configuring AI](#configuring-ai)
7. [Testing](#testing)
8. [Deployment](#deployment)
9. [Security and privacy](#security-and-privacy)
10. [Limitations, pending work and external services](#limitations-and-pending-work)
11. [Project layout](#project-layout)

Detailed guides are in [`docs/`](docs): [scanning & printing](docs/scanning.md), [AI](docs/ai.md), [deployment & backups](docs/deployment.md), [Android app (APK)](docs/android.md), [security & privacy](docs/security-privacy.md).

**Android app:** run the **Actions → Android APK** workflow on GitHub (it builds on Ubuntu), enter your server's HTTPS address, and download the APK. See [docs/android.md](docs/android.md).

---

## Quick start

**Requirements:** Node.js ≥ 22.13 (22, 24 or 26 all work) and npm. For the scanner test suite and the sample-sheet script you also need poppler's `pdftoppm` (`apt install poppler-utils` / `brew install poppler`). The app itself does not need it.

```bash
npm install
cp .env.example .env          # optional: defaults work for local use
npm run dev                   # API on :3000, web app on http://localhost:5173
```

Open <http://localhost:5173>, create an account, then:

1. **Classes → New class**, then add students or **Import CSV**. Each student has a student number of up to 8 digits; that is what they bubble on the sheet.
2. **Quizzes → New quiz**. Pick 20, 50 or 100 items (any 1–100 works) and 2–5 choices. Set the key by clicking bubbles, or paste a string like `ABCDABCD…` into **Quick entry**, then save.
3. **Print sheets.** Choose A4 or Letter, and either blank copies or one personalised sheet per student (name printed, ID pre-bubbled).
4. **Scan & Grade.** Start a session (quiz + class), then use the camera or upload photos (several at once).
5. **Review.** Resolve the flagged questions, check the matched student, then **Confirm & save**.
6. **Results.** Open the session for scores, analytics, item analysis, CSV/PDF exports and AI insights.

No printer handy? Run `npm run sample-sheets -- <sheetCode> 20 4 1001` (the sheet code is on the quiz page, e.g. "Sheet #302684"). This writes blank PDFs plus realistic simulated phone photos of a filled sheet to `./samples/` for you to upload.

### Production build

```bash
npm run build                 # web → dist/web, server → dist/server
NODE_ENV=production COOKIE_SECURE=false node dist/server/index.mjs   # serves app + API on :3000
```

Set `COOKIE_SECURE=false` only for plain-HTTP local testing; real deployments must use HTTPS (see [Deployment](#deployment)).

---

<a id="feature-status"></a>

## What is implemented (and how it was verified)

Legend: ✅ implemented and covered by automated tests · 🟡 implemented, verified manually or only partly automated · ⏳ pending / not implemented.

| Area | Status | Notes |
|---|---|---|
| Registration, login, logout, sessions | ✅ | scrypt hashes, HttpOnly SameSite cookies, hashed session tokens, sliding expiry |
| Password reset | ✅ | One-hour single-use token by email; all sessions are revoked on reset. Without SMTP the link goes to the server log (🟡 real SMTP delivery not tested) |
| Profile, password change, defaults | ✅ | Default pass mark, scan-image retention days |
| Per-teacher data isolation | ✅ | Every query is scoped by teacher; tested across all major endpoints |
| Dashboard with real data, empty states | ✅ | Counts, average, pass rate, recent sessions chart, activity feed, getting-started checklist |
| Classes (create/edit/archive, roster, export) | ✅ | Duplicate active class names are blocked |
| Students (CRUD, search/filter/sort/paginate, archive, permanent delete) | ✅ | Unique student numbers per teacher, normalised without leading zeros |
| CSV roster import | ✅ | Flexible headers, dry-run preview, per-line errors, duplicate handling (skip/update), enrolment, 1 MB / 2000 rows |
| Quizzes (create/edit/duplicate/archive/delete) | ✅ | 1–100 items, 2–5 choices, points, exclusions, topics, optional question text and choices |
| Answer-key validation | ✅ | Incomplete keys may be saved as drafts but cannot be graded; layout is locked once results exist |
| Configurable grading rules | ✅ | Pass mark, wrong-answer penalty, penalise blanks, multiple-mark policy, floor at zero |
| Regrading on key/rule changes | ✅ | Transactional, with an audit entry listing every key change |
| Printable answer sheets (PDF) | ✅ | A4/Letter, blank or personalised per student; the shared layout drives both PDF and scanner |
| Answer-key PDF / CSV | ✅ | |
| Camera capture | 🟡 | `getUserMedia` (rear camera, highest resolution, `ImageCapture` when available) with an alignment guide. Not tested on physical phones in this environment; the upload path is covered end to end |
| Photo upload (single and batch) | ✅ | Content is validated with sharp, re-encoded (EXIF/GPS stripped), and duplicate photos are rejected |
| Sheet detection, perspective correction, bubble reading | ✅ | Tested against ground truth on simulated photos rendered from the real PDF ([details](#testing)). 🟡 Not yet validated on physically printed and photographed sheets |
| Blank / multiple / ambiguous detection, confidence | ✅ | Faint, partial, erased, check-mark and double marks are flagged |
| Sheet ↔ quiz validation | ✅ | CRC-protected sheet code; wrong-quiz and outdated-layout sheets are rejected; fallback with explicit confirmation if the code strip is damaged |
| Student ID bubbles and roster matching | ✅ | Unreadable, unknown or unenrolled IDs require the teacher to choose the student |
| Review screen and corrections before saving | ✅ | Per-row photo crops, click-to-correct, live score preview; the server refuses unreviewed flags |
| Duplicate-result prevention | ✅ | One result per student per session (DB constraint); replacing one requires explicit opt-in and is audited |
| Manual entry | ✅ | Same grading engine |
| Post-save corrections with audit history | ✅ | Reason, before/after per question, edit counters |
| Results list (search, filter, sort, paginate) | ✅ | |
| Analytics | ✅ | Mean, median, min/max, std. dev., pass rate, histogram, % correct per question, most-missed, distractors, discrimination index (n ≥ 10), topic breakdown |
| Assessment comparison | ✅ | Up to 12 sessions |
| Student trend | ✅ | Per-student history and trend chart |
| CSV exports | ✅ | Results (with per-item answers), item analysis, rosters, students; spreadsheet formula injection is neutralised |
| PDF session report | ✅ | |
| AI question generator | ✅ / ⏳ live | Validated and filtered output, teacher review, then the normal quiz editor. Tested with a fake provider; **live calls pending an API key** |
| AI quiz from material | ✅ / ⏳ live | Pasted text or .txt/.md, up to 30k characters, scrubbed of emails and long numbers |
| AI performance insights | ✅ / ⏳ live | Anonymised aggregates only; invented topics are dropped; tests assert no student names or IDs appear in the prompt |
| AI practice recommendations | ✅ / ⏳ live | Practice questions can become a quiz after review |
| AI question explanations | ✅ / ⏳ live | Requires question text; the teacher reviews before saving |
| AI limits, cost tracking, outages | ✅ | Per-teacher daily cap, monthly budget, typed error mapping, clear "pending configuration" state |
| Data export and account deletion | ✅ | JSON export; full cascade delete including images |
| Scan-image retention | ✅ | Configurable days (0 = delete on confirm); periodic cleanup |
| Responsive / mobile layout | ✅ | Playwright checks for no horizontal overflow on a Pixel 7 viewport |
| Installable PWA | 🟡 | Manifest and icons; no service worker (no offline mode) |
| Android app (APK) | 🟡 | Capacitor wrapper of the hosted server with camera permission, downloads and back button; built by a GitHub Actions workflow on `ubuntu-latest`. Not compiled or tried on a phone in the development environment |
| Offline queue / sync | ⏳ | Not implemented (see limitations) |
| Multi-teacher schools / admin role | ⏳ | Only a school name on the profile; no shared org accounts |
| Student-facing mode | ⏳ | Not implemented. Explanations are teacher-only, so keys are never exposed |

---

## Architecture

```
┌──────────────────────── Browser (React PWA) ───────────────────────┐
│ Pages · camera capture · review UI · charts (SVG)                  │
│ shared/ grading engine (live score preview) · sheet layout         │
└───────────────────────────────┬────────────────────────────────────┘
                                │ JSON + multipart over HTTPS (same origin, CSRF header)
┌───────────────────────────────▼────────────────────────────────────┐
│ Fastify API (Node 22, TypeScript)                                  │
│  auth/ (scrypt, sessions) · routes/ (authorisation per teacher)    │
│  services/grading ── shared/grading.ts (deterministic scores)      │
│  scanner/ (pure TS CV) ── shared/sheet/layout.ts + code.ts         │
│  pdf/ (pdfkit sheets, keys, reports) · ai/ (provider interface)    │
│  services/support (audit log, mail, private image storage)         │
└──────────────┬───────────────────────────────┬─────────────────────┘
               │                               │ only on request, aggregates only
       SQLite (built-in node:sqlite, WAL) Anthropic API (optional)
       + DATA_DIR/uploads (private)
```

### Stack and why

| Concern | Choice | Reason |
|---|---|---|
| Frontend | React 19, React Router, TanStack Query, Tailwind v4, Vite | Fast, accessible, mobile-first; one codebase for phone and desktop |
| Backend | Fastify 5 + zod validation | Small, fast, good plugin support (cookies, multipart, rate limit, helmet) |
| Database | SQLite via Node’s built-in `node:sqlite` (no native module to compile) with SQL migrations | Zero-ops for a single school server; real constraints, foreign keys and transactions; trivial backups. Postgres is a documented upgrade path |
| Auth | Built-in `crypto.scrypt`, server-side sessions | No external identity service required; secrets never reach the browser |
| Scanner | Custom TypeScript pipeline + sharp (libvips) for decoding | Deterministic, unit-testable, no WASM/native CV dependency, runs server-side. See below for why not OpenCV |
| PDF | pdfkit | Vector output with exact millimetre geometry |
| AI | `@anthropic-ai/sdk` behind an `AiProvider` interface | Structured outputs plus server-side validation; the provider can be swapped by implementing one interface |
| Tests | Vitest (unit/integration), Playwright (end-to-end) | |

**One layout, two consumers.** `shared/sheet/layout.ts` defines every printed element in millimetres relative to the registration markers. The PDF generator draws from it and the scanner samples from it, so the two cannot drift. The sheet code (`shared/sheet/code.ts`) encodes the template version, item count, choice count and a random 20-bit quiz identifier, with a CRC-8 check.

**Why not OpenCV?** The sheet is designed by QuickGrade, so the vision problem is constrained: find four solid squares, read a code strip, sample circles. A focused TypeScript implementation (adaptive threshold, connected components with shape statistics, 4-point homography, illumination flattening, local alignment) does exactly that. It is fully deterministic and tested end to end, and it avoids shipping and memory-managing an 8–10 MB OpenCV WASM build or a Python sidecar. The trade-off is less general-purpose robustness (for example, no lens-distortion model beyond local row alignment).

### Scanner pipeline (`server/src/scanner/`)

1. **Decode** (sharp): EXIF-orientation aware, grayscale, ≤ 2400 px. Reject unreadable, tiny, very dark or blank images.
2. **Find markers**: local-mean adaptive threshold, then connected components. Keep blobs whose area, fill ratio, covariance isotropy, normalised inertia (≈ 1/6 for a square) and corner reach (rejects filled circles) match a solid square.
3. **Choose the sheet quad**: search 4-combinations for a convex quadrilateral with plausible angles, consistent marker sizes, the expected aspect ratio and a sensible size relative to the image.
4. **Orientation + identity**: for each quad and each of the 4 rotations, compute a homography and read the 44-cell code strip against local white references. The first assignment whose sentinel and CRC both pass wins, which also handles sheets photographed sideways or upside down.
5. **Rectify** into canonical millimetre space at 6 px/mm, then **flatten illumination** using a robust per-block paper estimate (90th percentile with outlier replacement), so shadows and gradients cancel out.
6. **Align locally**: per answer column, then per row, search a small offset that maximises printed-ring contrast. This absorbs paper curl and residual lens distortion.
7. **Measure** mean darkness inside each bubble (inner 60%) and **calibrate per sheet**: the empty level comes from the 20th percentile and the ink level from the code strip's black cells. The filled threshold adapts to this student's typical mark darkness (pen vs pencil).
8. **Classify** each item as `ok`, `blank`, `multiple` or `ambiguous` (faint/partial, possible erasure, or lighter than the student's other marks), with a confidence score. Read the 8-digit student ID the same way.
9. **Quality gates**: ring-contrast "clarity" detects blur, ink level detects washed-out photos. The output includes a rectified, illumination-corrected JPEG for the review screen.

Typical scan time is 0.3–0.6 s per photo on a server CPU.

---

## Database schema

Defined in [`server/migrations/001_initial.sql`](server/migrations/001_initial.sql) and applied automatically at startup or with `npm run migrate`. All timestamps are stored as UTC ISO-8601 and rendered in the viewer's local time zone.

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | Teacher accounts and defaults | unique email (case-insensitive), pass % 0–100 |
| `auth_sessions` | Login sessions (SHA-256 of the token) | FK → users (cascade) |
| `password_resets` | One-time reset tokens (hashed) | expiry, `used_at` |
| `classes` | Classes/sections | unique active (teacher, name, section) |
| `students` | Learners | unique (teacher, student_number); 1–8 digits, no leading zeros |
| `enrollments` | Class ↔ student | composite PK |
| `quizzes` | Assessment, layout and grading rules | unique `sheet_code`; 1–100 items; 2–5 choices |
| `questions` | One row per item = the answer key | unique (quiz, number); choice within range; points > 0 |
| `grading_sessions` | One quiz given to one class | FK RESTRICT on quiz and class |
| `submissions` | A student's saved result | **unique (session, student)**; score columns |
| `responses` | Per-question answer, correctness, scanner status and confidence, teacher override | PK (submission, question); `answered` ⇔ choice not null |
| `scans` | Uploaded photo, scanner output, review status | unique (session, image hash) for pending/confirmed |
| `audit_logs` | Every important change, with JSON details | indexed by teacher and time |
| `ai_requests` | AI calls: feature, status, tokens, cost, validated output | |

Relational data lives in columns. JSON is used only for display-only option texts (validated by the API), scanner diagnostics, audit details and AI output, and grades never depend on these.

---

## Answer sheets and scanning

Full guide: **[docs/scanning.md](docs/scanning.md)**. It covers the sheet format, printing rules, how to photograph sheets, error messages and known limitations.

In short: print at **100% / Actual size** in black on white paper. Photograph the sheet flat, with all four black corner squares and the top code strip visible. Rotation (even upside down) and moderate tilt are corrected automatically.

**Testing the camera:** browsers only allow camera access on HTTPS or `http://localhost`. To test on a phone, serve QuickGrade over HTTPS, for example with a tunnel (`cloudflared tunnel --url http://localhost:3000`) or a reverse proxy with a certificate. Alternatively use **Upload photos**: on phones the file picker can open the camera app even over plain HTTP. See [docs/scanning.md](docs/scanning.md#testing-camera-scanning).

---

## Configuring AI

Full guide: **[docs/ai.md](docs/ai.md)**.

```bash
# .env (server only; never put the key in frontend code)
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
AI_MODEL=claude-opus-5-5
AI_DAILY_REQUESTS_PER_TEACHER=40
AI_MONTHLY_BUDGET_USD=20
```

Restart the server. **AI Assistant → Usage** shows the provider, the model, today's requests and the estimated monthly spend. Without a key, every AI screen says "pending configuration", and all other features keep working.

Requests use Anthropic structured outputs with server-side fallback on refusals (`fallbacks: "default"`). Every response is re-validated: malformed questions are dropped, question references are range-checked, and topics not tagged by the teacher are discarded. The AI never sets or alters scores.

---

## Testing

```bash
npm run typecheck     # TypeScript, whole project
npm test              # Vitest: unit + API integration + scanner ground-truth tests
npm run test:e2e      # Playwright: builds the app, runs it on a temp DB, drives Chromium
```

Results from the last run in the development environment (Node 22.22, Linux):

| Suite | Result |
|---|---|
| `npm run typecheck` | ✅ no errors |
| `tests/grading.test.ts`: grading engine, key validation, analytics, sheet code, layout, classifier | ✅ 25/25 |
| `tests/scanner.test.ts`: ground-truth accuracy and error handling | ✅ 35/35 |
| `tests/api.test.ts`: auth, reset, CSRF, isolation, CSV, quizzes, end-to-end scan→confirm→analytics, regrading, corrections, exports, AI (fake provider), persistence, account deletion | ✅ 31/31 |
| `e2e/workflow.spec.ts`: full teacher workflow in Chromium | ✅ 1/1 |
| `e2e/mobile.spec.ts`: mobile viewport navigation and overflow | ✅ 1/1 |

**How the scanner is tested.** `tests/helpers/synthetic.ts` renders the real generated PDF with poppler at 150 dpi, then draws student marks of several styles (pen, pencil, light pencil, partial tick, eraser residue, check mark, double marks) at known positions. It then simulates a phone photo: perspective/keystone, rotation (including 90° and 180°), small-in-frame, uneven lighting, shadows, sensor noise, blur and JPEG compression on a textured background. Each scan is compared against ground truth for 20/50/100-item sheets, A4 and Letter, personalised and blank. The key assertion is that **no unflagged answer may differ from the truth**. Error cases covered: non-image data, low resolution, no sheet, cropped markers, darkness, heavy blur, damaged code strip (with and without the selected-quiz fallback), and sheets from another quiz.

These are simulated photographs of the real print layout, **not** photographs of physically printed paper. Field validation with real printers, papers, pencils and phones is the most important next step (see limitations).

---

## Deployment

Full guide: **[docs/deployment.md](docs/deployment.md)**. It covers a single VPS with Caddy for automatic HTTPS, Docker, Render/Fly/Railway with a persistent volume, backups and upgrades.

QuickGrade is one Node process plus a data directory (`DATA_DIR`: SQLite database + private scan images). It needs a host with a **persistent disk**. The original Netlify starter in this repository was replaced because serverless/static hosting cannot keep the database or uploaded images.

```bash
docker build -t quickgrade .
docker run -d -p 3000:3000 -v quickgrade-data:/data --env-file .env -e TRUST_PROXY=true quickgrade
```

The Dockerfile is provided but was **not built in the development environment** (no Docker daemon was available). The production bundle it packages was built and exercised by the e2e tests.

---

## Security and privacy

Summary (details in [docs/security-privacy.md](docs/security-privacy.md)):

- **Passwords and sessions:** scrypt password hashes (N=2¹⁵); random 256-bit session tokens stored only as SHA-256; HttpOnly, SameSite=Lax, Secure cookies in production; sessions revoked on reset and password change.
- **Authorisation and request safety:** every resource is fetched with `teacher_id` scope, so other teachers' records return 404. State-changing requests require a custom header (CSRF defence). Rate limits are applied globally and on auth, scans and AI.
- **Headers:** Helmet with a strict Content-Security-Policy (no third-party scripts), `frame-ancestors 'none'`.
- **Input handling:** zod validation on every input, parameterised SQL everywhere, React output encoding, and CSV formula-injection guards.
- **Uploads:** content sniffed with sharp (not trusted MIME types), pixel and size limits, re-encoded to strip EXIF/GPS metadata, stored outside the web root, and served only through an authorised endpoint.
- **Accountability and data rights:** audit log for grading changes, key changes, deletions and imports; configurable photo retention; JSON data export; per-student and full-account deletion.
- **AI privacy:** the key stays server-side and only anonymised aggregates are sent. Teacher-supplied material is scrubbed of emails and long digit strings, and teachers are warned not to paste student names.
- **Philippine Data Privacy Act (RA 10173):** QuickGrade supports data minimisation (student numbers instead of LRNs on sheets, optional fields), the rights to access/portability (export) and erasure (delete), retention limits and security of processing. Schools remain the personal information controller and should register processing, sign data-sharing agreements if AI is enabled, and issue a privacy notice to learners and parents.

---

<a id="limitations-and-pending-work"></a>

## Limitations, pending work and external services

**Known limitations**

- **Real-world scanner validation is pending.** Accuracy was established on simulated photos of the real layout. Real printers (toner density, scaling), crumpled paper, glossy glare, very light pencil and low-end phone cameras need a field test with a few hundred sheets, after which the thresholds in `server/src/scanner/classify.ts` may need tuning.
- The **sheet must be QuickGrade's own format**. Other vendors' sheets (ZipGrade, Scantron) are not supported. Each quiz has at most 100 items and 5 choices, and the student ID has at most 8 digits.
- Strong lens distortion, folded corners or a missing corner marker cannot be recovered. The photo must show all four markers.
- **HEIC photos:** iPhones normally upload JPEG through the browser, but raw `.heic` files may fail to decode with the prebuilt image library. Users then get a "could not be decoded — export as JPEG" message.
- Each question has a single correct answer. "Any of these answers" keys and bonus items are not supported; use *Exclude* to drop an item.
- **Single-server SQLite:** suits one school or a district server (thousands of students). For multi-instance horizontal scaling, migrate to Postgres and object storage.
- **No offline mode** or service worker: scanning requires a connection to the server.
- **Not tested here:** real SMTP delivery, live AI calls, building the Docker image, and the camera on physical devices.

**Future improvements**

- Live, in-browser marker detection in the camera view with auto-capture (the scanner core is plain TypeScript and could run in a Web Worker).
- Offline capture queue with idempotent sync (the server already deduplicates by image hash).
- School/organisation accounts with shared classes and an admin role; LMS / Google Classroom export.
- Multiple-answer keys, bonus questions, item banks and versioned (shuffled) forms.
- Postgres and S3-compatible storage adapters; OCR of handwritten names as an extra check.

**External services**

| Service | Needed for | Required? |
|---|---|---|
| Anthropic API key | AI features | Optional |
| SMTP server (e.g. Google Workspace, SES, Mailgun) | Password-reset emails | Recommended in production (dev logs the link) |
| HTTPS (reverse proxy / platform TLS) | Secure cookies; camera on phones | Required in production |
| Persistent disk + backups | Database and images | Required |

---

## Project layout

```
shared/            Code used by both server and browser
  sheet/layout.ts    Answer-sheet geometry (single source of truth)
  sheet/code.ts      Sheet code encoding + CRC
  grading.ts         Deterministic grading engine and key validation
  analytics.ts       Statistics and item analysis
  scan-types.ts      Scanner result types
server/
  migrations/        SQL migrations
  src/app.ts         Fastify app (plugins, security, error handling, routes)
  src/routes/        auth, settings, classes, students, quizzes, sessions, scans, submissions, dashboard, ai
  src/services/      grading persistence, CSV parsing, audit/mail/storage/retention
  src/scanner/       image utils, geometry, marker detection, classification, pipeline
  src/pdf/           answer sheets, answer keys, session reports
  src/ai/            provider interface, Anthropic provider, schemas + validation, features
  src/cli.ts         migrate | retention | backup
web/               React app (pages, components, charts, camera)
tests/             Vitest suites + synthetic photo generator
e2e/               Playwright tests
scripts/           sample sheet / photo generator
docs/              Guides
```
