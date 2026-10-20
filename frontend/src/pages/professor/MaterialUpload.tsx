
import { useEffect, useState } from "react";

type Material = {
  id: string;
  filename: string;
  content_type: string;
  created_at: string;
  characters_extracted: number;
  has_summary: boolean;
};

type MaterialPreview = {
  id: string;
  filename: string;
  extracted_text: string;
  summary?: string | null;
};

function getExamId() {
  const match = window.location.pathname.match(
    /^\/professor\/exams\/([^/]+)\/materials\/?$/
  );

  return match?.[1] ?? null;
}

async function readResponse(response: Response) {
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data?.detail;
    const message =
      typeof detail === "string"
        ? detail
        : detail
          ? JSON.stringify(detail)
          : "The request failed.";

    throw new Error(message);
  }

  return data;
}

export default function MaterialUpload() {
  const examId = getExamId();

  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [processingMaterialId, setProcessingMaterialId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<MaterialPreview | null>(null);

  async function loadMaterials() {
    if (!examId) {
      setError("Invalid exam ID in page URL.");
      setLoading(false);
      return;
    }

    try {
      setError("");

      const response = await fetch(
        `/api/exam/templates/${examId}/materials`,
        { credentials: "include" }
      );

      const data = await readResponse(response);
      setMaterials(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load course materials."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMaterials();
  }, [examId]);

  async function handleFileChange(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const input = event.currentTarget;
    const file = input.files?.[0];

    if (!file || !examId) return;

    const formData = new FormData();
    formData.append("file", file);

    setUploading(true);
    setError("");

    try {
      const response = await fetch(
        `/api/exam/templates/${examId}/materials`,
        {
          method: "POST",
          credentials: "include",
          body: formData,
        }
      );

      const data = await readResponse(response);

      await loadMaterials();

      window.alert(
        `Uploaded ${data.filename ?? file.name}. ` +
        `${data.characters_extracted ?? 0} characters extracted.`
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to upload course material."
      );
    } finally {
      setUploading(false);
      input.value = "";
    }
  }

  async function previewMaterial(material: Material) {
    if (!examId) return;

    try {
      const response = await fetch(
        `/api/exam/templates/${examId}/materials/${material.id}`,
        { credentials: "include" }
      );

      const data = await readResponse(response);
      setPreview(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to preview material."
      );
    }
  }

  async function processMaterial(material: Material) {
    if (!examId) return;

    setProcessingMaterialId(material.id);
    setError("");

    try {
      const response = await fetch(
        `/api/exam/templates/${examId}/materials/${material.id}/summary`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      await readResponse(response);
      await loadMaterials();
      await previewMaterial(material);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to process course material."
      );
    } finally {
      setProcessingMaterialId(null);
    }
  }

  async function deleteMaterial(material: Material) {
    if (!examId) return;

    if (!window.confirm(`Delete "${material.filename}"?`)) return;

    try {
      const response = await fetch(
        `/api/exam/templates/${examId}/materials/${material.id}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );

      await readResponse(response);

      setMaterials((current) =>
        current.filter((item) => item.id !== material.id)
      );

      if (preview?.id === material.id) {
        setPreview(null);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to delete course material."
      );
    }
  }

  return (
    <div className="material-upload-page">
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

      <main className="material-upload-content">
        <div className="material-heading">
          <button
            type="button"
            className="back-to-exam-button"
            onClick={() => {
              window.location.href = examId
                ? `/professor/exams/${examId}`
                : "/professor/exams";
            }}
          >
            ← Back to Exam
          </button>
          <p className="eyebrow">PROFESSOR PORTAL</p>
          <h1>Course Materials</h1>
          <p>
            Upload textbooks, lecture notes, slides, study guides,
            and other course materials.
          </p>
        </div>

        {error && (
          <div role="alert" className="material-error">
            {error}
          </div>
        )}

        <section className="material-upload-card">
          <div className="section-heading">
            <p className="eyebrow">UPLOAD MATERIAL</p>
            <h2>Add Course Material</h2>
          </div>

          <label className="material-dropzone">
            <input
              type="file"
              accept=".pdf,.docx,.pptx,.txt"
              disabled={uploading || !examId}
              onChange={handleFileChange}
            />

            <div className="material-upload-icon">↑</div>
            <strong>
              {uploading ? "Uploading..." : "Upload course material"}
            </strong>
            <p>PDF, DOCX, PPTX, or TXT</p>
            <span className="choose-file-button">
              Choose File
            </span>
          </label>
        </section>

        <section className="materials-list">
          <div className="materials-list-heading">
            <div>
              <p className="eyebrow">COURSE MATERIALS</p>
              <h2>Uploaded Materials</h2>
            </div>

            <span className="material-count">{materials.length}</span>
          </div>

          {loading ? (
            <p>Loading course materials...</p>
          ) : materials.length === 0 ? (
            <div className="empty-materials">
              <div className="empty-material-icon">📚</div>
              <h3>No materials uploaded</h3>
              <p>
                Upload course materials to use them when building
                your examinations.
              </p>
            </div>
          ) : (
            <div className="material-items">
              {materials.map((material) => (
                <div className="material-item" key={material.id}>
                  <div className="material-file-icon">📄</div>

                  <div className="material-info">
                    <h3>{material.filename}</h3>
                    <p>
                      {material.characters_extracted.toLocaleString()}{" "}
                      characters extracted
                    </p>
                    <p>
                      Added{" "}
                      {new Date(material.created_at).toLocaleDateString()}
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={processingMaterialId === material.id}
                    onClick={() => void processMaterial(material)}
                  >
                    {processingMaterialId === material.id
                      ? "Processing..."
                      : material.has_summary
                        ? "Reprocess Summary"
                        : "Process Summary"}
                  </button>

                  <button
                    type="button"
                    onClick={() => void previewMaterial(material)}
                  >
                    Preview
                  </button>

                  <button
                    type="button"
                    className="delete-material"
                    onClick={() => void deleteMaterial(material)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>



        {preview && (
          <div
            className="question-preview-overlay"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setPreview(null);
              }
            }}
          >
            <section
              className="question-preview-modal material-preview-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="material-preview-title"
            >
              <div className="question-preview-header">
                <div>
                  <p className="eyebrow">DOCUMENT PREVIEW</p>
                  <h2 id="material-preview-title">{preview.filename}</h2>
                </div>

                <button
                  type="button"
                  className="question-preview-close"
                  aria-label="Close preview"
                  onClick={() => setPreview(null)}
                >
                  ×
                </button>
              </div>

              <div className="question-preview-body material-preview-body">
                {preview.summary && (
                  <section className="material-summary">
                    <h3>Summary</h3>
                    <p>{preview.summary}</p>
                  </section>
                )}

                <h3 className="material-extracted-heading">
                  Extracted Text
                </h3>

                <pre className="material-preview-text">
                  {preview.extracted_text || "No extracted text available."}
                </pre>
              </div>

              <div className="question-preview-footer">
                <button type="button" onClick={() => setPreview(null)}>
                  Close Preview
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

