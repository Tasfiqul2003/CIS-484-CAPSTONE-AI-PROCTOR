import { isValidPreviewImage } from "./settings";
import { validatePreferences } from "../student-settings/studentSettings";
import type { StudentPolicy, StudentPreferences } from "../student-settings/studentSettings";

export type PresentationPolicy = Omit<StudentPolicy, "mode" | "assistance">;
export type SessionPresentation = {
  session_id: string;
  revision: number;
  voice_profile: "calm" | "clear";
  policy: PresentationPolicy;
  preferences: StudentPreferences;
};

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const speed = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= .5 && value <= 2;

// The shared preference validator needs assistance metadata, but preferences can
// never enable or configure assistance. Live allowances come from a separate API.
function preferencePolicy(policy: PresentationPolicy): StudentPolicy {
  const off = { enabled: false, limit: 0, timerContinues: true };
  return { ...policy, mode: "assessed", assistance: {
    repeat: off, clarification: off, hint: off, explanation: off, correctness: off,
  } };
}

export function readSessionPresentation(value: unknown, expectedSession: string): SessionPresentation {
  const invalid = () => new Error("The server returned invalid exam presentation settings.");
  if (!record(value) || value.session_id !== expectedSession || !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 0 || (value.voice_profile !== "calm" && value.voice_profile !== "clear") || !record(value.policy)) throw invalid();
  const raw = value.policy;
  if (!record(raw.defaults)) throw invalid();
  const d = raw.defaults;
  for (const key of ["allowAvatar", "allowBackground", "allowSpeed"]) if (typeof raw[key] !== "boolean") throw invalid();
  if (!speed(raw.minSpeed) || !speed(raw.maxSpeed) || raw.minSpeed > raw.maxSpeed ||
      !speed(d.speed) || typeof d.reducedMotion !== "boolean" || typeof d.animation !== "boolean" ||
      typeof d.voiceLabel !== "string" || !d.voiceLabel.trim()) throw invalid();
  const image = (value: unknown): value is string | null => value === null || isValidPreviewImage(value);
  if (!image(d.customAvatar) || !image(d.customBackground)) throw invalid();
  const choices = (value: unknown, permitted: string[]) => {
    if (!Array.isArray(value) || value.length === 0) throw invalid();
    const result = value.map(item => {
      if (!record(item) || typeof item.id !== "string" || !permitted.includes(item.id) ||
          typeof item.label !== "string" || !item.label.trim()) throw invalid();
      return { id: item.id, label: item.label };
    });
    if (new Set(result.map(item => item.id)).size !== result.length) throw invalid();
    return result;
  };
  const avatarChoices = choices(raw.avatarChoices, ["guide", "geometric", ...(d.customAvatar ? ["custom"] : [])]);
  const backgroundChoices = choices(raw.backgroundChoices, ["neutral", "library", ...(d.customBackground ? ["custom"] : [])]);
  if (typeof d.avatar !== "string" || !avatarChoices.some(choice => choice.id === d.avatar) ||
      typeof d.background !== "string" || !backgroundChoices.some(choice => choice.id === d.background)) throw invalid();
  const policy: PresentationPolicy = {
    defaults: {
      avatar: d.avatar, background: d.background, customAvatar: d.customAvatar, customBackground: d.customBackground,
      voiceLabel: d.voiceLabel, speed: d.speed, reducedMotion: d.reducedMotion, animation: d.animation,
    },
    allowAvatar: raw.allowAvatar as boolean, allowBackground: raw.allowBackground as boolean, allowSpeed: raw.allowSpeed as boolean,
    avatarChoices, backgroundChoices,
    minSpeed: raw.allowSpeed ? raw.minSpeed : d.speed, maxSpeed: raw.allowSpeed ? raw.maxSpeed : d.speed,
  };
  if (validatePreferences(value.preferences, preferencePolicy(policy)).length) throw invalid();
  const p = value.preferences as StudentPreferences;
  return {
    session_id: expectedSession, revision: Number(value.revision), voice_profile: value.voice_profile as "calm" | "clear", policy,
    preferences: { volume: p.volume, textSize: p.textSize, reducedMotion: p.reducedMotion, avatar: p.avatar, background: p.background, speed: p.speed },
  };
}

async function readResponse(response: Response, sessionId: string) {
  if (!response.ok) throw new Error(`Unable to load or save exam presentation (HTTP ${response.status}).`);
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error("The server returned unreadable presentation settings."); }
  return readSessionPresentation(value, sessionId);
}

function endpoint(sessionId: string, token: string) {
  if (!sessionId.trim() || !token.trim()) throw new Error("Session authorization is required for presentation settings.");
  return `/api/exam/sessions/${encodeURIComponent(sessionId)}/presentation`;
}

export async function loadSessionPresentation(sessionId: string, token: string, signal?: AbortSignal) {
  return readResponse(await fetch(endpoint(sessionId, token), { headers: { Authorization: `Bearer ${token}` }, signal }), sessionId);
}

export async function saveSessionPresentation(sessionId: string, token: string, preferences: StudentPreferences) {
  const { volume, textSize, reducedMotion, avatar, background, speed } = preferences;
  return readResponse(await fetch(endpoint(sessionId, token), {
    method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ volume, textSize, reducedMotion, avatar, background, speed }),
  }), sessionId);
}
