import { useCallback, useEffect, useRef, useState } from 'react';
import QuestionDraftContext from './QuestionDraftContext';
import { useRequestScope } from './useRequestScope';
import type { RequestScope } from './useRequestScope';

type Draft = { id: string; question_text: string; topic: string; difficulty: number;
  status: 'pending' | 'approved' | 'rejected'; approved_question_id: string | null };
type Edited = { question_text: string; topic: string; difficulty: number };
type Props = { examId: string; onApproved: () => Promise<void> };

export default function QuestionDrafts({ examId, onApproved }: Props) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [editable, setEditable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [topic, setTopic] = useState('');
  const [count, setCount] = useState(3);
  const [difficulty, setDifficulty] = useState(3);
  const [edits, setEdits] = useState<Record<string, Edited>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const retry = useRef<{ key: string; request_id: string } | null>(null);
  const [loadedExam,setLoadedExam]=useState('');
  const {capture,isCurrent,json}=useRequestScope(examId);

  const load = useCallback(async (expected?: RequestScope) => {
    const scope=expected ?? capture();
    if (!isCurrent(scope)) return;
    try {
      const value=await json<{drafts:Draft[];topics:string[];can_edit:boolean}>(scope,
        `/api/exam/templates/${encodeURIComponent(scope.owner)}/question-drafts`,{credentials:'include'});
      if (!isCurrent(scope)) return;
      setDrafts(value.drafts); setTopics(value.topics); setEditable(value.can_edit === true);
      setTopic(current => value.topics.includes(current) ? current : value.topics[0] ?? '');
    } catch (failure) {
      if (isCurrent(scope)) setError(failure instanceof DOMException && failure.name==='AbortError'
        ? 'Loading drafts timed out. Retry when the service is available.'
        : failure instanceof Error ? failure.message : 'Question drafts could not be loaded.');
    } finally { if (isCurrent(scope)) {setLoadedExam(scope.owner);setLoading(false);} }
  },[capture,isCurrent,json]);
  useEffect(() => {
    setDrafts([]);setTopics([]);setEditable(false);setLoading(true);setLoadedExam('');
    setTopic('');setEdits({});setBusy('');setError('');setNotice('');retry.current=null;
    void load();
  },[load]);

  async function generate() {
    if (busy || !editable || !topic || loadedExam!==examId) return;
    const scope=capture();
    const key=JSON.stringify({topic,difficulty,count});
    const requestId=retry.current?.key===key ? retry.current.request_id : crypto.randomUUID();
    retry.current={key,request_id:requestId};
    setBusy('generate');setError('');setNotice('Preparing unapproved drafts. This may take up to 90 seconds.');
    try {
      const value=await json<{status:string}>(scope,`/api/exam/templates/${encodeURIComponent(scope.owner)}/question-drafts/generate`,{
        method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({request_id:requestId,topic,difficulty,count}),
      },100000);
      if (!isCurrent(scope)) return;
      if (value.status==='ready') {retry.current=null;setNotice('Drafts are ready for your review. No question was added to the exam.');}
      else if (value.status==='generating') setNotice('This generation request is still running. Use Generate drafts again to check the same request.');
      else {retry.current=null;setNotice('Generation failed or was interrupted. Generate again to start a new request. No question was approved.');}
      await load(scope);
    } catch (failure) {
      if (isCurrent(scope)) {setNotice('');setError(failure instanceof DOMException && failure.name==='AbortError'
        ? 'Question generation timed out. Check the same request before starting another.'
        : failure instanceof Error ? failure.message : 'Question generation failed. Nothing was approved.');}
    } finally {if (isCurrent(scope)) setBusy('');}
  }

  function edited(draft: Draft): Edited {
    return edits[draft.id] ?? { question_text: draft.question_text, topic: draft.topic, difficulty: draft.difficulty };
  }
  function edit(draft: Draft, patch: Partial<Edited>) {
    setEdits(current => ({ ...current, [draft.id]: { ...edited(draft), ...patch } }));
  }
  async function review(draft:Draft,action:'approve'|'reject') {
    if (busy || !editable || loadedExam!==examId) return;
    const scope=capture();
    setBusy(`${action}:${draft.id}`);setError('');setNotice('');
    try {
      await json(scope,`/api/exam/templates/${encodeURIComponent(scope.owner)}/question-drafts/${encodeURIComponent(draft.id)}/${action}`,{
        method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(action==='approve'?edited(draft):{}),
      },60000);
      if (!isCurrent(scope)) return;
      await load(scope);
      if (!isCurrent(scope)) return;
      if (action==='approve') await onApproved();
      if (!isCurrent(scope)) return;
      setNotice(action==='approve'?'Approved question added to the saved bank. Publishing remains a separate action.':'Draft rejected. It was never added to the saved question bank.');
    } catch (failure) {
      if (isCurrent(scope)) setError(failure instanceof DOMException && failure.name==='AbortError'
        ? 'Review confirmation timed out. Reload drafts before retrying.'
        : failure instanceof Error ? failure.message : 'Review could not be saved. Reload before retrying.');
    } finally {if (isCurrent(scope)) setBusy('');}
  }

  return <section className="question-builder" aria-labelledby="question-draft-heading">
    <h2 id="question-draft-heading">AI question drafts</h2>
    <QuestionDraftContext examId={examId} onSaved={load} />
    <p>Generated questions stay outside the exam until you inspect and explicitly approve each one. Edit the text, topic and difficulty before approval.</p>
    {loading || loadedExam!==examId ? <p role="status">Loading question drafts…</p> : <>
      {!editable && <p role="status">Generation and review require an unpublished exam with no active student attempts.</p>}
      {!topics.length && <p role="status">Set the exam's topic coverage before generating question drafts.</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
        <label>Draft topic <select aria-label="Draft topic" value={topic} onChange={event => setTopic(event.target.value)} disabled={!editable || Boolean(busy)}>
          {!topics.length && <option value="">No approved topics</option>}
          {topics.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label>Draft difficulty <select aria-label="Draft difficulty" value={difficulty} onChange={event => setDifficulty(Number(event.target.value))} disabled={!editable || Boolean(busy)}>
          {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}/5</option>)}
        </select></label>
        <label>Number of drafts <input aria-label="Number of drafts" type="number" min={1} max={10} value={count} disabled={!editable || Boolean(busy)}
          onChange={event => setCount(Number(event.target.value))} style={{ width: 70 }} /></label>
        <button type="button" onClick={() => void generate()} disabled={!editable || !topic || Boolean(busy) || !Number.isInteger(count) || count < 1 || count > 10}>
          {busy === 'generate' ? 'Generating drafts…' : 'Generate drafts'}</button>
        <button type="button" disabled={Boolean(busy)} onClick={() => { setError(''); void load(); }}>Reload drafts</button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <div style={{ display: 'grid', gap: 16, marginTop: 20 }}>
        {drafts.map((draft, index) => <article key={draft.id} style={{ padding: 16, border: '1px solid #cbd5e1', borderRadius: 12 }}>
          <h3>Draft {index + 1} · {draft.status}</h3>
          {draft.status === 'pending' ? <>
            <label htmlFor={`draft-text-${draft.id}`}>Question text</label>
            <textarea id={`draft-text-${draft.id}`} value={edited(draft).question_text} maxLength={4000} disabled={!editable || Boolean(busy)}
              onChange={event => edit(draft, { question_text: event.target.value })} style={{ display: 'block', width: '100%', minHeight: 100, marginBlock: 8 }} />
            <label>Question topic <select aria-label={`Question topic for draft ${index + 1}`} value={edited(draft).topic} disabled={!editable || Boolean(busy)}
              onChange={event => edit(draft, { topic: event.target.value })}>
              {topics.map(value => <option key={value} value={value}>{value}</option>)}
            </select></label>{' '}
            <label>Question difficulty <select aria-label={`Question difficulty for draft ${index + 1}`} value={edited(draft).difficulty} disabled={!editable || Boolean(busy)}
              onChange={event => edit(draft, { difficulty: Number(event.target.value) })}>
              {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}/5</option>)}
            </select></label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              <button type="button" disabled={!editable || Boolean(busy) || !edited(draft).question_text.trim()} onClick={() => void review(draft, 'approve')}>Approve into question bank</button>
              <button type="button" disabled={!editable || Boolean(busy)} onClick={() => void review(draft, 'reject')}>Reject draft</button>
            </div>
          </> : <p>{draft.question_text}</p>}
        </article>)}
      </div>
    </>}
  </section>;
}
