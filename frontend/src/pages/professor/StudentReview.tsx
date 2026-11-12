import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";

type Interaction = {
  sequence_num: number;
  question_source: string | null;
  question_text: string | null;
  student_answer_transcript: string | null;
  model_reasoning: string | null;
};

type Grade = {
  rubric_criterion: string;
  max_score: number;
  model_suggested_score: number | null;
  score: number | null;
  professor_notes: string | null;
  graded_at: string | null;
};

type IntegrityEvent = {
  event_type: string;
  event_timestamp: string | number | null;
  severity: number | null;
  notes: string | null;
};

type Report = {
  session: {
    id: string;
    status: string;
    started_at: string | null;
    ended_at: string | null;
    student_id: string;
    video_file_ref?: string | null;
    transcript_file_ref?: string | null;
  };
  interactions: Interaction[];
  grades: Grade[];
  integrity_events: IntegrityEvent[];
};

function dateLabel(value: string | null | number) {
  if (value === null || value === undefined) return "—";
  const date = typeof value === "number"
    ? new Date(value > 100000000000 ? value : value * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function rationale(value: string | null) {
  return (value || "").split("\n")
    .filter(line => line.startsWith("[AI rationale]"))
    .map(line => line.replace("[AI rationale]", "").trim())
    .join("\n");
}

function cleanNotes(value: string | null) {
  return (value || "").split("\n")
    .filter(line => !line.startsWith("[AI rationale]"))
    .join("\n").trim();
}

function humanize(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

export default function StudentReview({
  examId, sessionId,
}: { examId: string; sessionId: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/exam/${encodeURIComponent(sessionId)}/report`,
        { credentials: "include" }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to load report.");

      const result = data as Report;
      setReport(result);
      const nextScores: Record<string, string> = {};
      const nextNotes: Record<string, string> = {};

      for (const grade of result.grades || []) {
        const score = grade.score ?? grade.model_suggested_score;
        nextScores[grade.rubric_criterion] =
          score === null || score === undefined ? "" : String(score);
        nextNotes[grade.rubric_criterion] = cleanNotes(grade.professor_notes);
      }
      setScores(nextScores);
      setNotes(nextNotes);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to load report.");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void loadReport(); }, [loadReport]);

  async function generateSuggestions() {
    setGenerating(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/exam/grade", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Grading generation failed.");
      await loadReport();
      setMessage(data.note || "AI suggestions generated. Professor confirmation is required.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Grading generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  async function saveGrades() {
    if (!report) return;
    setError("");
    setMessage("");
    const grades = [];

    for (const grade of report.grades) {
      const raw = scores[grade.rubric_criterion] ?? "";
      const score = raw.trim() === "" ? null : Number(raw);

      if (score === null && grade.model_suggested_score === null) {
        setError(`Enter a score for "${grade.rubric_criterion}".`);
        return;
      }
      if (score !== null &&
        (!Number.isFinite(score) || score < 0 || score > Number(grade.max_score))) {
        setError(`Score for "${grade.rubric_criterion}" must be between 0 and ${grade.max_score}.`);
        return;
      }
      grades.push({
        rubric_criterion: grade.rubric_criterion,
        score,
        professor_notes: notes[grade.rubric_criterion] ?? "",
      });
    }

    setSaving(true);
    try {
      const response = await fetch(
        `/api/exam/${encodeURIComponent(sessionId)}/grades`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grades }),
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to save grades.");
      await loadReport();
      setMessage(data.session_status === "graded"
        ? "All grades saved. The examination is now marked graded."
        : "Grading changes saved.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to save grades.");
    } finally {
      setSaving(false);
    }
  }

  const canGenerate = report && report.grades.length === 0 &&
    ["pending_grading", "flagged"].includes(report.session.status);

  return (
    <div className="professor-dashboard-page student-review-page">
      <header className="simple-header">
        <div className="logo">
          <span className="logo-icon" aria-hidden="true"><span>OE</span></span>
          <span>OralExam AI</span>
        </div>
      </header>

      <main className="student-review-content">
        <a className="student-review-back"
          href={`/professor/exams/${encodeURIComponent(examId)}/submissions`}>
          <ArrowLeft size={17} /> Back to student roster
        </a>

        <section className="student-review-heading">
          <div>
            <p className="eyebrow">PROFESSOR REVIEW</p>
            <h1>Student examination review</h1>
            <p>Review submitted answers, inspect integrity events, and confirm assessment scores.</p>
          </div>
          <button type="button" className="student-review-refresh"
            onClick={() => void loadReport()} disabled={loading}>
            <RefreshCw size={16} /> Refresh
          </button>
        </section>

        {loading && <div className="student-review-state" role="status">
          <LoaderCircle size={22} className="student-review-spinner" /> Loading report...
        </div>}
        {error && <div className="student-review-alert" role="alert">{error}</div>}
        {message && <div className="student-review-success" role="status">
          <CheckCircle2 size={18} /> {message}
        </div>}

        {!loading && report && <>
          <section className="student-review-overview">
            <div><span>Session ID</span><strong>{report.session.id}</strong></div>
            <div><span>Student ID</span><strong>{report.session.student_id}</strong></div>
            <div><span>Status</span><strong>{humanize(report.session.status)}</strong></div>
            <div><span>Started</span><strong>{dateLabel(report.session.started_at)}</strong></div>
            <div><span>Completed</span><strong>{dateLabel(report.session.ended_at)}</strong></div>
          </section>

          <section className="student-review-section">
            <div className="student-review-section-heading">
              <div><p className="eyebrow">EXAM EVIDENCE</p><h2>Questions and student answers</h2></div>
              <span>{report.interactions.length} responses</span>
            </div>
            {report.interactions.length === 0
              ? <p className="student-review-empty">No question interactions were found.</p>
              : <div className="student-review-interactions">
                {report.interactions.map(item => <article
                  className="student-review-interaction" key={item.sequence_num}>
                  <div className="student-review-question-meta">
                    <strong>Question {item.sequence_num}</strong>
                    <span>{item.question_source || "Exam question"}</span>
                  </div>
                  <h3>{item.question_text || "Question text unavailable"}</h3>
                  <div className="student-review-answer">
                    <h4>Student answer transcript</h4>
                    <p>{item.student_answer_transcript || "No transcript was saved."}</p>
                  </div>
                  {item.model_reasoning && <details className="student-review-reasoning">
                    <summary>View AI analysis</summary><p>{item.model_reasoning}</p>
                  </details>}
                </article>)}
              </div>}
            <div className="student-review-recording-note">
              Recording playback is not currently exposed by the report API. Saved transcripts are displayed above.
            </div>
          </section>

          <section className="student-review-section">
            <div className="student-review-section-heading">
              <div><p className="eyebrow">ASSESSMENT</p><h2>Grading and professor confirmation</h2></div>
              <span>{report.grades.length} criteria</span>
            </div>
            {canGenerate && <div className="student-review-generate">
              <div><strong>Generate preliminary AI grading</strong>
                <p>AI suggestions are preliminary. You must review and confirm the scores.</p></div>
              <button type="button" onClick={() => void generateSuggestions()} disabled={generating}>
                {generating ? <LoaderCircle size={17} className="student-review-spinner" /> : <Sparkles size={17} />}
                {generating ? "Generating..." : "Generate suggestions"}
              </button>
            </div>}
            {report.grades.length === 0
              ? <p className="student-review-empty">No grading criteria have been generated yet.</p>
              : <>
                <div className="student-review-grades">
                  {report.grades.map(grade => <article
                    className="student-review-grade" key={grade.rubric_criterion}>
                    <div className="student-review-grade-heading">
                      <h3>{grade.rubric_criterion}</h3><span>Maximum: {grade.max_score}</span>
                    </div>
                    {rationale(grade.professor_notes) && <div className="student-review-rationale">
                      <strong>AI rationale</strong><p>{rationale(grade.professor_notes)}</p>
                    </div>}
                    <label>Confirmed score
                      <span className="student-review-score-input">
                        <input type="number" min="0" max={grade.max_score} step="any"
                          value={scores[grade.rubric_criterion] ?? ""}
                          onChange={event => setScores(old => ({
                            ...old, [grade.rubric_criterion]: event.target.value,
                          }))} />
                        <span>/ {grade.max_score}</span>
                      </span>
                    </label>
                    <label>Professor feedback
                      <textarea rows={3}
                        value={notes[grade.rubric_criterion] ?? ""}
                        onChange={event => setNotes(old => ({
                          ...old, [grade.rubric_criterion]: event.target.value,
                        }))}
                        placeholder="Add your assessment notes..." />
                    </label>
                  </article>)}
                </div>
                <div className="student-review-save">
                  <p>Saving confirms the scores submitted above. The examination is marked graded when every criterion has a score.</p>
                  <button type="button" onClick={() => void saveGrades()} disabled={saving || loading}>
                    {saving ? <LoaderCircle size={17} className="student-review-spinner" /> : <CheckCircle2 size={17} />}
                    {saving ? "Saving..." : "Save and confirm grades"}
                  </button>
                </div>
              </>}
          </section>

          <section className="student-review-section">
            <div className="student-review-section-heading">
              <div><p className="eyebrow">PROCTORING</p><h2>Integrity events</h2></div>
              <span>{report.integrity_events.length} events</span>
            </div>
            {report.integrity_events.length === 0
              ? <p className="student-review-empty">No integrity events were recorded.</p>
              : <div className="student-review-events">
                {report.integrity_events.map((event, index) => <article
                  className="student-review-event" key={`${event.event_type}-${index}`}>
                  <div><strong>{humanize(event.event_type)}</strong>
                    <span>{dateLabel(event.event_timestamp)}</span></div>
                  <span>Severity: {event.severity ?? "—"}</span>
                  {event.notes && <p>{event.notes}</p>}
                </article>)}
              </div>}
          </section>

        </>}
      </main>
    </div>
  );
}
