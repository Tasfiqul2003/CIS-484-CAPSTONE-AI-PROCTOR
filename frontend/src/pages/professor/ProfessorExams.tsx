import { useState } from "react";

type Exam = {
  id: number;
  course: string;
  name: string;
  description: string;
  questions: number;
  materials: number;
};

export default function ProfessorExams() {
  const [exams, setExams] = useState<Exam[]>([
    {
      id: 1,
      course: "CIS 484",
      name: "Oral Examination",
      description:
        "AI-powered oral examination for CIS 484.",
      questions: 10,
      materials: 3,
    },
    {
      id: 2,
      course: "COB 300",
      name: "Operations Oral Examination",
      description:
        "Operations and supply chain oral examination.",
      questions: 8,
      materials: 5,
    },
  ]);

  const [showCreate, setShowCreate] = useState(false);
  const [course, setCourse] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function createExam() {
    if (!course.trim() || !name.trim()) {
      return;
    }

    const newExam: Exam = {
      id: Date.now(),
      course: course.trim(),
      name: name.trim(),
      description: description.trim(),
      questions: 0,
      materials: 0,
    };

    setExams((current) => [...current, newExam]);

    setCourse("");
    setName("");
    setDescription("");
    setShowCreate(false);
  }

  function deleteExam(id: number) {
    setExams((current) =>
      current.filter((exam) => exam.id !== id)
    );
  }

  return (
    <div className="professor-exams-page">

      <header className="simple-header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>
      </header>

      <main className="professor-exams-content">

        <div className="professor-exams-heading">
          <div>
            <p className="eyebrow">
              PROFESSOR PORTAL
            </p>

            <h1>My Exams</h1>

            <p>
              Create and manage your oral examinations.
            </p>
          </div>

          <button
            type="button"
            className="create-exam-button"
            onClick={() => setShowCreate(true)}
          >
            + Create Exam
          </button>
        </div>

        {showCreate && (
          <section className="create-exam-card">

            <div className="section-heading">
              <p className="eyebrow">
                NEW EXAMINATION
              </p>

              <h2>Create Exam</h2>
            </div>

            <label htmlFor="exam-course">
              Course
            </label>

            <input
              id="exam-course"
              type="text"
              value={course}
              onChange={(event) =>
                setCourse(event.target.value)
              }
              placeholder="Example: CIS 484"
            />

            <label htmlFor="exam-name">
              Exam Name
            </label>

            <input
              id="exam-name"
              type="text"
              value={name}
              onChange={(event) =>
                setName(event.target.value)
              }
              placeholder="Example: Oral Examination"
            />

            <label htmlFor="exam-description">
              Description
            </label>

            <textarea
              id="exam-description"
              value={description}
              onChange={(event) =>
                setDescription(event.target.value)
              }
              placeholder="Describe this examination..."
              rows={4}
            />

            <div className="create-exam-actions">

              <button
                type="button"
                className="cancel-exam-button"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>

              <button
                type="button"
                className="save-exam-button"
                onClick={createExam}
              >
                Create Exam
              </button>

            </div>

          </section>
        )}

        <section className="exam-grid">

          {exams.map((exam) => (

            <div
              className="professor-exam-card"
              key={exam.id}
            >

              <div className="exam-card-top">
                <span className="exam-course">
                  {exam.course}
                </span>

                <span className="exam-status">
                  Active
                </span>
              </div>

              <h2>
                {exam.name}
              </h2>

              <p className="exam-description">
                {exam.description}
              </p>

              <div className="exam-stats">

                <div>
                  <strong>
                    {exam.questions}
                  </strong>

                  <span>
                    Questions
                  </span>
                </div>

                <div>
                  <strong>
                    {exam.materials}
                  </strong>

                  <span>
                    Materials
                  </span>
                </div>

              </div>

              <div className="exam-card-actions">

                <a
                  href={`/professor/exams/${exam.id}`}
                  className="manage-exam-button"
                >
                  Manage Exam →
                </a>

                <button
                  type="button"
                  className="delete-exam-button"
                  onClick={() =>
                    deleteExam(exam.id)
                  }
                >
                  Delete
                </button>

              </div>

            </div>

          ))}

        </section>

      </main>
    </div>
  );
}
