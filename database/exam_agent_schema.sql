-- ============================================================
-- Exam Agent Database Schema
-- Postgres + pgvector (for future embedding/RAG use with Ollama)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------
-- People
-- ------------------------------------------------------------

CREATE TABLE professors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE students (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Exam templates (set up by a professor, reused across students)
-- ------------------------------------------------------------

CREATE TABLE exam_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    professor_id UUID NOT NULL REFERENCES professors(id),
    title TEXT NOT NULL,
    topic_coverage_required TEXT[],      -- e.g. {'recursion','big-o','sorting'}
    rubric JSONB NOT NULL,               -- criterion -> weight / description
    difficulty_curve TEXT,               -- e.g. 'adaptive', 'fixed-easy-to-hard'
    time_limit_minutes INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Question bank
-- ------------------------------------------------------------

CREATE TABLE questions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    professor_id UUID NOT NULL REFERENCES professors(id),
    exam_template_id UUID REFERENCES exam_templates(id),
    question_text TEXT NOT NULL,
    topic TEXT,
    difficulty SMALLINT CHECK (difficulty BETWEEN 1 AND 5),
    embedding VECTOR(768),               -- match your Ollama embedding model's dimension
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- similarity search index (for retrieving related/follow-up questions)
--  CREATE INDEX ON questions USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ------------------------------------------------------------
-- Exam sessions (one row per student attempt)
-- ------------------------------------------------------------

CREATE TABLE exam_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID NOT NULL REFERENCES students(id),
    exam_template_id UUID NOT NULL REFERENCES exam_templates(id),
    status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress','pending_grading','graded','flagged','abandoned')),
    video_file_ref TEXT,                 -- path/URL to stored video (object storage, not this DB)
    transcript_file_ref TEXT,            -- path/URL to full transcript file
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ
);

-- ------------------------------------------------------------
-- Interactions (each turn of the live conversation)
-- ------------------------------------------------------------

CREATE TABLE interactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
    sequence_num INT NOT NULL,
    question_text TEXT NOT NULL,
    question_source TEXT NOT NULL CHECK (question_source IN ('bank','generated')),
    source_question_id UUID REFERENCES questions(id),  -- null if freshly generated
    student_answer_transcript TEXT,
    answer_timestamp_start NUMERIC,      -- seconds into the video
    answer_timestamp_end NUMERIC,
    model_reasoning TEXT,                -- why the model chose this next question (auditability)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, sequence_num)
);

-- ------------------------------------------------------------
-- Grades (per rubric criterion, tied to a session)
-- The professor is the one who grades — the model only conducts
-- the exam and records data. model_suggested_score is optional
-- and purely a reference point for the professor, never final.
-- ------------------------------------------------------------

CREATE TABLE grades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
    professor_id UUID NOT NULL REFERENCES professors(id),
    rubric_criterion TEXT NOT NULL,
    score NUMERIC,                        -- null until the professor grades it
    max_score NUMERIC NOT NULL,
    model_suggested_score NUMERIC,        -- optional reference only, never authoritative
    professor_notes TEXT,
    graded_at TIMESTAMPTZ,                -- null until the professor submits a grade
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Integrity events (proctoring signals, logged not just recorded on video)
-- ------------------------------------------------------------

CREATE TABLE integrity_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,            -- e.g. 'off_camera', 'long_pause', 'multiple_voices'
    event_timestamp NUMERIC,             -- seconds into the video
    severity SMALLINT CHECK (severity BETWEEN 1 AND 5),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Helpful indexes
-- ------------------------------------------------------------

CREATE INDEX idx_sessions_student ON exam_sessions(student_id);
CREATE INDEX idx_sessions_template ON exam_sessions(exam_template_id);
CREATE INDEX idx_interactions_session ON interactions(session_id);
CREATE INDEX idx_grades_session ON grades(session_id);
CREATE INDEX idx_integrity_session ON integrity_events(session_id);
