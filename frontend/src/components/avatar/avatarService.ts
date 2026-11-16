// Client for the backend's /avatar bridge (backend/app/avatar_bridge.py).
// The talking avatar and spoken answers are optional: when the server has no avatar
// service, every exam still works with the built-in examiner and typed answers.

export interface AvatarStatus {
  enabled: boolean;
  ready: boolean;
  speech_input?: boolean;
  progress?: string;
}

export interface AvatarClip {
  url: string;
  text: string;
  audio_s?: number;
}

export async function fetchAvatarStatus(signal?: AbortSignal): Promise<AvatarStatus> {
  try {
    const response = await fetch("/api/avatar/status", { signal });
    if (!response.ok) return { enabled: false, ready: false };
    return await response.json() as AvatarStatus;
  } catch {
    return { enabled: false, ready: false };
  }
}

/** Splits an NDJSON byte stream into parsed events. Exported for tests. */
export function ndjsonLines(buffer: string): { events: unknown[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const events: unknown[] = [];
  for (const part of parts) {
    const line = part.trim();
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip a malformed line */ }
  }
  return { events, rest };
}

/** Asks the avatar to speak `text`; calls onClip for each sentence clip as soon as it is rendered.
 *  `lead` is a short stock line from the server ("Thank you.") said before the text. */
export async function streamAvatarSpeech(sessionId: string, token: string, text: string,
  onClip: (clip: AvatarClip) => void, signal?: AbortSignal, lead = ""): Promise<void> {
  const response = await fetch(`/api/avatar/sessions/${encodeURIComponent(sessionId)}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(lead ? { text, lead } : { text }),
    signal,
  });
  if (!response.ok || !response.body) {
    let detail = "";
    try { detail = (await response.json() as { detail?: string }).detail ?? ""; } catch { /* no body */ }
    throw new Error(detail || `The avatar could not speak (${response.status}).`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const { events, rest } = ndjsonLines(done ? buffer + "\n" : buffer);
    buffer = rest;
    for (const raw of events) {
      const event = raw as { type?: string; url?: string; text?: string; audio_s?: number; message?: string };
      if (event.type === "clip" && typeof event.url === "string" && event.url.startsWith("/api/avatar/media/")) {
        onClip({ url: event.url, text: event.text ?? "", audio_s: event.audio_s });
      } else if (event.type === "error") {
        throw new Error(event.message || "The avatar could not finish this clip.");
      } else if (event.type === "done") {
        return;
      }
    }
    if (done) return;
  }
}

/** Sends a recorded answer for transcription; resolves to the text for the student to review. */
export async function transcribeAnswer(sessionId: string, token: string, audio: Blob): Promise<string> {
  const response = await fetch(`/api/avatar/sessions/${encodeURIComponent(sessionId)}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": audio.type || "application/octet-stream", Authorization: `Bearer ${token}` },
    body: audio,
  });
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json() as { detail?: string }).detail ?? ""; } catch { /* no body */ }
    throw new Error(detail || `Transcription failed (${response.status}).`);
  }
  return ((await response.json()) as { text?: string }).text?.trim() ?? "";
}

/** Professor preview: the active avatar says a short line. Same NDJSON clip stream as the exam. */
export async function streamProfessorPreview(onClip: (clip: AvatarClip) => void, signal?: AbortSignal): Promise<void> {
  const response = await fetch("/api/avatar/professor/preview", { method: "POST", credentials: "include", signal });
  if (!response.ok || !response.body) {
    let detail = "";
    try { detail = (await response.json() as { detail?: string }).detail ?? ""; } catch { /* no body */ }
    throw new Error(detail || `The preview could not play (${response.status}).`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const { events, rest } = ndjsonLines(done ? buffer + "\n" : buffer);
    buffer = rest;
    for (const raw of events) {
      const event = raw as { type?: string; url?: string; text?: string; message?: string };
      if (event.type === "clip" && typeof event.url === "string" && event.url.startsWith("/api/avatar/media/")) {
        onClip({ url: event.url, text: event.text ?? "" });
      } else if (event.type === "error") {
        throw new Error(event.message || "The avatar could not finish the preview.");
      } else if (event.type === "done") {
        return;
      }
    }
    if (done) return;
  }
}

/** The examiner's still photo as an object URL ("" when there is none). The caller revokes it. */
/** A short looping clip of the examiner waiting. Empty when the avatar has not made one. */
export async function fetchExaminerIdle(sessionId: string, token: string, signal?: AbortSignal): Promise<string> {
  try {
    const response = await fetch(`/api/avatar/sessions/${encodeURIComponent(sessionId)}/idle`, {
      headers: { Authorization: `Bearer ${token}` }, signal,
    });
    if (!response.ok) return "";
    const data = await response.json() as { url?: string };
    return data.url ?? "";
  } catch {
    return "";
  }
}

export async function fetchExaminerPoster(sessionId: string, token: string, signal?: AbortSignal): Promise<string> {
  try {
    const response = await fetch(`/api/avatar/sessions/${encodeURIComponent(sessionId)}/poster`, {
      headers: { Authorization: `Bearer ${token}` }, signal,
    });
    if (!response.ok) return "";
    return URL.createObjectURL(await response.blob());
  } catch {
    return "";
  }
}
