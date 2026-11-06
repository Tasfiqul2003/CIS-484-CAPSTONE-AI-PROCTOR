import { useCallback, useEffect, useRef, useState } from "react";
import { extendedTimeMultipliers, normalizedEid, readOdsAccommodations } from "./odsAssignmentState";
import type { OdsAccommodationsState } from "./odsAssignmentState";
import "./category-settings.css";
import "./ods-accommodations.css";

export default function OdsAccommodations({ examId }: { examId: string }) {
  const [data, setData] = useState<OdsAccommodationsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [eid, setEid] = useState("");
  const [multiplier, setMultiplier] = useState(1.5);
  const [uploadMultiplier, setUploadMultiplier] = useState(1.5);
  const [file, setFile] = useState<File | null>(null);
  const action = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const endpoint = `/api/exam/templates/${encodeURIComponent(examId)}/ods-accommodations`;
  const timeSettings = `/professor/exams/${encodeURIComponent(examId)}/settings/time-scheduling`;
  const disabled = loading || !!busy || !data;

  const readResponse = async (response: Response) => {
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = body && typeof body === "object" && "detail" in body ? body.detail : null;
      throw new Error(typeof detail === "string" ? detail : `Unable to save or load ODS assignments (${response.status}).`);
    }
    return readOdsAccommodations(body);
  };

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(endpoint, { credentials: "include", signal });
      const next = await readResponse(response);
      if (!signal?.aborted) setData(next);
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "Unable to load ODS assignments.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    action.current?.abort();
    action.current = null;
    setData(null);
    setBusy("");
    setMessage("");
    setEid("");
    setMultiplier(1.5);
    setUploadMultiplier(1.5);
    setFile(null);
    if (fileInput.current) fileInput.current.value = "";
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      action.current?.abort();
      action.current = null;
    };
  }, [load]);

  async function save(kind: string, suffix: string, init: RequestInit, success: string) {
    if (disabled || action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy(kind);
    setError("");
    setMessage("");
    try {
      const response = await fetch(endpoint + suffix, { ...init, credentials: "include", signal: controller.signal });
      const next = await readResponse(response);
      if (controller.signal.aborted) return;
      setData(next);
      setMessage(success);
      if (kind === "single") setEid("");
      if (kind === "upload") {
        setFile(null);
        if (fileInput.current) fileInput.current.value = "";
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to save ODS assignments. Reload to verify the saved list.");
    } finally {
      if (action.current === controller) {
        action.current = null;
        if (!controller.signal.aborted) setBusy("");
      }
    }
  }

  function assignStudent(event: React.FormEvent) {
    event.preventDefault();
    try {
      const studentEid = normalizedEid(eid);
      void save("single", "", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eid: studentEid, extended_time_multiplier: multiplier }),
      }, "Extended time saved for this student. It applies to their new attempts for this exam.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Enter a roster EID.");
      document.getElementById("ods-student-eid")?.focus();
    }
  }

  function uploadStudents(event: React.FormEvent) {
    event.preventDefault();
    if (!file || !file.name.toLowerCase().endsWith(".csv")) {
      setError("Choose a CSV file with an eid header and one roster EID per row.");
      fileInput.current?.focus();
      return;
    }
    if (file.size > 1024 * 1024) {
      setError("The CSV must be no larger than 1 MiB.");
      fileInput.current?.focus();
      return;
    }
    const body = new FormData();
    body.append("file", file);
    body.append("extended_time_multiplier", String(uploadMultiplier));
    void save("upload", "/upload", { method: "POST", body },
      "Extended time saved for all EIDs in the CSV. It applies to their new attempts for this exam.");
  }

  return <section className="exam-settings-container category-settings ods-accommodations" aria-label="ODS accommodations" aria-busy={loading || !!busy}>
    <div className="exam-settings-header">
      <div>
        <p className="eyebrow">APPROVED EXTENDED TIME</p>
        <h2>ODS Accommodations</h2>
        <p>Assign approved extended time to students on this exam's roster.</p>
      </div>
      <button type="button" className="ods-secondary-button" disabled={loading || !!busy} onClick={() => { setMessage(""); void load(); }}>
        {loading ? "Loading..." : "Reload assignments"}
      </button>
    </div>
    <p className="settings-notice">Assignments apply only to this exam and new attempts. Extended time multiplies the total exam time. Time per question stays unchanged. Existing attempts keep their starting limits.</p>
    {error && <p id="ods-assignment-error" role="alert">{error}</p>}
    {message && <p className="ods-success" role="status">{message}</p>}
    {loading && <p className="ods-loading" role="status">Loading saved assignments...</p>}
    {data && <>
      <div className="ods-base-times">
        <p><strong>Standard exam time:</strong> {data.time_limit_minutes === null ? "No limit set" : `${data.time_limit_minutes} minutes`}</p>
        <p><strong>Time per question:</strong> {data.question_time_limit_minutes === null ? "No separate limit" : `${data.question_time_limit_minutes} minutes`} (unchanged)</p>
        <a href={timeSettings}>Edit time limits →</a>
        {data.time_limit_minutes === null && <p>Set an exam time limit to apply extended time. Assignments can be saved in advance.</p>}
      </div>
      <div className="ods-assignment-forms">
        <form className="ods-assignment-form" onSubmit={assignStudent}>
          <h3>Add or update one student</h3>
          <label className="settings-field">
            <span>Student EID</span>
            <input id="ods-student-eid" type="text" value={eid} required autoComplete="off" spellCheck={false}
              disabled={disabled} aria-describedby={`ods-eid-help${error ? " ods-assignment-error" : ""}`}
              onChange={event => setEid(event.target.value)} />
          </label>
          <small id="ods-eid-help">Use an EID already on this exam's roster.</small>
          <label className="settings-field">
            <span>Extended time multiplier</span>
            <select disabled={disabled} value={multiplier} onChange={event => setMultiplier(Number(event.target.value))}>
              {extendedTimeMultipliers.map(value => <option key={value} value={value}>{value}×</option>)}
            </select>
          </label>
          <button type="submit" className="settings-save-button" disabled={disabled}>{busy === "single" ? "Saving..." : "Save student accommodation"}</button>
        </form>
        <form className="ods-assignment-form" onSubmit={uploadStudents}>
          <h3>Upload student EIDs</h3>
          <p id="ods-csv-help">Choose a CSV with an <code>eid</code> header and one EID per row (up to 1 MiB and 5,000 rows). Every EID must already be on this exam's roster.</p>
          <label className="settings-field">
            <span>EID CSV file</span>
            <input ref={fileInput} type="file" accept=".csv,text/csv" disabled={disabled} aria-describedby="ods-csv-help"
              onChange={event => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <label className="settings-field">
            <span>Multiplier for uploaded EIDs</span>
            <select disabled={disabled} value={uploadMultiplier} onChange={event => setUploadMultiplier(Number(event.target.value))}>
              {extendedTimeMultipliers.map(value => <option key={value} value={value}>{value}×</option>)}
            </select>
          </label>
          <button type="submit" className="settings-save-button" disabled={disabled || !file}>{busy === "upload" ? "Uploading..." : "Upload EID assignments"}</button>
        </form>
      </div>
      <section className="settings-section ods-saved-assignments" aria-labelledby="ods-saved-heading">
        <h3 id="ods-saved-heading">Saved extended-time assignments</h3>
        {data.assignments.length === 0 ? <p>No students have extended time assigned for this exam.</p> : <>
          <p id="ods-table-help" className="ods-table-help">If the table is wider than the screen, focus it and use the arrow keys to view all columns.</p>
          <div className="roster-table-wrap ods-table-scroll" role="region" tabIndex={0} aria-labelledby="ods-saved-heading" aria-describedby="ods-table-help">
          <table>
            <caption>Assigned students and their total exam time for new attempts</caption>
            <thead><tr><th scope="col">EID</th><th scope="col">Student</th><th scope="col">Multiplier</th><th scope="col">Total exam time</th><th scope="col">Action</th></tr></thead>
            <tbody>{data.assignments.map(assignment => <tr key={assignment.student_id}>
              <td><code>{assignment.eid}</code></td><td>{assignment.name}</td>
              <td>{assignment.extended_time_multiplier}×</td>
              <td>{assignment.effective_time_limit_minutes === null ? "No exam limit set" : `${assignment.effective_time_limit_minutes} minutes`}</td>
              <td><button type="button" className="ods-secondary-button" disabled={disabled}
                aria-label={`Remove extended time for ${assignment.eid}`}
                onClick={() => void save(`remove-${assignment.student_id}`, `/${encodeURIComponent(assignment.student_id)}`, { method: "DELETE" },
                  `Extended time removed for ${assignment.eid}. New attempts use the standard exam limit.`)}>
                {busy === `remove-${assignment.student_id}` ? "Removing..." : "Remove"}
              </button></td>
            </tr>)}</tbody>
          </table>
        </div></>}
      </section>
    </>}
    <section className="settings-section ods-future-accommodations">
      <h3>Additional accommodations</h3>
      <p>Additional accommodations can be added here once their behavior is agreed. No additional accommodations are enabled yet.</p>
    </section>
  </section>;
}
