import {
  AVATARS, BACKGROUNDS, VOICES, isAvailable, validateSettings,
  type Action, type Settings,
} from './settings'
import type { StudentPolicy } from '../student-settings/studentSettings'

export type ExamPolicy = {
  exam_id: string
  revision: number
  settings: Settings
  effective_for: 'new_attempts'
  assistance_scope: 'per_question'
  updated_at: string | null
}

type PolicyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const ACTIONS: Action[] = ['repeat', 'clarification', 'hint', 'explanation', 'correctness']

export class ExamPolicyError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'ExamPolicyError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function identifier(value: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new ExamPolicyError('An exam identifier is required.')
}

/** Copy only known validated policy fields; student preferences never become exam rules. */
function cleanSettings(value: unknown): Settings {
  const errors = validateSettings(value)
  if (errors.length) throw new ExamPolicyError(`Invalid exam policy. ${errors.join(' ')}`)
  const { presentation: p, student: s, assistance: a, behavior: b } = value as Settings
  const action = (key: Action) => ({
    enabled: a[key].enabled, modes: a[key].modes,
    limit: a[key].limit, timerContinues: a[key].timerContinues,
  })
  return {
    presentation: {
      avatar: p.avatar, background: p.background, customAvatar: p.customAvatar,
      customBackground: p.customBackground, voice: p.voice, speed: p.speed,
      animation: p.animation, reducedMotion: p.reducedMotion, stateLabels: p.stateLabels,
    },
    student: {
      avatar: s.avatar, background: s.background, speed: s.speed,
      avatars: [...s.avatars], backgrounds: [...s.backgrounds],
      minSpeed: s.minSpeed, maxSpeed: s.maxSpeed,
    },
    assistance: {
      repeat: action('repeat'), clarification: action('clarification'), hint: action('hint'),
      explanation: action('explanation'), correctness: action('correctness'),
    },
    behavior: {
      followUps: b.followUps, order: b.order, responseTiming: b.responseTiming,
      responseSeconds: b.responseSeconds, responseUnit: b.responseUnit,
    },
  }
}

function parsePolicy(value: unknown, expectedExamId?: string): ExamPolicy {
  if (!isRecord(value) || typeof value.exam_id !== 'string' || !value.exam_id.trim()
    || (expectedExamId !== undefined && value.exam_id !== expectedExamId)
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || value.effective_for !== 'new_attempts' || value.assistance_scope !== 'per_question'
    || (value.updated_at !== null && (typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))))) {
    throw new ExamPolicyError('The saved exam policy has an invalid or unsupported format.')
  }
  return {
    exam_id: value.exam_id, revision: value.revision, settings: cleanSettings(value.settings),
    effective_for: 'new_attempts', assistance_scope: 'per_question', updated_at: value.updated_at as string | null,
  }
}

/** An independent attempt snapshot: subsequent edits to the source cannot change these rules. */
export function snapshotPolicy(policy: ExamPolicy): ExamPolicy {
  return parsePolicy(policy)
}

/** Build only the student-facing presentation and assistance policy for the selected exam mode. */
export function toStudentPolicy(settings: Settings, mode: 'practice' | 'assessed'): StudentPolicy {
  const source = cleanSettings(settings)
  if (mode !== 'practice' && mode !== 'assessed') throw new ExamPolicyError('Choose practice or assessed exam mode.')
  const { presentation: p, student: s } = source
  const allAvatars = [
    ...AVATARS.map(({ id }) => ({ id: String(id), label: id === 'guide' ? 'Person icon (preview)' : 'Diamond icon (preview)' })),
    ...(p.customAvatar ? [{ id: 'custom', label: 'Instructor-uploaded avatar (preview)' }] : []),
  ]
  const allBackgrounds = [
    ...BACKGROUNDS.map(({ id, label }) => ({ id: String(id), label })),
    ...(p.customBackground ? [{ id: 'custom', label: 'Instructor-uploaded background (preview)' }] : []),
  ]
  const assistance = Object.fromEntries(ACTIONS.map(key => [key, {
    enabled: isAvailable(source.assistance[key], mode),
    limit: source.assistance[key].limit,
    timerContinues: source.assistance[key].timerContinues,
  }])) as StudentPolicy['assistance']
  return {
    mode,
    defaults: {
      avatar: p.avatar, background: p.background,
      customAvatar: p.customAvatar, customBackground: p.customBackground,
      voiceLabel: VOICES.find(({ id }) => id === p.voice)!.label,
      speed: p.speed, reducedMotion: p.reducedMotion, animation: p.animation,
    },
    allowAvatar: s.avatar, allowBackground: s.background, allowSpeed: s.speed,
    avatarChoices: allAvatars.filter(({ id }) => s.avatar ? s.avatars.includes(id) : id === p.avatar),
    backgroundChoices: allBackgrounds.filter(({ id }) => s.background ? s.backgrounds.includes(id) : id === p.background),
    // Locked defaults may be outside the optional student range; they must remain valid preferences.
    minSpeed: s.speed ? s.minSpeed : p.speed, maxSpeed: s.speed ? s.maxSpeed : p.speed,
    assistance,
  }
}

