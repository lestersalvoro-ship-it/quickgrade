# Security and privacy

## Controls in place

| Area | Control |
|---|---|
| Passwords | scrypt (N=32768, r=8, p=1, 64-byte key, random salt), NFKC-normalised; min. 10 characters with letters plus digits/symbols; constant-time verification; dummy hash for unknown emails (no timing-based account enumeration) |
| Sessions | 256-bit random token in an HttpOnly, SameSite=Lax cookie (Secure in production); only its SHA-256 is stored; 14-day sliding expiry; revoked on logout, password change (other devices) and reset (all devices) |
| Password reset | 1-hour single-use token (hashed); identical response whether or not the email exists; rate-limited |
| CSRF | All non-GET API requests require the `x-quickgrade-csrf` header, which cross-site pages cannot send without CORS (none is configured); plus SameSite cookies |
| Authorisation | Every lookup is scoped by `teacher_id`; cross-teacher access returns 404; covered by tests |
| Input validation | zod schemas on every body/query/param; DB CHECK/UNIQUE/FK constraints as a second line |
| Injection | Parameterised SQL only; LIKE wildcards escaped; React escapes output; CSV cells starting with `= + - @` are prefixed |
| Headers | Helmet: strict CSP (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), HSTS, noSniff, etc. |
| Uploads | Size limit (`MAX_UPLOAD_MB`), pixel limit, content sniffing with sharp, re-encoding (strips EXIF/GPS), random file names in a private directory, path-traversal guard, served only to the owning teacher |
| Rate limiting | 600 req/min/IP globally; auth 10/min; reset 5/15 min; scans 60/min; AI 10/min plus daily and monthly AI caps |
| Secrets | Environment variables only; `.env` is git-ignored; the AI key is never sent to the browser |
| Audit | Account events, imports, quiz/key changes (with regrade counts), result saves, replacements, corrections (before/after, reason), deletions |
| Integrity | Transactions for multi-row changes; one result per student per session (UNIQUE); duplicate photos rejected per session |

## Privacy and the Philippine Data Privacy Act (RA 10173)

QuickGrade processes learners' names, student numbers, optional LRN/email, answers and scores, plus photos of answer sheets. The school (or the teacher) is the **personal information controller**; the QuickGrade server operator is the processor.

How QuickGrade supports compliance:

- **Data minimisation:** only names and a short student number are required; LRN and email are optional. Sheets carry the short number, not the LRN.
- **Purpose limitation:** data is used only for grading and reporting to the teacher.
- **Retention:** scan photos are deleted N days after confirmation (configurable; 0 = immediately). Expired sessions and reset tokens are purged.
- **Rights of data subjects:** export everything as JSON (Settings); delete a student and all of their results; delete the whole account.
- **Third parties:** no data leaves the server unless AI is enabled, and then only anonymised aggregates plus teacher-authored question text.
- **Security of processing:** see the table above; run behind HTTPS and keep backups encrypted.

What the deploying school should do: register/record processing per NPC rules, appoint a DPO, publish a privacy notice to learners and parents, sign a data-sharing or outsourcing agreement covering the hosting provider and (if used) the AI provider, encrypt backups, and restrict server access.

## Reporting a vulnerability

Report security issues privately to the maintainers instead of opening a public issue.
