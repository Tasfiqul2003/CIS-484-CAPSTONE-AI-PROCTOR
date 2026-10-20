import { useState } from "react";

type Props = {
  examId: string;
};

type RosterRow = {
  name: string;
  email: string;
  eid: string;
};

type UploadResult = {
  message?: string;
  rows_processed: number;
  students_added: number;
  students_updated: number;
};

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  text = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim());

      if (row.some((value) => value !== "")) rows.push(row);

      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (quoted) {
    throw new Error("The CSV contains an unclosed quotation mark.");
  }

  row.push(field.trim());
  if (row.some((value) => value !== "")) rows.push(row);

  return rows;
}

function readRoster(text: string): RosterRow[] {
  const rows = parseCSV(text);

  if (rows.length < 2) {
    throw new Error("The CSV must contain a header and at least one student.");
  }

  const headers = rows[0].map((header) => header.toLowerCase());
  const nameIndex = headers.indexOf("name");
  const emailIndex = headers.indexOf("email");
  const eidIndex = headers.indexOf("eid");

  if (nameIndex < 0 || emailIndex < 0 || eidIndex < 0) {
    throw new Error("Required columns are name, email, and eid.");
  }

  const roster = rows.slice(1).map((row, index) => {
    const student = {
      name: row[nameIndex] ?? "",
      email: row[emailIndex] ?? "",
      eid: row[eidIndex] ?? "",
    };

    if (!student.name || !student.email || !student.eid) {
      throw new Error(`Row ${index + 2} has a missing name, email, or EID.`);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(student.email)) {
      throw new Error(`Row ${index + 2} has an invalid email address.`);
    }

    return student;
  });

  const emails = roster.map((student) => student.email.toLowerCase());
  const eids = roster.map((student) => student.eid.toLowerCase());

  if (new Set(emails).size !== emails.length) {
    throw new Error("The CSV contains duplicate email addresses.");
  }

  if (new Set(eids).size !== eids.length) {
    throw new Error("The CSV contains duplicate EIDs.");
  }

  return roster;
}

export default function RosterUpload({ examId }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  async function handleFileChange(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const selected = event.currentTarget.files?.[0] ?? null;

    setFile(selected);
    setRoster([]);
    setResult(null);
    setMessage("");
    setError("");
    setPreviewOpen(false);

    if (!selected) return;

    if (!selected.name.toLowerCase().endsWith(".csv")) {
      setError("Please select a .csv file.");
      return;
    }

    setReading(true);

    try {
      const text = await selected.text();
      setRoster(readRoster(text));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to read the CSV file."
      );
    } finally {
      setReading(false);
    }
  }

  async function uploadRoster() {
    if (!file || roster.length === 0 || busy || reading || error) return;

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
          typeof data.detail === "string"
            ? data.detail
            : data.message || `Upload failed (${response.status}).`
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
    <section className="settings-section roster-section">
      <div className="settings-section-heading">
        <div className="settings-section-icon">👥</div>
        <div>
          <h3>Student Exam Roster</h3>
          <p>
            Manage which students are authorized to take this exam.
            Import their names, email addresses, and JMU EIDs.
          </p>
        </div>
      </div>

      <div className="roster-format-card">
        <div className="roster-format-icon">CSV</div>
        <div>
          <strong>Required file format</strong>
          <p>
            Your first row must contain{" "}
            <code>name,email,eid</code>. Each following row represents
            one student.
          </p>
        </div>
      </div>

      <label className="settings-field roster-file-field">
        <span>Choose a roster file</span>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy || reading}
          onChange={handleFileChange}
        />
      </label>

      {file && (
        <div className="roster-selected-file">
          <span className="roster-file-symbol">▤</span>
          <div className="roster-selected-file-info">
            <strong>{file.name}</strong>
            <span>
              {reading
                ? "Reading file..."
                : error
                  ? "Needs attention"
                  : `${roster.length} student${roster.length === 1 ? "" : "s"} found`}
            </span>
          </div>
          {roster.length > 0 && !error && (
            <span className="roster-valid-mark" aria-label="CSV valid">
              ✓
            </span>
          )}
        </div>
      )}

      {roster.length > 0 && !error && (
        <div className="roster-preview-summary">
          <div>
            <span className="roster-summary-number">{roster.length}</span>
            <span className="roster-summary-label">Students detected</span>
          </div>
          <button
            type="button"
            className="roster-preview-button"
            onClick={() => setPreviewOpen(true)}
          >
            Preview roster <span aria-hidden="true">↗</span>
          </button>
        </div>
      )}

      <div className="roster-actions">
        <button
          type="button"
          className="settings-save-button"
          disabled={!file || roster.length === 0 || busy || reading || !!error}
          onClick={uploadRoster}
        >
          {busy ? "Uploading roster..." : "Upload Student Roster"}
        </button>
      </div>

      {error && (
        <div className="roster-alert roster-alert-error" role="alert">
          <strong>Check your roster</strong>
          <span>{error}</span>
        </div>
      )}

      {message && result && (
        <div className="roster-alert roster-alert-success" role="status">
          <strong>✓ Roster uploaded successfully</strong>
          <span>
            {result.rows_processed} rows processed · {result.students_added}{" "}
            new students · {result.students_updated} existing students updated
          </span>
          <button
            type="button"
            className="roster-preview-button"
            onClick={() => setPreviewOpen(true)}
          >
            Review uploaded roster
          </button>
        </div>
      )}

      {previewOpen && (
        <div
          className="question-preview-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setPreviewOpen(false);
            }
          }}
        >
          <section
            className="question-preview-modal roster-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="roster-preview-title"
          >
            <div className="question-preview-header">
              <div>
                <p className="eyebrow">STUDENT ROSTER PREVIEW</p>
                <h2 id="roster-preview-title">
                  {result ? "Uploaded Student Roster" : "Review Students"}
                </h2>
                <p className="roster-modal-subtitle">
                  {file?.name ?? "Roster CSV"} · {roster.length} students
                </p>
              </div>

              <button
                type="button"
                className="question-preview-close"
                aria-label="Close preview"
                onClick={() => setPreviewOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="question-preview-body roster-preview-body">
              <div className="roster-preview-note">
                <span>✓</span>
                <p>
                  {result
                    ? "This roster was accepted by the server."
                    : "CSV format checks passed. Upload the roster to save these students for this exam."}
                </p>
              </div>

              <div className="roster-table-wrap">
                <table className="roster-preview-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Student name</th>
                      <th>Email address</th>
                      <th>JMU EID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roster.map((student, index) => (
                      <tr key={`${student.eid}-${index}`}>
                        <td>{index + 1}</td>
                        <td className="roster-student-name">{student.name}</td>
                        <td>{student.email}</td>
                        <td>
                          <code>{student.eid}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="question-preview-footer roster-preview-footer">
              <button
                type="button"
                className="roster-secondary-button"
                onClick={() => setPreviewOpen(false)}
              >
                Close Preview
              </button>
              {!result && (
                <button
                  type="button"
                  disabled={busy || reading || !!error || roster.length === 0}
                  onClick={() => {
                    setPreviewOpen(false);
                    void uploadRoster();
                  }}
                >
                  {busy ? "Uploading..." : "Confirm & Upload"}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
