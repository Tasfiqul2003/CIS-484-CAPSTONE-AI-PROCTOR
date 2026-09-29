import { useState } from "react";

type Material = {
  id: number;
  name: string;
  size: string;
};

export default function MaterialUpload() {
  const [materials, setMaterials] = useState<Material[]>([]);

  function handleFileChange(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const selectedFile = event.target.files?.[0];

    if (!selectedFile) {
      return;
    }

    const newMaterial: Material = {
      id: Date.now(),
      name: selectedFile.name,
      size: `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB`,
    };

    setMaterials((current) => [
      ...current,
      newMaterial,
    ]);

    event.target.value = "";
  }

  function deleteMaterial(id: number) {
    setMaterials((current) =>
      current.filter((material) => material.id !== id)
    );
  }

  return (
    <div className="material-upload-page">

      <header className="simple-header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <span>OralExam AI</span>
        </div>
      </header>

      <main className="material-upload-content">

        <div className="material-heading">
          <p className="eyebrow">
            PROFESSOR PORTAL
          </p>

          <h1>
            Course Materials
          </h1>

          <p>
            Upload textbooks, lecture notes, slides, study
            guides, and other course materials.
          </p>
        </div>

        <section className="material-upload-card">

          <div className="section-heading">
            <p className="eyebrow">
              UPLOAD MATERIAL
            </p>

            <h2>
              Add Course Material
            </h2>
          </div>

          <label className="material-dropzone">

            <input
              type="file"
              accept=".pdf,.doc,.docx,.ppt,.pptx,.txt"
              onChange={handleFileChange}
            />

            <div className="material-upload-icon">
              ↑
            </div>

            <strong>
              Upload course material
            </strong>

            <p>
              PDF, DOC, DOCX, PPT, PPTX, or TXT
            </p>

            <span className="choose-file-button">
              Choose File
            </span>

          </label>

        </section>

        <section className="materials-list">

          <div className="materials-list-heading">

            <div>
              <p className="eyebrow">
                COURSE MATERIALS
              </p>

              <h2>
                Uploaded Materials
              </h2>
            </div>

            <span className="material-count">
              {materials.length}
            </span>

          </div>

          {materials.length === 0 ? (

            <div className="empty-materials">

              <div className="empty-material-icon">
                📚
              </div>

              <h3>
                No materials uploaded
              </h3>

              <p>
                Upload course materials to use them when
                building your examinations.
              </p>

            </div>

          ) : (

            <div className="material-items">

              {materials.map((material) => (

                <div
                  className="material-item"
                  key={material.id}
                >

                  <div className="material-file-icon">
                    📄
                  </div>

                  <div className="material-info">

                    <h3>
                      {material.name}
                    </h3>

                    <p>
                      {material.size}
                    </p>

                  </div>

                  <button
                    type="button"
                    className="delete-material"
                    onClick={() =>
                      deleteMaterial(material.id)
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
