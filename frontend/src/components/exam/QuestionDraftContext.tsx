import { useCallback, useEffect, useState } from 'react';
import { useRequestScope } from './useRequestScope';
import type { RequestScope } from './useRequestScope';

type Criterion = { name: string; description: string; max_score: string };
type Props = { examId: string; onSaved: () => Promise<void> };
type ContextView={topic_coverage_required:string[];rubric:unknown;context_hash:string;can_edit:boolean;notice?:string|null};

export default function QuestionDraftContext({ examId, onSaved }: Props) {
  const [topics, setTopics] = useState('');
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [savedRubric, setSavedRubric] = useState<unknown>({});
  const [hash, setHash] = useState('');
  const [editable, setEditable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lockMessage,setLockMessage]=useState('');
  const [loadedExam,setLoadedExam]=useState('');
  const {capture,isCurrent,json}=useRequestScope(examId);
  function apply(value:ContextView) {
    setTopics(value.topic_coverage_required.join('\n')); setSavedRubric(value.rubric);
    const rubric = value.rubric as { criteria?: Array<{ name: string; description?: string; max_score: number }> } | null;
    setCriteria(Array.isArray(rubric?.criteria) ? rubric.criteria.map(item => ({ name: item.name,
      description: item.description ?? '', max_score: String(item.max_score) })) : []);
    setHash(value.context_hash); setEditable(value.can_edit); setLockMessage(value.notice ?? "");
  }
  const load=useCallback(async(expected?:RequestScope)=>{
    const scope=expected??capture();
    if (!isCurrent(scope)) return;
    setLoading(true);setError('');
    try {
      const value=await json<ContextView>(scope,`/api/exam/templates/${encodeURIComponent(scope.owner)}/question-drafts/context`,{credentials:'include'});
      if (isCurrent(scope)) apply(value);
    } catch (failure) {
      if (isCurrent(scope)) setError(failure instanceof DOMException && failure.name==='AbortError'
        ? 'Loading assessment context timed out. Your current edits are preserved.'
        : failure instanceof Error?failure.message:'Assessment context could not be loaded.');
    } finally {if (isCurrent(scope)) {setLoadedExam(scope.owner);setLoading(false);}}
  },[capture,isCurrent,json]);
  useEffect(()=>{
    setTopics('');setCriteria([]);setSavedRubric({});setHash('');setEditable(false);
    setLoading(true);setLoadedExam('');setSaving(false);setError('');setNotice('');setLockMessage('');
    void load();
  },[load]);
  function edit(index: number, patch: Partial<Criterion>) {
    setCriteria(current => current.map((item, i) => i === index ? { ...item, ...patch } : item));
  }
  async function save() {
    if (saving || !editable || loadedExam!==examId) return;
    const scope=capture();
    const parsedTopics = topics.split('\n').map(value => value.trim()).filter(Boolean);
    if (!parsedTopics.length || parsedTopics.length > 50 || !criteria.length
        || criteria.some(item => !item.name.trim() || !item.max_score.trim() || !Number.isFinite(Number(item.max_score)) || Number(item.max_score) <= 0 || Number(item.max_score) > 1000)) {
      setError('Enter exam topics and at least one named criterion with a finite positive maximum score.'); return;
    }
    setSaving(true); setError(''); setNotice('');
    try {
      const value=await json<ContextView>(scope,`/api/exam/templates/${encodeURIComponent(scope.owner)}/question-drafts/context`,{
        method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({topic_coverage_required:parsedTopics,expected_context_hash:hash,
          rubric:{criteria:criteria.map(item=>({name:item.name.trim(),description:item.description,max_score:Number(item.max_score)}))}}),
      },60000);
      if (!isCurrent(scope)) return;
      apply(value);await onSaved();
      if (isCurrent(scope)) setNotice('Topics and rubric saved for this unpublished exam. Publishing remains a separate action.');
    } catch (failure) {
      if (isCurrent(scope)) setError(failure instanceof DOMException && failure.name==='AbortError'
        ? 'Saving assessment context timed out. Reload to verify before retrying.'
        : failure instanceof Error?failure.message:'Assessment context could not be saved.');
    } finally {if (isCurrent(scope)) setSaving(false);}
  }

  return <details style={{ marginBlock: 16 }}>
    <summary>Professor topics and assessment rubric</summary>
    <p>Configure the topics and rubric before publishing. Changes stay local in this editor until you select Save topics and rubric.</p>
    {loading || loadedExam!==examId ? <p role="status">Loading saved assessment context…</p> : <>
      {!editable && <p role="status">{lockMessage || "Assessment context is locked while this exam is published or has active attempts."}</p>}
      <label htmlFor="draft-context-topics">Exam topics, one per line</label>
      <textarea id="draft-context-topics" value={topics} disabled={!editable || saving} maxLength={10050}
        onChange={event => setTopics(event.target.value)} style={{ display: 'block', width: '100%', minHeight: 80, marginBlock: 8 }} />
      {criteria.map((item, index) => <fieldset key={index} disabled={!editable || saving} style={{ marginBlock: 12 }}>
        <legend>Rubric criterion {index + 1}</legend>
        <label>Criterion name <input aria-label={`Criterion ${index + 1} name`} value={item.name} maxLength={120}
          onChange={event => edit(index, { name: event.target.value })} /></label>{' '}
        <label>Maximum score <input aria-label={`Criterion ${index + 1} maximum score`} type="number" min="0.01" max="1000" step="any" value={item.max_score}
          onChange={event => edit(index, { max_score: event.target.value })} /></label>
        <label style={{ display: 'block' }}>Criterion description <textarea aria-label={`Criterion ${index + 1} description`} value={item.description} maxLength={2000}
          onChange={event => edit(index, { description: event.target.value })} style={{ display: 'block', width: '100%', minHeight: 60 }} /></label>
        <button type="button" onClick={() => setCriteria(current => current.filter((_, i) => i !== index))}>Remove criterion {index + 1}</button>
      </fieldset>)}
      {!criteria.length && <p>The saved rubric has no editable criteria. Add criteria and save explicitly to replace it.</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" disabled={!editable || saving || criteria.length >= 20} onClick={() => setCriteria(current => [...current, { name: '', description: '', max_score: '' }])}>Add rubric criterion</button>
        <button type="button" disabled={!editable || saving || !hash} onClick={() => void save()}>{saving ? 'Saving assessment context…' : 'Save topics and rubric'}</button>
        <button type="button" disabled={saving} onClick={() => void load()}>Reload saved context (discard local edits)</button>
      </div>
      <details><summary>Currently saved rubric</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(savedRubric, null, 2)}</pre></details>
    </>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </details>;
}
