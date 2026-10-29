-- QuickGrade initial schema.
-- All timestamps are UTC ISO-8601 strings (e.g. 2026-10-29T04:12:33.120Z); the UI renders local time.

CREATE TABLE users (
  id                    INTEGER PRIMARY KEY,
  email                 TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  password_hash         TEXT    NOT NULL,
  full_name             TEXT    NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
  school_name           TEXT    CHECK (school_name IS NULL OR length(school_name) <= 160),
  default_pass_percent  REAL    NOT NULL DEFAULT 75 CHECK (default_pass_percent BETWEEN 0 AND 100),
  -- Days to keep original scan photos after a result is confirmed. 0 = delete immediately on confirmation.
  image_retention_days  INTEGER NOT NULL DEFAULT 30 CHECK (image_retention_days BETWEEN 0 AND 3650),
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE auth_sessions (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT    NOT NULL UNIQUE,
  user_agent    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT    NOT NULL
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE password_resets (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT    NOT NULL UNIQUE,
  expires_at  TEXT    NOT NULL,
  used_at     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE classes (
  id           INTEGER PRIMARY KEY,
  teacher_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  section      TEXT    CHECK (section IS NULL OR length(section) <= 60),
  subject      TEXT    CHECK (subject IS NULL OR length(subject) <= 100),
  school_year  TEXT    CHECK (school_year IS NULL OR length(school_year) <= 20),
  archived_at  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_classes_teacher ON classes(teacher_id);
CREATE UNIQUE INDEX uq_classes_active_name ON classes(teacher_id, name COLLATE NOCASE, ifnull(section, '') COLLATE NOCASE) WHERE archived_at IS NULL;

CREATE TABLE students (
  id              INTEGER PRIMARY KEY,
  teacher_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The number bubbled on answer sheets: 1–8 digits, stored without leading zeros.
  student_number  TEXT    NOT NULL CHECK (
                    length(student_number) BETWEEN 1 AND 8
                    AND student_number NOT GLOB '*[^0-9]*'
                    AND (student_number = '0' OR substr(student_number, 1, 1) <> '0')),
  first_name      TEXT    NOT NULL CHECK (length(first_name) BETWEEN 1 AND 80),
  last_name       TEXT    NOT NULL CHECK (length(last_name) BETWEEN 1 AND 80),
  external_id     TEXT    CHECK (external_id IS NULL OR length(external_id) <= 40),
  email           TEXT    CHECK (email IS NULL OR length(email) <= 200),
  archived_at     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (teacher_id, student_number)
);
CREATE INDEX idx_students_name ON students(teacher_id, last_name, first_name);

CREATE TABLE enrollments (
  class_id     INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  enrolled_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (class_id, student_id)
);
CREATE INDEX idx_enrollments_student ON enrollments(student_id);

CREATE TABLE quizzes (
  id              INTEGER PRIMARY KEY,
  teacher_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  subject         TEXT    CHECK (subject IS NULL OR length(subject) <= 100),
  description     TEXT    CHECK (description IS NULL OR length(description) <= 2000),
  instructions    TEXT    CHECK (instructions IS NULL OR length(instructions) <= 2000),
  question_count  INTEGER NOT NULL CHECK (question_count BETWEEN 1 AND 100),
  choice_count    INTEGER NOT NULL CHECK (choice_count BETWEEN 2 AND 5),
  -- Random identifier printed in the sheet code strip; globally unique so a sheet maps to exactly one quiz.
  sheet_code      INTEGER NOT NULL UNIQUE CHECK (sheet_code BETWEEN 1 AND 1048575),
  -- Grading rules.
  pass_percent    REAL    CHECK (pass_percent IS NULL OR pass_percent BETWEEN 0 AND 100),
  wrong_penalty   REAL    NOT NULL DEFAULT 0 CHECK (wrong_penalty BETWEEN 0 AND 10),
  penalize_blank  INTEGER NOT NULL DEFAULT 0 CHECK (penalize_blank IN (0, 1)),
  multiple_policy TEXT    NOT NULL DEFAULT 'incorrect' CHECK (multiple_policy IN ('incorrect', 'blank')),
  floor_at_zero   INTEGER NOT NULL DEFAULT 1 CHECK (floor_at_zero IN (0, 1)),
  source          TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai_assisted', 'duplicate')),
  archived_at     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_quizzes_teacher ON quizzes(teacher_id);

-- One row per question; correct_choice is the answer key (0 = A … 4 = E).
CREATE TABLE questions (
  id              INTEGER PRIMARY KEY,
  quiz_id         INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  number          INTEGER NOT NULL CHECK (number BETWEEN 1 AND 100),
  correct_choice  INTEGER CHECK (correct_choice IS NULL OR correct_choice BETWEEN 0 AND 4),
  points          REAL    NOT NULL DEFAULT 1 CHECK (points > 0 AND points <= 100),
  excluded        INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  topic           TEXT    CHECK (topic IS NULL OR length(topic) <= 100),
  prompt          TEXT    CHECK (prompt IS NULL OR length(prompt) <= 2000),
  -- Optional display text of each choice, a JSON array of strings validated by the API.
  choices_json    TEXT    CHECK (choices_json IS NULL OR json_valid(choices_json)),
  explanation     TEXT    CHECK (explanation IS NULL OR length(explanation) <= 4000),
  UNIQUE (quiz_id, number)
);

CREATE TABLE grading_sessions (
  id           INTEGER PRIMARY KEY,
  teacher_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quiz_id      INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE RESTRICT,
  class_id     INTEGER NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  name         TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  held_on      TEXT    CHECK (held_on IS NULL OR held_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  archived_at  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_sessions_teacher ON grading_sessions(teacher_id, created_at);
CREATE INDEX idx_sessions_quiz ON grading_sessions(quiz_id);
CREATE INDEX idx_sessions_class ON grading_sessions(class_id);

CREATE TABLE submissions (
  id               INTEGER PRIMARY KEY,
  session_id       INTEGER NOT NULL REFERENCES grading_sessions(id) ON DELETE CASCADE,
  student_id       INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  source           TEXT    NOT NULL CHECK (source IN ('scan', 'manual')),
  raw_score        REAL    NOT NULL,
  total_points     REAL    NOT NULL CHECK (total_points > 0),
  percent          REAL    NOT NULL CHECK (percent BETWEEN -1000 AND 100),
  correct_count    INTEGER NOT NULL CHECK (correct_count >= 0),
  incorrect_count  INTEGER NOT NULL CHECK (incorrect_count >= 0),
  blank_count      INTEGER NOT NULL CHECK (blank_count >= 0),
  multiple_count   INTEGER NOT NULL CHECK (multiple_count >= 0),
  passed           INTEGER NOT NULL CHECK (passed IN (0, 1)),
  teacher_edits    INTEGER NOT NULL DEFAULT 0 CHECK (teacher_edits >= 0),
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- A student has at most one result per grading session.
  UNIQUE (session_id, student_id)
);
CREATE INDEX idx_submissions_student ON submissions(student_id);

CREATE TABLE responses (
  submission_id       INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_number     INTEGER NOT NULL CHECK (question_number BETWEEN 1 AND 100),
  response_status     TEXT    NOT NULL CHECK (response_status IN ('answered', 'blank', 'multiple')),
  choice              INTEGER CHECK (choice IS NULL OR choice BETWEEN 0 AND 4),
  -- Bitmask of marked choices (bit 0 = A); for 'multiple' it records which bubbles were filled.
  marked_mask         INTEGER NOT NULL DEFAULT 0 CHECK (marked_mask BETWEEN 0 AND 31),
  is_correct          INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
  points_awarded      REAL    NOT NULL,
  scanner_status      TEXT    CHECK (scanner_status IS NULL OR scanner_status IN ('ok', 'blank', 'multiple', 'ambiguous')),
  scanner_confidence  REAL    CHECK (scanner_confidence IS NULL OR scanner_confidence BETWEEN 0 AND 1),
  teacher_override    INTEGER NOT NULL DEFAULT 0 CHECK (teacher_override IN (0, 1)),
  PRIMARY KEY (submission_id, question_number),
  CHECK ((response_status = 'answered') = (choice IS NOT NULL))
);

CREATE TABLE scans (
  id                       INTEGER PRIMARY KEY,
  teacher_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id               INTEGER NOT NULL REFERENCES grading_sessions(id) ON DELETE CASCADE,
  status                   TEXT    NOT NULL CHECK (status IN ('pending', 'confirmed', 'discarded', 'failed')),
  image_sha256             TEXT    NOT NULL,
  image_path               TEXT,
  rectified_path           TEXT,
  error_code               TEXT,
  detected_student_number  TEXT,
  flagged_count            INTEGER NOT NULL DEFAULT 0,
  -- Full scanner diagnostics (fills, confidences, quality metrics). Grades never depend on this blob.
  result_json              TEXT    CHECK (result_json IS NULL OR json_valid(result_json)),
  submission_id            INTEGER REFERENCES submissions(id) ON DELETE SET NULL,
  created_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  confirmed_at             TEXT,
  image_deleted_at         TEXT
);
CREATE INDEX idx_scans_session ON scans(session_id, status);
-- The same photo cannot be uploaded twice into one grading session (unless the earlier upload was discarded or failed).
CREATE UNIQUE INDEX uq_scans_image ON scans(session_id, image_sha256) WHERE status IN ('pending', 'confirmed');

CREATE TABLE audit_logs (
  id           INTEGER PRIMARY KEY,
  teacher_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type  TEXT    NOT NULL,
  entity_id    INTEGER,
  action       TEXT    NOT NULL,
  summary      TEXT    NOT NULL,
  details_json TEXT    CHECK (details_json IS NULL OR json_valid(details_json)),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_audit_teacher ON audit_logs(teacher_id, created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

CREATE TABLE ai_requests (
  id             INTEGER PRIMARY KEY,
  teacher_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature        TEXT    NOT NULL CHECK (feature IN ('insights', 'questions', 'practice', 'explanation', 'quiz_draft')),
  status         TEXT    NOT NULL CHECK (status IN ('ok', 'error', 'rejected')),
  model          TEXT,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL    NOT NULL DEFAULT 0,
  quiz_id        INTEGER REFERENCES quizzes(id) ON DELETE SET NULL,
  session_id     INTEGER REFERENCES grading_sessions(id) ON DELETE SET NULL,
  -- Validated AI output kept so teachers can revisit it; never used to compute grades.
  output_json    TEXT    CHECK (output_json IS NULL OR json_valid(output_json)),
  error          TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_ai_teacher ON ai_requests(teacher_id, created_at);
