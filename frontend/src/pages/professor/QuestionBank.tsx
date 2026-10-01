import { useState } from "react";

type QuestionFile = {
  id: number;
  name: string;
  size: string;
};

export default function QuestionBank() {
  const [files, setFiles] = useState<QuestionFile[]>([]);

  function handleFileChange(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const selectedFile = event.target.files?.[0];

    if (!selectedFile) {
      return;
    }

    const newFile: QuestionFile = {
      id: Date.now(),
      name: selectedFile.name,
      size: `${(selectedFile.size / 1024).toFixed(1)} KB`,
    };

    setFiles((current) => [...current, newFile]);

    event.target.value = "";
  }

  function deleteFile(id: number) {
    setFiles((current) =>
      current.filter((file) => file.id !== id)
    );
  }

  return (
    <div className="question-bank-page">
      <header className="simple-header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>
      </header>

      <main className="question-bank-content">

        <div className="question-bank-heading">
          <p className="eyebrow">PROFESSOR PORTAL</p>

          <h1>Question Bank</h1>

          <p>
            Upload a question file to create the questions
            available for your oral examinations.
          </p>
        </div>

        <section className="question-builder">

          <div className="section-heading">
            <p className="eyebrow">UPLOAD QUESTIONS</p>
            <h2>Import Question Bank</h2>
          </div>

          <label className="question-upload-zone">

            <input
              type="file"
              accept=".csv,.xlsx,.xls,.txt"
              onChange={handleFileChange}
            />

            <div className="question-upload-icon">
              ↑
            </div>

            <strong>
              Upload your questions
            </strong>

            <p>
              CSV, Excel, or TXT files
            </p>

            <span className="choose-file-button">
              Choose Question File
            </span>

          </label>

          <div className="question-upload-help">
            <strong>Recommended format</strong>

            <p>
              Put one question per row in your CSV or Excel
              spreadsheet. We will connect the uploaded
              questions to the database later.
            </p>
          </div>

        </section>

        <section className="question-list">

          <div className="question-list-heading">

            <div>
              <p className="eyebrow">
                QUESTION FILES
              </p>

              <h2>
                Uploaded Question Banks
              </h2>
            </div>

            <span className="question-count">
              {files.length}
            </span>

          </div>

          {files.length === 0 ? (

            <div className="empty-question-list">

              <div className="empty-icon">
                ?
              </div>

              <h3>
                No question files uploaded
              </h3>

              <p>
                Upload a CSV, Excel, or TXT file containing
                your examination questions.
              </p>

            </div>

          ) : (

            <div className="question-items">

              {files.map((file) => (

                <div
                  className="question-item"
                  key={file.id}
                >

                  <div className="question-number">
                    📄
                  </div>

                  <div className="question-item-content">

                    <span>
                      QUESTION BANK
                    </span>

                    <h3>
                      {file.name}
                    </h3>

                    <p>
                      {file.size}
                    </p>

                  </div>

                  <button
                    type="button"
                    className="delete-question"
                    onClick={() =>
                      deleteFile(file.id)
                    }
                  >
                    Delete
                  </button>

                </div>

              ))}

            </div>

          )}

        </section>

      </main>
    </div>
  );
}
