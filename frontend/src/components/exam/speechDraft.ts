export type ConfirmedTranscript = {
  input_source: 'confirmed_transcript';
  transcript_draft_id: string;
  machine_draft: string;
  transcript_receipt: string;
};

export type SpeechDraftResponse = {
  request_id: string;
  transcript_draft_id: string;
  transcript_receipt: string;
  interaction_id: string;
  question_revision: string;
  sequence_num: number;
  text: string;
  source: 'machine_draft';
  status: 'review_required';
};

/** Correlation is checked in addition to server authorization; never attach a late draft. */
export function readSpeechDraft(value: unknown, requestId: string, sequence: number): SpeechDraftResponse {
  if (!value || typeof value !== 'object') throw new Error('The transcription response is invalid.');
  const result = value as Partial<SpeechDraftResponse>;
  if (result.request_id !== requestId || result.transcript_draft_id !== requestId
      || result.sequence_num !== sequence || result.source !== 'machine_draft'
      || result.status !== 'review_required' || typeof result.text !== 'string'
      || !result.text.trim() || result.text.length > 8000
      || typeof result.transcript_receipt !== 'string' || !result.transcript_receipt
      || result.transcript_receipt.length > 4096 || typeof result.interaction_id !== 'string'
      || !result.interaction_id || typeof result.question_revision !== 'string' || !result.question_revision) {
    throw new Error('The transcription no longer matches this question. Type your answer or transcribe again.');
  }
  return result as SpeechDraftResponse;
}

export function confirmedTranscript(draft: SpeechDraftResponse): ConfirmedTranscript {
  return { input_source: 'confirmed_transcript', transcript_draft_id: draft.transcript_draft_id,
    machine_draft: draft.text, transcript_receipt: draft.transcript_receipt };
}
