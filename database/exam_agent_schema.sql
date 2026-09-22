-- ============================================================
-- Exam Agent Database Schema
-- MySQL 8.0+ (requires CHECK constraint + expression DEFAULT support)
-- ============================================================
-- Notes on the Postgres -> MySQL conversion:
--   * UUID: MySQL has no native UUID type. We use CHAR(36) with
--     DEFAULT (UUID()) (MySQL 8.0.13+ allows expression defaults).
--     If you're on an older MySQL, generate UUIDs in application code
--     instead and drop the DEFAULT clause.
--   * Arrays / JSONB: Postgres TEXT[] and JSONB both become JSON.
--   * pgvector: MySQL (pre-9.0) has no native vector type or ANN
--     index. The embedding column below is stored as JSON (an array
--     of floats). Similarity search (cosine/dot-product) has to be
--     done in application code, or you offload it to a dedicated
--     vector store (e.g. Milvus, Qdrant, pgvector on a side Postgres
--     instance) and just keep a reference ID here. If you're on
--     MySQL 9.0+, you can swap the JSON column for the native VECTOR
--     type and use VEC_COSINE_DISTANCE() / a vector index instead.
--   * TIMESTAMPTZ -> DATETIME (MySQL's TIMESTAMP maxes out in 2038
--     and has no real timezone storage; DATETIME is the safer match).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

-- ------------------------------------------------------------
-- People
-- ------------------------------------------------------------

CREATE TABLE professors (
    id         CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    email      VARCHAR(255) NOT NULL UNIQUE,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE students (
    id         CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    email      VARCHAR(255) NOT NULL UNIQUE,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Exam templates (set up by a professor, reused across students)
-- ------------------------------------------------------------

CREATE TABLE exam_templates (
    id                       CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    professor_id             CHAR(36)     NOT NULL,
    title                    VARCHAR(255) NOT NULL,
    topic_coverage_required  JSON,                 -- e.g. ["recursion","big-o","sorting"]
    rubric                   JSON         NOT NULL, -- criterion -> weight / description
    difficulty_curve         VARCHAR(100),          -- e.g. 'adaptive', 'fixed-easy-to-hard'
    time_limit_minutes       INT,
    created_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_templates_professor
        FOREIGN KEY (professor_id) REFERENCES professors(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Question bank
-- ------------------------------------------------------------

CREATE TABLE questions (
    id               CHAR(36)   NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    professor_id     CHAR(36)   NOT NULL,
    exam_template_id CHAR(36),
    question_text    TEXT       NOT NULL,
    topic            VARCHAR(255),
    difficulty       TINYINT    CHECK (difficulty BETWEEN 1 AND 5),
    embedding        JSON,      -- array of floats; see note at top re: pgvector
    created_at       DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_questions_professor
        FOREIGN KEY (professor_id) REFERENCES professors(id),
    CONSTRAINT fk_questions_template
        FOREIGN KEY (exam_template_id) REFERENCES exam_templates(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- No ANN index equivalent to ivfflat here — see note at top of file.

-- ------------------------------------------------------------
-- Exam sessions (one row per student attempt)
-- ------------------------------------------------------------

CREATE TABLE exam_sessions (
    id                   CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    student_id           CHAR(36) NOT NULL,
    exam_template_id     CHAR(36) NOT NULL,
    status               VARCHAR(20) NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress','pending_grading','graded','flagged','abandoned')),
    video_file_ref       VARCHAR(1024),   -- path/URL to stored video (object storage, not this DB)
    transcript_file_ref  VARCHAR(1024),   -- path/URL to full transcript file
    started_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at             DATETIME,
    CONSTRAINT fk_sessions_student
        FOREIGN KEY (student_id) REFERENCES students(id),
    CONSTRAINT fk_sessions_template
        FOREIGN KEY (exam_template_id) REFERENCES exam_templates(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Interactions (each turn of the live conversation)
-- ------------------------------------------------------------

CREATE TABLE interactions (
    id                        CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    session_id                CHAR(36) NOT NULL,
    sequence_num              INT      NOT NULL,
    question_text             TEXT     NOT NULL,
    question_source           VARCHAR(20) NOT NULL CHECK (question_source IN ('bank','generated')),
    source_question_id        CHAR(36),          -- null if freshly generated
    student_answer_transcript TEXT,
    answer_timestamp_start    DECIMAL(10,3),     -- seconds into the video
    answer_timestamp_end      DECIMAL(10,3),
    model_reasoning           TEXT,              -- why the model chose this next question (auditability)
    created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_interactions_session
        FOREIGN KEY (session_id) REFERENCES exam_sessions(id) ON DELETE CASCADE,
    CONSTRAINT fk_interactions_question
        FOREIGN KEY (source_question_id) REFERENCES questions(id),
    CONSTRAINT uq_session_sequence UNIQUE (session_id, sequence_num)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Grades (per rubric criterion, tied to a session)
-- The professor is the one who grades — the model only conducts
-- the exam and records data. model_suggested_score is optional
-- and purely a reference point for the professor, never final.
-- ------------------------------------------------------------

CREATE TABLE grades (
    id                    CHAR(36)      NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    session_id            CHAR(36)      NOT NULL,
    professor_id          CHAR(36)      NOT NULL,
    rubric_criterion      VARCHAR(255)  NOT NULL,
    score                 DECIMAL(6,2),           -- null until the professor grades it
    max_score             DECIMAL(6,2)  NOT NULL,
    model_suggested_score DECIMAL(6,2),           -- optional reference only, never authoritative
    professor_notes       TEXT,
    graded_at             DATETIME,               -- null until the professor submits a grade
    created_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_grades_session
        FOREIGN KEY (session_id) REFERENCES exam_sessions(id) ON DELETE CASCADE,
    CONSTRAINT fk_grades_professor
        FOREIGN KEY (professor_id) REFERENCES professors(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Integrity events (proctoring signals, logged not just recorded on video)
-- ------------------------------------------------------------

CREATE TABLE integrity_events (
    id              CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    session_id      CHAR(36) NOT NULL,
    event_type      VARCHAR(100) NOT NULL, -- e.g. 'off_camera', 'long_pause', 'multiple_voices'
    event_timestamp DECIMAL(10,3),         -- seconds into the video
    severity        TINYINT CHECK (severity BETWEEN 1 AND 5),
    notes           TEXT,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_integrity_session
        FOREIGN KEY (session_id) REFERENCES exam_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Helpful indexes
-- ------------------------------------------------------------

CREATE INDEX idx_sessions_student   ON exam_sessions(student_id);
CREATE INDEX idx_sessions_template  ON exam_sessions(exam_template_id);
CREATE INDEX idx_interactions_session ON interactions(session_id);
CREATE INDEX idx_grades_session     ON grades(session_id);
CREATE INDEX idx_integrity_session  ON integrity_events(session_id);
