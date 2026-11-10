import type { ExamTiming } from "../../pages/student/examTiming";

export const assistanceActions = ["repeat", "clarification", "hint", "explanation", "correctness"] as const;
export type AssistanceAction = typeof assistanceActions[number];
export type AssistanceAllowance = { limit: number; used: number; remaining: number; timerContinues: boolean };
export type AssistanceState = ExamTiming & {
  session_id: string; question_sequence_num: number; mode: "practice" | "assessed";
  actions: Partial<Record<AssistanceAction, AssistanceAllowance>>;
  active_request_id?: string | null;
};
export type AssistanceResult = AssistanceState & {
  request_id: string; action: AssistanceAction; status: "reserved" | "succeeded" | "failed"; text: string | null;
};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function readAssistanceState(value: unknown, sessionId: string, question: number): AssistanceState {
  const invalid = () => new Error("The server returned invalid question assistance. Reload this attempt to continue.");
  if (!record(value) || value.session_id !== sessionId || !["practice", "assessed"].includes(String(value.mode))) throw invalid();
  const usage = record(value.usage) ? value.usage : value;
  if (usage.question_sequence_num !== question || !record(usage.actions)) throw invalid();
  const actions: AssistanceState["actions"] = {};
  for (const [key, item] of Object.entries(usage.actions)) {
    if (!assistanceActions.includes(key as AssistanceAction) || !record(item) ||
        !Number.isInteger(item.limit) || Number(item.limit) < 1 || Number(item.limit) > 10 ||
        !Number.isInteger(item.used) || Number(item.used) < 0 || Number(item.used) > Number(item.limit) ||
        item.remaining !== Number(item.limit) - Number(item.used) || typeof item.timerContinues !== "boolean") throw invalid();
    actions[key as AssistanceAction] = { limit: Number(item.limit), used: Number(item.used), remaining: Number(item.remaining), timerContinues: item.timerContinues };
  }
  const timestamp = (item: unknown) => typeof item === "string" && Number.isFinite(Date.parse(item));
  if (!timestamp(value.server_now) || (value.deadline !== null && !timestamp(value.deadline)) ||
      (value.question_deadline !== null && !timestamp(value.question_deadline)) ||
      (value.pause_until !== undefined && value.pause_until !== null && !timestamp(value.pause_until))) throw invalid();
  if (value.active_request_id !== undefined && value.active_request_id !== null &&
      (typeof value.active_request_id !== "string" || !value.active_request_id.trim())) throw invalid();
  return {
    session_id: sessionId, question_sequence_num: question, mode: value.mode as "practice" | "assessed", actions,
    server_now: value.server_now as string, deadline: value.deadline as string | null,
    question_deadline: value.question_deadline as string | null,
    ...(value.pause_until !== undefined ? { pause_until: value.pause_until as string | null } : {}),
    ...(value.active_request_id !== undefined ? { active_request_id: value.active_request_id as string | null } : {}),
  };
}

export type PendingAssistanceRequest = { id: string; action: AssistanceAction; sequence: number; answer?: string };
/** Replay the original payload, including correctness text, when recovering a lost response. */
export function pendingAssistanceRequest(previous: PendingAssistanceRequest | null, sequence: number,
  action: AssistanceAction, answer: string, newId: () => string): PendingAssistanceRequest {
  return previous?.sequence === sequence && previous.action === action ? previous : {
    id: newId(), sequence, action, ...(action === "correctness" ? { answer: answer.trim() } : {}),
  };
}

export function readAssistanceResult(value: unknown, sessionId: string, question: number, requestId: string): AssistanceResult {
  const state = readAssistanceState(value, sessionId, question);
  if (!record(value) || value.request_id !== requestId || !assistanceActions.includes(value.action as AssistanceAction) ||
      !["reserved", "succeeded", "failed"].includes(String(value.status)) ||
      (value.text !== null && typeof value.text !== "string") ||
      (value.status === "succeeded" && (typeof value.text !== "string" || !value.text.trim()))) {
    throw new Error("The server returned an invalid assistance response.");
  }
  return { ...state, request_id: requestId, action: value.action as AssistanceAction,
    status: value.status as AssistanceResult["status"], text: value.text as string | null };
}

function endpoint(sessionId: string, token: string) {
  if (!sessionId.trim() || !token.trim()) throw new Error("Session authorization is required for assistance.");
  return `/api/exam/sessions/${encodeURIComponent(sessionId)}/assistance`;
}
async function body(response: Response): Promise<unknown> {
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    throw new Error(record(value) && typeof value.detail === "string" ? value.detail : `Question assistance is unavailable (HTTP ${response.status}).`);
  }
  return response.json();
}
export async function loadAssistance(sessionId: string, token: string, question: number, signal?: AbortSignal) {
  return readAssistanceState(await body(await fetch(endpoint(sessionId, token), {
    headers: { Authorization: `Bearer ${token}` }, signal,
  })), sessionId, question);
}
export async function requestAssistance(sessionId: string, token: string, question: number,
  action: AssistanceAction, requestId: string, answer?: string) {
  if (!assistanceActions.includes(action)) throw new Error("Choose an available assistance action.");
  if (action === "correctness" && (!answer?.trim() || answer.length > 20000)) throw new Error("Enter a response of at most 20,000 characters before requesting feedback.");
  return readAssistanceResult(await body(await fetch(endpoint(sessionId, token), {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ question_sequence_num: question, action, request_id: requestId,
      ...(action === "correctness" ? { answer_transcript: answer!.trim() } : {}) }),
  })), sessionId, question, requestId);
}
export async function completeAssistance(sessionId: string, token: string, question: number, requestId: string) {
  return readAssistanceResult(await body(await fetch(`${endpoint(sessionId, token)}/${encodeURIComponent(requestId)}/complete`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}",
    keepalive: true,
  })), sessionId, question, requestId);
}
