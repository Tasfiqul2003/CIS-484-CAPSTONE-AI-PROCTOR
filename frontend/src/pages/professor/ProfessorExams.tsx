
import { useEffect, useState } from "react";

type Exam = {
  id: string;
  title: string;
  course: string;
  description: string | null;
  icon: string | null;
  created_at: string | null;
  status: "draft" | "published";
  question_count: number;
  submission_count: number;
};

function getErrorMessage(data: any, fallback: string): string {
  const detail = data?.detail;

  if (typeof detail === "string") {
    return detail;
  }

  if (Array.isArray(detail)) {
    return detail
      .map((item) =>
        typeof item === "string"
          ? item
          : item?.msg || JSON.stringify(item)
      )
      .join("; ");
  }

  if (detail && typeof detail === "object") {
    return detail.message || JSON.stringify(detail);
  }

  return fallback;
}

export default function ProfessorExams() {
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [course, setCourse] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedIcon, setSelectedIcon] = useState("🎙️");

  async function loadExams() {
    const response = await fetch("/api/auth/professor/exams", {
      credentials: "include",
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        window.location.href = "/professor/login";
        return;
      }

      throw new Error(
        getErrorMessage(data, "Unable to load your examinations.")
      );
    }

    setExams(data ?? []);
  }

  useEffect(() => {
    async function initialize() {
      try {
        setError("");

        const userResponse = await fetch("/api/auth/me", {
          credentials: "include",
        });

        if (!userResponse.ok) {
          window.location.href = "/professor/login";
          return;
        }

        const user = await userResponse.json();

        if (user.role !== "professor") {
          setError("This account does not have professor access.");
          return;
        }

        await loadExams();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to connect to the server."
        );
      } finally {
        setLoading(false);
      }
    }

    initialize();
  }, []);

  async function deleteExam(exam: Exam) {
    const confirmed = window.confirm(
      `Delete "${exam.title}"? This cannot be undone. Exams with student sessions cannot be deleted.`
    );

    if (!confirmed) return;

    setSaving(true);
    setError("");

    try {
      const response = await fetch(`/api/exam/templates/${exam.id}`, {
        method: "DELETE",
        credentials: "include",
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          getErrorMessage(data, "Unable to delete this exam.")
        );
      }

      await loadExams();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to delete this exam."
      );
    } finally {
      setSaving(false);
    }
  }

  async function togglePublication(exam: Exam) {
    setSaving(true);
    setError("");

    try {
      const action = exam.status === "published" ? "unpublish" : "publish";
      const response = await fetch(
        `/api/exam/templates/${exam.id}/${action}`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          getErrorMessage(data, `Unable to ${action} this exam.`)
        );
      }

      await loadExams();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to update exam status."
      );
    } finally {
      setSaving(false);
    }
  }

  async function createExam() {
    if (!course.trim() || !name.trim()) {
      setError("Please enter a course and exam name.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const response = await fetch("/api/exam/templates", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          course: course.trim(),
          title: name.trim(),
          description: description.trim(),
          icon: selectedIcon,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          getErrorMessage(data, "Unable to create the examination.")
        );
      }

      // Reload the database-backed list.
      await loadExams();

      setCourse("");
      setName("");
      setDescription("");
      setSelectedIcon("🎙️");
      setShowCreate(false);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to create the examination."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="professor-exams-page">
      <header className="simple-header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>

        <button
          type="button"
          className="dashboard-logout"
          onClick={async () => {
            try {
              await fetch("/api/auth/logout", {
                method: "POST",
                credentials: "include",
              });
            } finally {
              window.location.href = "/professor/login";
            }
          }}
        >
          Log Out
        </button>
      </header>

      <main className="professor-exams-content">
        <div className="professor-exams-heading">
          <div>
            <p className="eyebrow">PROFESSOR PORTAL</p>
            <h1>My Exams</h1>
            <p>Create and manage your oral examinations.</p>
          </div>

          <button
            type="button"
            className="create-exam-button"
            onClick={() => {
              setError("");
              setShowCreate((current) => !current);
            }}
          >
            + Create Exam
          </button>
        </div>

        {error && (
          <p role="alert" className="exam-error">
            {error}
          </p>
        )}

        {showCreate && (
          <section className="create-exam-card">
            <div className="section-heading">
              <p className="eyebrow">NEW EXAMINATION</p>
              <h2>Create Exam</h2>
            </div>

            <label htmlFor="exam-course">Course</label>
            <input
              id="exam-course"
              type="text"
              value={course}
              onChange={(event) => setCourse(event.target.value)}
              placeholder="Example: CIS 484"
              disabled={saving}
            />

            <label htmlFor="exam-name">Exam Name</label>
            <input
              id="exam-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Example: Oral Examination"
              disabled={saving}
            />

            <label htmlFor="exam-description">Description</label>
            <textarea
              id="exam-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Describe this examination..."
              rows={4}
              disabled={saving}
            />

            <label htmlFor="exam-icon">Exam Icon</label>
            <select
              id="exam-icon"
              value={selectedIcon}
              onChange={(event) => setSelectedIcon(event.target.value)}
              disabled={saving}
            >
              <option value="🎙️">🎙️ Oral Exam</option>
              <option value="📚">📚 Course</option>
              <option value="💻">💻 Technology</option>
              <option value="📊">📊 Business</option>
              <option value="🔬">🔬 Science</option>
              <option value="🌎">🌎 Other</option>
            </select>

            <div className="create-exam-actions">
              <button
                type="button"
                className="cancel-exam-button"
                onClick={() => {
                  setShowCreate(false);
                  setError("");
                }}
                disabled={saving}
              >
                Cancel
              </button>

              <button
                type="button"
                className="save-exam-button"
                onClick={createExam}
                disabled={saving}
              >
                {saving ? "Creating..." : "Create Exam"}
              </button>
            </div>
          </section>
        )}

        {loading ? (
          <p>Loading your examinations...</p>
        ) : exams.length === 0 ? (
          <section className="create-exam-card">
            <h2>No examinations yet</h2>
            <p>Create your first exam to get started.</p>
          </section>
        ) : (
          <section className="exam-grid">
            {exams.map((exam) => (
              <div className="professor-exam-card" key={exam.id}>
                <div className="exam-card-top">
                  <span className="exam-course">{exam.course}</span>
                  <span className="exam-status">
                    {exam.status === "published" ? "Published" : "Draft"}
                  </span>
                </div>

                <h2 className="exam-card-title">
                  {exam.icon ? `${exam.icon} ` : ""}
                  {exam.title}
                </h2>

                <p className="exam-description">
                  {exam.description || "No description provided."}
                </p>

                <div className="exam-stats">
                  <div>
                    <strong>{exam.question_count}</strong>
                    <span>Questions</span>
                  </div>

                  <div>
                    <strong>{exam.submission_count}</strong>
                    <span>Submissions</span>
                  </div>
                </div>

                <div className="exam-card-actions">
                  <a
                    href={`/professor/exams/${exam.id}`}
                    className="manage-exam-button"
                  >
                    📝 Manage Exam →
                  </a>

                  <a
                    href={`/professor/exams/${exam.id}/submissions`}
                    className="view-submissions-button"
                  >
                    📊 View Submissions →
                  </a>

                  <button
                    type="button"
                    className={`publication-button ${
                      exam.status === "published" ? "is-published" : "is-draft"
                    }`}
                    onClick={() => togglePublication(exam)}
                    disabled={saving}
                  >
                    {saving
                      ? "Saving..."
                      : exam.status === "published"
                        ? "✓ Published · Make Draft"
                        : "🚀 Publish Exam"}
                  </button>

                  <button
                    type="button"
                    className="delete-exam-button"
                    onClick={() => deleteExam(exam)}
                    disabled={saving}
                  >
                    🗑️ Delete Exam
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
