import { readSessionPresentation, type SessionPresentation } from "./sessionPresentation";
import type { StudentPreferences } from "../student-settings/studentSettings";

export type EnvironmentPresentation = SessionPresentation & { notice: string | null };

export function readEnvironmentPresentation(value: unknown, examId: string): EnvironmentPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid environment preview.");
  const raw = value as Record<string, unknown>;
  if (raw.exam_id !== examId || (raw.notice !== null && typeof raw.notice !== "string")) throw new Error("Invalid environment preview.");
  const presentation = readSessionPresentation({ ...raw, session_id: examId }, examId);
  return { ...presentation, notice: raw.notice as string | null };
}

export async function environmentPresentation(examId: string, token: string, signal?: AbortSignal,
  save?: { preferences: StudentPreferences; expected_revision: number }) {
  if (!examId || !token) throw new Error("Exam authorization is missing. Return to your exam list.");
  const response = await fetch(`/api/exam/templates/${encodeURIComponent(examId)}/student-presentation`, {
    method: save ? "PUT" : "GET", signal,
    headers: { Authorization: `Bearer ${token}`, ...(save ? { "Content-Type": "application/json" } : {}) },
    ...(save ? { body: JSON.stringify(save) } : {}),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof value?.detail === "string" ? value.detail : `Environment preview is unavailable (HTTP ${response.status}).`);
  return readEnvironmentPresentation(value, examId);
}