function localKey(examId: string, instructorId: string): string {
  identifier(examId)
  if (typeof instructorId !== 'string' || !instructorId.trim()) throw new ExamPolicyError('An instructor identifier is required for the local policy preview.')
  return `oral-exam-policy-preview:v1:${JSON.stringify([examId, instructorId])}`
}

function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ExamPolicyError('The expected exam policy revision must be a nonnegative whole number.')
}

/** Shared synthetic browser data only. Local storage and these IDs provide no authorization boundary. */
export function createLocalExamPolicyStore(storage?: PolicyStorage) {
  const getStorage = (): PolicyStorage => {
    const available = storage ?? globalThis.localStorage
    if (!available) throw new ExamPolicyError('Local exam policy preview storage is unavailable.')
    return available
  }
  const load = (examId: string, instructorId: string): ExamPolicy | null => {
    const raw = getStorage().getItem(localKey(examId, instructorId))
    if (raw === null) return null
    let envelope: unknown
    try { envelope = JSON.parse(raw) } catch { throw new ExamPolicyError('The local exam policy preview could not be read. Existing data was preserved.') }
    if (!isRecord(envelope) || envelope.version !== 1) throw new ExamPolicyError('The local exam policy preview uses an unsupported format. Existing data was preserved.')
    return parsePolicy(envelope.policy, examId)
  }
  return {
    load,
    save(examId: string, instructorId: string, settings: Settings, expectedRevision?: number): ExamPolicy {
      const key = localKey(examId, instructorId)
      const cleaned = cleanSettings(settings)
      if (expectedRevision !== undefined) revision(expectedRevision)
      const previous = load(examId, instructorId)
      const currentRevision = previous?.revision ?? 0
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
        throw new ExamPolicyError('This exam policy changed in another view. Reload it before saving.', 409)
      }
      if (currentRevision === Number.MAX_SAFE_INTEGER) throw new ExamPolicyError('The exam policy revision limit has been reached.')
      const saved: ExamPolicy = {
        exam_id: examId, revision: currentRevision + 1, settings: cleaned,
        effective_for: 'new_attempts', assistance_scope: 'per_question', updated_at: new Date().toISOString(),
      }
      getStorage().setItem(key, JSON.stringify({ version: 1, policy: saved }))
      return snapshotPolicy(saved)
    },
  }
}

async function readResponse(response: Response, examId: string): Promise<ExamPolicy> {
  if (!response.ok) {
    let detail = ''
    try {
      const body: unknown = await response.json()
      if (isRecord(body) && typeof body.detail === 'string') detail = ` ${body.detail.slice(0, 600)}`
    } catch { /* Preserve the HTTP failure when the error response is unreadable. */ }
    throw new ExamPolicyError(
      response.status === 409 ? 'This exam policy changed in another view. Reload it before saving.' : `Unable to access exam policy (HTTP ${response.status}).${detail}`,
      response.status,
    )
  }
  let value: unknown
  try { value = await response.json() } catch { throw new ExamPolicyError('The server returned an unreadable exam policy.') }
  return parsePolicy(value, examId)
}

/** Server transport is explicit: failures never fall back to browser policy data. */
export async function loadExamPolicy(examId: string, signal?: AbortSignal): Promise<ExamPolicy> {
  identifier(examId)
  return readResponse(await fetch(`/api/exam/templates/${encodeURIComponent(examId)}/avatar-policy`, {
    method: 'GET', credentials: 'include', signal,
  }), examId)
}

export async function saveExamPolicy(examId: string, settings: Settings, expectedRevision: number): Promise<ExamPolicy> {
  identifier(examId)
  revision(expectedRevision)
  const cleaned = cleanSettings(settings)
  return readResponse(await fetch(`/api/exam/templates/${encodeURIComponent(examId)}/avatar-policy`, {
    method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: cleaned, expected_revision: expectedRevision }),
  }), examId)
}
