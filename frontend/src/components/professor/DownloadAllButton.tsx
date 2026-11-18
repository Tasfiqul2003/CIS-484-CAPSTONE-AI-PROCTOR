import { Download } from 'lucide-react';
import './exam-downloads.css';

export default function DownloadAllButton({ sessionId, examId, disabled = false }: {
  sessionId?: string; examId?: string; disabled?: boolean;
}) {
  const path = sessionId ? `sessions/${encodeURIComponent(sessionId)}`
    : examId ? `templates/${encodeURIComponent(examId)}` : '';
  const label = sessionId ? 'Download all available files for this student (.zip)'
    : 'Download all submitted attempts for this exam (.zip)';
  const content = <><Download size={16} aria-hidden="true" />Download all</>;
  if (disabled || !path) return <button type="button" className="exam-download-all" disabled
    title="Available after exam submission">{content}</button>;
  // A native browser download avoids buffering recordings in JavaScript memory.
  return <a className="exam-download-all" href={`/api/exam/${path}/download-all`}
    download aria-label={label} title={label}>{content}</a>;
}
