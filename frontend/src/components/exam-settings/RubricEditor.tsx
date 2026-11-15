import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import "./rubric-editor.css";

type Criterion = { name: string; max_score: number; description?: string };
type RubricResponse = { default: boolean; criteria: Criterion[]; default_criteria?: Criterion[] };

const blank = (): Criterion => ({ name: "", max_score: 10, description: "" });

/** The rubric the AI assessment scores against: the default one, or the professor's own. */
export default function RubricEditor({ examId }: { examId: string }) {
  const [useDefault, setUseDefault] = useState(true);
  const [defaults, setDefaults] = useState<Criterion[]>([]);
  const [criteria, setCriteria] = useState<Criterion[]>([blank()]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/exam/templates/${encodeURIComponent(examId)}/rubric`,
          { credentials: "include", signal: controller.signal });
        const data = await response.json() as RubricResponse & { detail?: string };
        if (!response.ok) throw new Error(data.detail || "The rubric could not be loaded.");
        setDefaults(data.default_criteria ?? data.criteria);
        setUseDefault(data.default);
        if (!data.default) setCriteria(data.criteria.map(c => ({ ...c, description: c.description ?? "" })));
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "The rubric could not be loaded.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [examId]);

  const update = (index: number, change: Partial<Criterion>) => {
    setStatus("");
    setCriteria(current => current.map((item, i) => i === index ? { ...item, ...change } : item));
  };

  const custom = criteria.filter(c => c.name.trim());
  const total = (useDefault ? defaults : custom).reduce((sum, c) => sum + (Number(c.max_score) || 0), 0);
  const invalid = !useDefault && (custom.length === 0 || custom.some(c => !(c.max_score > 0 && c.max_score <= 100)));

  async function save() {
    setSaving(true); setError(""); setStatus("");
    try {
      const response = await fetch(`/api/exam/templates/${encodeURIComponent(examId)}/rubric`, {
        method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ criteria: useDefault ? [] : custom.map(c => ({
          name: c.name.trim(), max_score: Number(c.max_score), description: c.description?.trim() || null })) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = (data as { detail?: unknown }).detail;
        throw new Error(typeof detail === "string" ? detail : "Check that every criterion has a name and 1–100 points.");
      }
      setStatus("Rubric saved. It applies to exams assessed from now on.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The rubric could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section className="rubric-editor"><p role="status">Loading the grading rubric…</p></section>;

  return <section className="rubric-editor" aria-labelledby="rubric-heading">
    <div className="rubric-editor-heading">
      <h2 id="rubric-heading">Grading rubric</h2>
      <p>The AI assessment scores each finished exam against this rubric. You confirm or change every score.</p>
    </div>
    <fieldset className="rubric-choice">
      <legend className="rubric-sr">Rubric to use</legend>
      <label><input type="radio" name="rubric-choice" checked={useDefault} onChange={() => { setUseDefault(true); setStatus(""); }} />
        <span><strong>Default rubric</strong>{defaults.map(c => c.name).join(", ")}, {defaults[0]?.max_score ?? 10} points each</span></label>
      <label><input type="radio" name="rubric-choice" checked={!useDefault} onChange={() => { setUseDefault(false); setStatus(""); }} />
        <span><strong>My own rubric</strong>Write the criteria and points for this exam</span></label>
    </fieldset>

    {!useDefault && <div className="rubric-rows">
      <div className="rubric-row rubric-row-head" aria-hidden="true"><span>Criterion</span><span>Points</span><span>What earns the points (optional)</span><span /></div>
      {criteria.map((item, index) => <div className="rubric-row" key={index}>
        <input aria-label={`Criterion ${index + 1} name`} value={item.name} maxLength={80} placeholder="Example: Uses correct terminology"
          onChange={event => update(index, { name: event.target.value })} />
        <input aria-label={`Criterion ${index + 1} points`} type="number" min={1} max={100} value={item.max_score}
          onChange={event => update(index, { max_score: Number(event.target.value) })} />
        <input aria-label={`Criterion ${index + 1} description`} value={item.description ?? ""} maxLength={400}
          placeholder="Example: Names primary and foreign keys correctly" onChange={event => update(index, { description: event.target.value })} />
        <button type="button" className="rubric-remove" aria-label={`Remove criterion ${index + 1}`} disabled={criteria.length === 1}
          onClick={() => setCriteria(current => current.filter((_, i) => i !== index))}><Trash2 size={16} aria-hidden="true" /></button>
      </div>)}
      <button type="button" className="rubric-add" disabled={criteria.length >= 12}
        onClick={() => setCriteria(current => [...current, blank()])}><Plus size={16} aria-hidden="true" />Add criterion</button>
    </div>}

    <div className="rubric-footer">
      <span>Total: <strong>{total}</strong> points</span>
      <button type="button" className="rubric-save" onClick={() => void save()} disabled={saving || invalid}>
        {saving ? "Saving…" : "Save rubric"}
      </button>
    </div>
    {status && <p role="status" className="rubric-status">{status}</p>}
    {error && <p role="alert" className="exam-error">{error}</p>}
  </section>;
}
