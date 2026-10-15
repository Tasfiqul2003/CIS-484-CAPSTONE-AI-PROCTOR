import { useState } from "react";

const examIcons = [
  { icon: "🎙️", name: "Oral Exam" },
  { icon: "📚", name: "Course" },
  { icon: "💻", name: "Technology" },
  { icon: "📊", name: "Business" },
  { icon: "🔬", name: "Science" },
  { icon: "🌎", name: "Other" },
];

export default function CreateExam() {
  const [course, setCourse] = useState("");
  const [examName, setExamName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedIcon, setSelectedIcon] = useState("🎙️");
  const [questionFile, setQuestionFile] = useState<File | null>(null);
  const [materials, setMaterials] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function createExam() {
    if (!course.trim() || !examName.trim()) {
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
          title: examName.trim(),
          description: description.trim(),
          icon: selectedIcon,
        }),
      });

      const data = await response.json().catch(() => ({}));


      console.log("Create exam response:", data);
      console.log("Created exam ID:", data.id);


      if (!response.ok) {
        throw new Error(
          data.detail || "Unable to create the examination."
        );
      }


      // Upload the selected question bank after creating the exam.
      if (questionFile) {
        const formData = new FormData();
        formData.append("file", questionFile);

        const uploadResponse = await fetch(
          `/api/exam/templates/${data.id}/questions`,
          {
            method: "POST",
            credentials: "include",
            body: formData,
          }
        );

        const uploadData = await uploadResponse.json().catch(() => ({}));

        if (!uploadResponse.ok) {
          throw new Error(
            `Exam created, but question upload failed: ${
              uploadData.detail || "Unknown upload error."
            }`
          );
        }
      }

      // Upload each course material separately.
      for (const material of materials) {
        const formData = new FormData();
        formData.append("file", material);

        console.log("Uploading material to exam ID:", data.id);

        const uploadResponse = await fetch(
          `/api/exam/templates/${data.id}/materials`,
          {
            method: "POST",
            credentials: "include",
            body: formData,
          }
        );

        const uploadData = await uploadResponse.json().catch(() => ({}));

        if (!uploadResponse.ok) {
          const detail = uploadData.detail;

          const message =
            typeof detail === "string"
              ? detail
              : Array.isArray(detail)
                ? detail
                    .map((item: any) =>
                      item.msg || JSON.stringify(item)
                    )
                    .join("; ")
                : detail && typeof detail === "object"
                  ? JSON.stringify(detail)
                  : "Unknown upload error.";

          throw new Error(
            `Material upload failed for ${material.name}: ${message}`
          );
        }

      }

      window.alert("Exam created and selected files uploaded successfully.");
      window.location.href = "/professor/dashboard";

    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to connect to the server."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="create-exam-page">
      <header className="simple-header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>
        <a href="/professor/dashboard" className="dashboard-logout">
          Dashboard
        </a>
      </header>

      <main className="create-exam-content">
        <div className="create-exam-heading">
          <p className="eyebrow">PROFESSOR PORTAL</p>
          <h1>Create New Exam</h1>
          <p>
            Set up your examination, add questions, and provide the
            course materials the AI will use.
          </p>
        </div>

        <section className="create-section">
          <div className="create-section-heading">
            <div>
              <p className="eyebrow">STEP 1</p>
              <h2>Exam Information</h2>
            </div>
          </div>

          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="course">Course</label>
              <input
                id="course"
                value={course}
                onChange={(e) => setCourse(e.target.value)}
                placeholder="CIS 484"
              />
            </div>

            <div className="form-field">
              <label htmlFor="exam-name">Exam Name</label>
              <input
                id="exam-name"
                value={examName}
                onChange={(e) => setExamName(e.target.value)}
                placeholder="Final Oral Examination"
              />
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="description">Description</label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what this examination covers..."
              rows={4}
            />
          </div>

          <div className="form-field">
            <label>Exam Icon</label>
            <p className="icon-selection-description">
              Choose an icon students will see for this exam.
            </p>

            <div className="exam-icon-grid">
              {examIcons.map((item) => (
                <button
                  type="button"
                  key={item.icon}
                  className={
                    selectedIcon === item.icon
                      ? "exam-icon-option selected"
                      : "exam-icon-option"
                  }
                  onClick={() => setSelectedIcon(item.icon)}
                >
                  <span className="exam-icon">{item.icon}</span>
                  <span className="exam-icon-name">{item.name}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="create-section">
          <div className="create-section-heading">
            <div>
              <p className="eyebrow">STEP 2</p>
              <h2>Questions</h2>
              <p>Upload the questions for this examination.</p>
            </div>
          </div>

          <label className="create-upload-zone">
            <input
              type="file"
              accept=".csv,.txt,.docx,.pdf,.pptx"
              onChange={(e) =>
                setQuestionFile(e.target.files?.[0] || null)
              }
            />
            <div className="create-upload-icon">↑</div>
            <strong>
              {questionFile ? questionFile.name : "Upload Question Bank"}
            </strong>
            <p>CSV, Excel, or TXT</p>
            <span className="choose-file-button">Choose Question File</span>
          </label>

          {questionFile && (
            <p role="status">
              Selected: {questionFile.name}. It will need to be uploaded
              after the exam is created.
            </p>
          )}
        </section>

        <section className="create-section">
          <div className="create-section-heading">
            <div>
              <p className="eyebrow">STEP 3</p>
              <h2>Course Materials</h2>
              <p>Upload materials the AI can use for this exam.</p>
            </div>
          </div>

          <label className="create-upload-zone compact">
            <input
              type="file"
              accept=".pdf,.docx,.pptx,.txt"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  setMaterials((current) => [...current, file]);
                }
                e.target.value = "";
              }}
            />
            <div className="create-upload-icon">↑</div>
            <strong>Add Course Material</strong>
            <p>PDF, DOC, DOCX, PPT, PPTX, or TXT</p>
            <span className="choose-file-button">Choose File</span>
          </label>

          {materials.length > 0 && (
            <div className="uploaded-files">
              {materials.map((file, index) => (
                <div
                  className="uploaded-file"
                  key={`${file.name}-${index}`}
                >
                  <div className="uploaded-file-icon">📄</div>
                  <div>
                    <strong>{file.name}</strong>
                    <p>{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setMaterials((current) =>
                        current.filter((_, i) => i !== index)
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {materials.length > 0 && (
            <p>
              These files are selected locally and are not uploaded yet.
            </p>
          )}
        </section>

        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}

        <div className="create-exam-footer">
          <a href="/professor/dashboard" className="cancel-create">
            Cancel
          </a>
          <button
            type="button"
            className="save-exam-button"
            onClick={createExam}
            disabled={saving}
          >
            {saving ? "Saving Exam..." : "Create Exam"}
          </button>
        </div>
      </main>
    </div>
  );
}
