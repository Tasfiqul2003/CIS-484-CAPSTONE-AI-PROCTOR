export type AnswerMetadata = {
  input_source?: 'typed' | 'confirmed_transcript' | 'automatic_transcript' | 'unanswered_voice';
  transcript_draft_id?: string;
  machine_draft?: string;
  transcript_receipt?: string;
  answer_timestamp_start?: number;
  answer_timestamp_end?: number;
};
export type PendingAnswer = AnswerMetadata & {
  request_id: string;
  session_id: string;
  question_sequence_num: number;
  answer_transcript: string;
  draft: string;
};

/** A lost response retries the identical operation even if the clock expires meanwhile. */
export function pendingAnswer(previous: PendingAnswer | null, session: string, sequence: number,
  draft: string, timedOut: boolean, newId: () => string, metadata: AnswerMetadata = {}): PendingAnswer {
  if (previous?.session_id === session && previous.question_sequence_num === sequence && previous.draft === draft) return previous;
  return { request_id: newId(), session_id: session, question_sequence_num: sequence,
    answer_transcript: timedOut ? "" : draft.trim(), draft,
    input_source: metadata.input_source ?? 'typed',
    transcript_draft_id: metadata.transcript_draft_id,
    machine_draft: metadata.machine_draft,
    transcript_receipt: metadata.transcript_receipt,
    answer_timestamp_start: metadata.answer_timestamp_start,
    answer_timestamp_end: metadata.answer_timestamp_end };
}
