import { useState } from "react";

type Exam = {
  id: number;
  course: string;
  name: string;
  description: string;
  icon: string;
  questionCount: number;
  materialCount: number;
  status: string;
};

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

  function createExam() {
    if (!course.trim() || !examName.trim()) {
      alert("Please enter a course and exam name.");
      return;
    }

    const saved = localStorage.getItem("oralExamExams");

    let existingExams: Exam[] = [];

    if (saved) {
      try {
        existingExams = JSON.parse(saved);
      } catch {
        existingExams = [];
      }
    }

    const newExam: Exam = {
      id: Date.now(),
      course: course.trim(),
      name: examName.trim(),
      description: description.trim(),
      icon: selectedIcon,
      questionCount: questionFile ? 1 : 0,
      materialCount: materials.length,
      status: "Draft",
    };

    const updatedExams = [
      ...existingExams,
      newExam,
    ];

    localStorage.setItem(
      "oralExamExams",
      JSON.stringify(updatedExams)
    );

    window.location.href = "/professor/dashboard";
  }

  return (
    <div className="create-exam-page">

      <header className="simple-header">

        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>

        <a
          href="/professor/dashboard"
          className="dashboard-logout"
        >
          Dashboard
        </a>

      </header>

      <main className="create-exam-content">

        <div className="create-exam-heading">

          <p className="eyebrow">
            PROFESSOR PORTAL
          </p>

          <h1>
            Create New Exam
          </h1>

          <p>
            Set up your examination, add questions, and
            provide the course materials the AI will use.
          </p>

        </div>

        <section className="create-section">

          <div className="create-section-heading">

            <div>

              <p className="eyebrow">
                STEP 1
              </p>

              <h2>
                Exam Information
              </h2>

            </div>

          </div>

          <div className="form-grid">

            <div className="form-field">

              <label htmlFor="course">
                Course
              </label>

              <input
                id="course"
                value={course}
                onChange={(e) =>
                  setCourse(e.target.value)
                }
                placeholder="CIS 484"
              />

            </div>

            <div className="form-field">

              <label htmlFor="exam-name">
                Exam Name
              </label>

              <input
                id="exam-name"
                value={examName}
                onChange={(e) =>
                  setExamName(e.target.value)
                }
                placeholder="Final Oral Examination"
              />

            </div>

          </div>

          <div className="form-field">

            <label htmlFor="description">
              Description
            </label>

            <textarea
              id="description"
              value={description}
              onChange={(e) =>
                setDescription(e.target.value)
              }
              placeholder="Describe what this examination covers..."
              rows={4}
            />

          </div>

          <div className="form-field">

            <label>
              Exam Icon
            </label>

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
                  onClick={() =>
                    setSelectedIcon(item.icon)
                  }
                >

                  <span className="exam-icon">
                    {item.icon}
                  </span>

                  <span className="exam-icon-name">
                    {item.name}
                  </span>

                </button>

              ))}

            </div>

          </div>

        </section>

        <section className="create-section">

          <div className="create-section-heading">

            <div>

              <p className="eyebrow">
                STEP 2
              </p>

              <h2>
                Questions
              </h2>

              <p>
                Upload the questions for this examination.
              </p>

            </div>

          </div>

          <label className="create-upload-zone">

            <input
              type="file"
              accept=".csv,.xlsx,.xls,.txt"
              onChange={(e) =>
                setQuestionFile(
                  e.target.files?.[0] || null
                )
              }
            />

            <div className="create-upload-icon">
              ↑
            </div>

            <strong>
              {questionFile
                ? questionFile.name
                : "Upload Question Bank"}
            </strong>

            <p>
              CSV, Excel, or TXT
            </p>

            <span className="choose-file-button">
              Choose Question File
            </span>

          </label>

        </section>

        <section className="create-section">

          <div className="create-section-heading">

            <div>

              <p className="eyebrow">
                STEP 3
              </p>

              <h2>
                Course Materials
              </h2>

              <p>
                Upload materials the AI can use for this exam.
              </p>

            </div>

          </div>

          <label className="create-upload-zone compact">

            <input
              type="file"
              accept=".pdf,.doc,.docx,.ppt,.pptx,.txt"
              onChange={(e) => {

                const file = e.target.files?.[0];

                if (file) {
                  setMaterials((current) => [
                    ...current,
                    file,
                  ]);
                }

                e.target.value = "";
              }}
            />

            <div className="create-upload-icon">
              ↑
            </div>

            <strong>
              Add Course Material
            </strong>

            <p>
              PDF, DOC, DOCX, PPT, PPTX, or TXT
            </p>

            <span className="choose-file-button">
              Choose File
            </span>

          </label>

          {materials.length > 0 && (

            <div className="uploaded-files">

              {materials.map((file, index) => (

                <div
                  className="uploaded-file"
                  key={`${file.name}-${index}`}
                >

                  <div className="uploaded-file-icon">
                    📄
                  </div>

                  <div>
                    <strong>
                      {file.name}
                    </strong>

                    <p>
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      setMaterials((current) =>
                        current.filter(
                          (_, i) => i !== index
                        )
                      )
                    }
                  >
                    Remove
                  </button>

                </div>

              ))}

            </div>

          )}

        </section>

        <div className="create-exam-footer">

          <a
            href="/professor/dashboard"
            className="cancel-create"
          >
            Cancel
          </a>

          <button
            type="button"
            className="save-exam-button"
            onClick={createExam}
          >
            Create Exam
          </button>

        </div>

      </main>

    </div>
  );
}
