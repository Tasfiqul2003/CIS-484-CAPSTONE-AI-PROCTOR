import { useCallback, useEffect, useRef, useState } from 'react';

type Criterion = { name: string; description?: string; max_score: number };
type Grade = { rubric_criterion: string; max_score: number; model_suggested_score: number | null;
  score: number | null; professor_notes: string | null; graded_at?: string | null };
type Report = { session: { status: string; developer_demo?: boolean; recording_status?: string;
  recording_expires_at?: string | null }; grades: Grade[]; rubric_criteria: Criterion[]; rubric_error?: string | null };
type Props = { sessionId: string; onConfirmed?: (status: string) => void };
type RequestContext = { generation: number; sessionId: string };

async function readAssessment(response: Response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : 'Professor assessment is unavailable.');
  return value;
}

function professorNotes(value: string | null) {
  return (value ?? '').split('\n').filter(line => !line.startsWith('[AI rationale]')).join('\n').trim();
}

export default function ProvisionalAssessment({ sessionId, onConfirmed }: Props) {
  const [loadedReport, setReport] = useState<Report | null>(null);
  const [loadedSessionId,setLoadedSessionId]=useState('');
  const [professorId, setProfessorId] = useState('');
  const [scores, setScores] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requests = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const latestSession = useRef(sessionId);
  latestSession.current = sessionId;
  const report = loadedSessionId === sessionId ? loadedReport : null;
  const isCurrent = useCallback((context: RequestContext) =>
    context.generation === generation.current && context.sessionId === latestSession.current, []);

  const load = useCallback(async (expected?: RequestContext) => {
    const context = expected ?? { generation: generation.current, sessionId };
    // An old mutation must not start a report lookup for its former session.
    if (!isCurrent(context)) return;
    const controller = new AbortController(); requests.current.add(controller);
    try {
      const [account, value] = await Promise.all([
        fetch('/api/auth/me', { credentials: 'include', signal: controller.signal }).then(readAssessment),
        fetch(`/api/exam/${encodeURIComponent(context.sessionId)}/report`, { credentials: 'include', signal: controller.signal }).then(readAssessment),
      ]);
      if (!isCurrent(context)) return;
      if (account.role !== 'professor' || typeof account.professor_id !== 'string' || !account.professor_id) {
        throw new Error('A signed-in professor account is required to assess this attempt.');
      }
      setProfessorId(account.professor_id); setReport(value as Report);
      const rows: Grade[] = value.grades.length ? value.grades : value.rubric_criteria.map((criterion: Criterion) => ({
        rubric_criterion: criterion.name, max_score: criterion.max_score, score: null, model_suggested_score: null, professor_notes: null,
      }));
      setScores(current => Object.fromEntries(rows.map(row => [row.rubric_criterion,
        current[row.rubric_criterion] ?? (row.score !== null ? String(row.score) : '')])));
      setNotes(current => Object.fromEntries(rows.map(row => [row.rubric_criterion,
        current[row.rubric_criterion] ?? professorNotes(row.professor_notes)])));
    } finally {
      requests.current.delete(controller);
      if (isCurrent(context)) { setLoadedSessionId(context.sessionId); setLoading(false); }
    }
  }, [sessionId,isCurrent]);

  useEffect(() => {
    const context={ generation: ++generation.current, sessionId };
    setReport(null); setLoadedSessionId(''); setProfessorId(''); setScores({}); setNotes({});
    setError(''); setNotice(''); setLoading(true); setBusy('');
    void load(context).catch(failure => {
      if (isCurrent(context) && !(failure instanceof DOMException && failure.name === 'AbortError'))
        setError(failure instanceof Error ? failure.message : 'Assessment could not be loaded.');
    });
    return () => {
      generation.current++;
      for (const controller of requests.current) controller.abort();
      requests.current.clear();
    };
  }, [load,sessionId,isCurrent]);

  async function reload() {
    const context={ generation:generation.current,sessionId };
    setError('');
    try { await load(context); }
    catch (failure) {
      if (isCurrent(context)) setError(failure instanceof Error ? failure.message : 'Assessment could not be reloaded.');
    }
  }

  async function generateEvaluation() {
    if (busy || !report) return;
    const context={ generation:generation.current,sessionId };
    const controller=new AbortController(); requests.current.add(controller);
    const deadline=setTimeout(() => controller.abort(),310000);
    setBusy('generate'); setError(''); setNotice('Generating a private provisional evaluation. This can take several minutes.');
    try {
      await readAssessment(await fetch('/api/exam/grade',{method:'POST',credentials:'include',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:context.sessionId}),signal:controller.signal}));
      if (!isCurrent(context)) return;
      await load(context);
      if (!isCurrent(context)) return;
      setNotice('Private AI suggestions are ready. Review every criterion and explicitly confirm your scores.');
    } catch (failure) {
      if (isCurrent(context)) {
        setNotice(''); setError(controller.signal.aborted ? 'Evaluation timed out. Your manual score drafts are preserved. Reload before retrying.'
          : failure instanceof Error ? failure.message : 'Evaluation failed. You can assess manually.');
      }
    } finally {
      clearTimeout(deadline); requests.current.delete(controller);
      if (isCurrent(context)) setBusy('');
    }
  }

  const rows: Grade[] = report?.grades.length ? report.grades : (report?.rubric_criteria ?? []).map(criterion => ({
    rubric_criterion: criterion.name, max_score: criterion.max_score, score: null, model_suggested_score: null, professor_notes: null,
  }));
  const retained = report?.session.recording_status === 'completed' && !!report.session.recording_expires_at
    && Date.parse(report.session.recording_expires_at) > Date.now();
  const editable = !!report && (!report.rubric_error || report.grades.length > 0) && !report.session.developer_demo && retained
    && ['pending_grading', 'flagged', 'graded'].includes(report.session.status);

  async function confirm() {
    if (busy || !editable || !professorId) return;
    const grades = rows.map(row => ({ rubric_criterion: row.rubric_criterion,
      score: Number(scores[row.rubric_criterion]), professor_notes: notes[row.rubric_criterion] ?? '' }));
    if (!grades.length || rows.some((row, index) => !scores[row.rubric_criterion]?.trim()
      || !Number.isFinite(grades[index].score) || grades[index].score < 0 || grades[index].score > row.max_score)) {
      setError('Enter an explicit finite score within the displayed bound for every criterion.'); return;
    }
    const context={ generation:generation.current,sessionId };
    const controller=new AbortController(); requests.current.add(controller);
    const deadline=setTimeout(() => controller.abort(),60000);
    setBusy('confirm'); setError(''); setNotice('');
    try {
      const value=await readAssessment(await fetch(`/api/exam/${encodeURIComponent(context.sessionId)}/grades`,{
        method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({professor_id:professorId,grades}),signal:controller.signal,
      }));
      if (!isCurrent(context)) return;
      await load(context);
      if (!isCurrent(context)) return;
      setNotice('Professor assessment confirmed and saved. AI suggestions remain labeled provisional.');
      onConfirmed?.(value.session_status);
    } catch (failure) {
      if (isCurrent(context)) setError(controller.signal.aborted ? 'Confirmation timed out. Your drafts are preserved. Reload before retrying.'
        : failure instanceof Error ? failure.message : 'Assessment could not be confirmed. Your drafts are preserved.');
    } finally {
      clearTimeout(deadline); requests.current.delete(controller);
      if (isCurrent(context)) setBusy('');
    }
  }

  return <section className="question-builder" aria-labelledby="provisional-assessment-heading">
    <h2 id="provisional-assessment-heading">Professor assessment</h2>
    <p>AI suggestions are private and provisional. You can enter manual scores without AI. Review every score and explicitly confirm your assessment.</p>
    {loading ? <p role="status">Loading professor assessment…</p> : report && <>
      {report.session.status === 'graded' && <p role="status">This attempt has a confirmed professor assessment. Further changes require explicit confirmation.</p>}
      {!editable && <p role="status">Assessment requires a submitted assessed attempt and a completed recording within its retention deadline.</p>}
      {report.rubric_error && !report.grades.length && <p role="alert">{report.rubric_error}</p>}
      <button type="button" disabled={!editable || Boolean(busy) || report.grades.length > 0 || !rows.length || report.session.status === 'graded'}
        onClick={() => void generateEvaluation()}>{busy === 'generate' ? 'Generating provisional evaluation…' : 'Generate provisional evaluation'}</button>{' '}
      <button type="button" disabled={Boolean(busy)} onClick={() => void reload()}>Reload assessment</button>
      <div style={{ display: 'grid', gap: 16, marginBlock: 16 }}>
        {rows.map((row, index) => <fieldset key={row.rubric_criterion} disabled={!editable || Boolean(busy)}>
          <legend>{row.rubric_criterion} · maximum {row.max_score}</legend>
          {report.rubric_criteria.find(criterion => criterion.name === row.rubric_criterion)?.description && <p>
            {report.rubric_criteria.find(criterion => criterion.name === row.rubric_criterion)?.description}</p>}
          <p>Provisional AI suggestion: {row.model_suggested_score === null ? 'Unavailable; manual assessment is supported.' : `${row.model_suggested_score} / ${row.max_score}`}</p>
          {row.model_suggested_score !== null && <button type="button" onClick={() => setScores(current => ({ ...current,
            [row.rubric_criterion]: String(row.model_suggested_score) }))}>Use suggestion for {row.rubric_criterion}</button>}
          {row.professor_notes?.split('\n').filter(line => line.startsWith('[AI rationale]')).map((line, i) => <p key={i}>{line}</p>)}
          <label htmlFor={`assessment-score-${index}`}>Your score for {row.rubric_criterion}</label>{' '}
          <input id={`assessment-score-${index}`} type="number" min={0} max={row.max_score} step="any" value={scores[row.rubric_criterion] ?? ''}
            onChange={event => setScores(current => ({ ...current, [row.rubric_criterion]: event.target.value }))} />
          <label htmlFor={`assessment-notes-${index}`} style={{ display: 'block', marginTop: 8 }}>Professor notes for {row.rubric_criterion}</label>
          <textarea id={`assessment-notes-${index}`} maxLength={4000} value={notes[row.rubric_criterion] ?? ''}
            onChange={event => setNotes(current => ({ ...current, [row.rubric_criterion]: event.target.value }))}
            style={{ display: 'block', width: '100%', minHeight: 80 }} />
        </fieldset>)}
      </div>
      <button type="button" disabled={!editable || Boolean(busy) || !rows.length} onClick={() => void confirm()}>
        {busy === 'confirm' ? 'Confirming assessment…' : 'Confirm professor assessment'}</button>
    </>}
    {error && <div role="alert"><p>{error}</p><button type="button" disabled={Boolean(busy)} onClick={() => void reload()}>Retry loading assessment</button></div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
