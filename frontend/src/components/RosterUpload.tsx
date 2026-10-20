import { useState } from "react";

type Props = {
  examId: string;
};

type UploadResult = {
  message: string;
  rows_processed: number;
  students_added: number;
  students_updated: number;
};

export default function RosterUpload({ examId }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);

  async function uploadRoster() {
    if (!file || busy) {
      setError("Choose a CSV file first.");
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(
        `/api/exam/templates/${encodeURIComponent(examId)}/roster`,
        {
          method: "POST",
          credentials: "include",
          body: formData,
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.detail || data.message || `Upload failed (${response.status}).`
        );
      }

      setResult(data as UploadResult);
      setMessage("Roster uploaded successfully.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to upload the roster."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <div className="settings-section-icon">👥</div>
        <div>
          <h3>Student Exam Roster</h3>
          <p>
            Upload the students authorized to take this exam. Each row must
            include the student's name, email, and JMU EID.
          </p>
        </div>
      </div>

      <p>
        Required CSV columns: <code>name,email,eid</code>
      </p>

      <p>
        Example: <code>Jane Student,jane@example.com,jstudent</code>
      </p>

      <label className="settings-field">
        <span>Roster CSV file</span>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setError("");
            setMessage("");
            setResult(null);
          }}
        />
      </label>

      <button
        type="button"
        className="settings-save-button"
        disabled={!file || busy}
        onClick={uploadRoster}
      >
        {busy ? "Uploading..." : "Upload Student Roster"}
      </button>

      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}

      {result && (
        <div role="status">
          <p>Rows processed: {result.rows_processed}</p>
          <p>New student records: {result.students_added}</p>
          <p>Existing student records updated: {result.students_updated}</p>
        </div>
      )}
    </section>
  );
}
