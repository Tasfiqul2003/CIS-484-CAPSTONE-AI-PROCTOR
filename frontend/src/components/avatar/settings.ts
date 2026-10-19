/** Validated exam permission settings. Live exam delivery and attempt enforcement are separate integrations. */
export const AVATARS = [
  { id: 'guide', label: 'Guide avatar (preview)' },
  { id: 'geometric', label: 'Geometric avatar (preview)' },
] as const

export const BACKGROUNDS = [
  { id: 'neutral', label: 'Neutral background (preview)' },
  { id: 'library', label: 'Library background (preview)' },
] as const

export const VOICES = [
  { id: 'calm', label: 'Calm voice (preview)' },
  { id: 'clear', label: 'Clear voice (preview)' },
] as const

export const MAX_PREVIEW_IMAGE_BYTES = 1_048_576

/** Accept bounded raster data URLs only; no remote URLs, SVG, or executable formats. */
export function isValidPreviewImage(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_PREVIEW_IMAGE_BYTES / 3) * 4 + 32) return false
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match) return false
  const [, format, encoded] = match
  if (encoded.length % 4 !== 0) return false
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  const bytes = encoded.length / 4 * 3 - padding
  if (bytes <= 0 || bytes > MAX_PREVIEW_IMAGE_BYTES) return false
  try {
    const signature = atob(encoded.slice(0, 16))
    if (format === 'png') return signature.startsWith('\x89PNG\r\n\x1a\n')
    if (format === 'jpeg') return signature.startsWith('\xff\xd8\xff')
    return signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP'
  } catch {
    return false
  }
}

export type Action = 'repeat' | 'clarification' | 'hint' | 'explanation' | 'correctness'
export type Mode = 'practice' | 'assessed' | 'both'
export type AssistancePolicy = { enabled: boolean; modes: Mode; limit: number; timerContinues: boolean }

export type Settings = {
  presentation: {
    avatar: string
    background: string
    customAvatar: string | null
    customBackground: string | null
    voice: string
    speed: number
    animation: boolean
    reducedMotion: boolean
    stateLabels: boolean
  }
  student: {
    avatar: boolean
    background: boolean
    speed: boolean
    avatars: string[]
    backgrounds: string[]
    minSpeed: number
    maxSpeed: number
  }
  assistance: Record<Action, AssistancePolicy>
  behavior: {
    followUps: number
    order: 'authored' | 'random'
    responseTiming: 'exam' | 'fixed'
    responseSeconds: number
    responseUnit: 'seconds' | 'minutes'
  }
}

const ACTIONS: Action[] = ['repeat', 'clarification', 'hint', 'explanation', 'correctness']

/** Return independent values so resetting one exam never changes another draft. */
export function defaultSettings(): Settings {
  return {
    presentation: {
      avatar: 'guide', background: 'neutral', voice: 'calm', speed: 1,
      customAvatar: null, customBackground: null,
      animation: true, reducedMotion: false, stateLabels: true,
    },
    student: {
      avatar: false, background: false, speed: false,
      avatars: AVATARS.map(({ id }) => id), backgrounds: BACKGROUNDS.map(({ id }) => id),
      minSpeed: 0.8, maxSpeed: 1.2,
    },
    assistance: {
      repeat: { enabled: true, modes: 'both', limit: 2, timerContinues: true },
      clarification: { enabled: true, modes: 'both', limit: 1, timerContinues: true },
      hint: { enabled: false, modes: 'practice', limit: 1, timerContinues: true },
      explanation: { enabled: false, modes: 'practice', limit: 1, timerContinues: true },
      correctness: { enabled: false, modes: 'practice', limit: 1, timerContinues: true },
    },
    behavior: {
      followUps: 1, order: 'authored', responseTiming: 'exam', responseSeconds: 120,
      responseUnit: 'seconds',
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate untrusted saved data as well as form values; do not coerce values. */
export function validateSettings(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['Settings must be an object.']
  const section = (key: string): Record<string, unknown> => {
    if (!isRecord(value[key])) {
      errors.push(`${key} settings must be an object.`)
      return {}
    }
    return value[key]
  }
  const boolean = (data: Record<string, unknown>, key: string, label: string) => {
    if (typeof data[key] !== 'boolean') errors.push(`${label} must be on or off.`)
  }
  const choice = (item: unknown, choices: readonly string[], label: string) => {
    if (typeof item !== 'string' || !choices.includes(item)) errors.push(`${label} must use an available choice.`)
  }
  const number = (item: unknown, minimum: number, maximum: number, label: string, integer = false) => {
    if (typeof item !== 'number' || !Number.isFinite(item) || item < minimum || item > maximum || (integer && !Number.isInteger(item))) {
      errors.push(`${label} must be ${integer ? 'a whole number' : 'a number'} from ${minimum} to ${maximum}.`)
    }
  }
  const selection = (item: unknown, choices: readonly string[], label: string): item is string[] => {
    if (!Array.isArray(item) || [...item].some((entry) => typeof entry !== 'string' || !choices.includes(entry)) || new Set(item).size !== item.length) {
      errors.push(`${label} must contain unique available choices.`)
      return false
    }
    return true
  }
  const presentation = section('presentation')
  const avatarChoices: string[] = AVATARS.map(({ id }) => id)
  const backgroundChoices: string[] = BACKGROUNDS.map(({ id }) => id)
  if (isValidPreviewImage(presentation.customAvatar)) avatarChoices.push('custom')
  else if (presentation.customAvatar !== null) errors.push('Custom avatar must be a PNG, JPEG, or WebP image of no more than 1 MiB.')
  if (isValidPreviewImage(presentation.customBackground)) backgroundChoices.push('custom')
  else if (presentation.customBackground !== null) errors.push('Custom background must be a PNG, JPEG, or WebP image of no more than 1 MiB.')
  choice(presentation.avatar, avatarChoices, 'Default avatar')
  choice(presentation.background, backgroundChoices, 'Default background')
  choice(presentation.voice, VOICES.map(({ id }) => id), 'Default voice')
  number(presentation.speed, 0.5, 2, 'Default speaking speed')
  boolean(presentation, 'animation', 'Animation')
  boolean(presentation, 'reducedMotion', 'Reduced motion')
  if (presentation.stateLabels !== true) errors.push('Visible state labels must remain available.')

  const student = section('student')
  for (const key of ['avatar', 'background', 'speed']) boolean(student, key, `Student ${key} control`)
  const lists = [
    ['avatar', 'avatars', avatarChoices],
    ['background', 'backgrounds', backgroundChoices],
  ] as const
  for (const [toggle, key, choices] of lists) {
    const allowed = student[key]
    if (selection(allowed, choices, `Allowed ${key}`) && student[toggle] === true) {
      if (allowed.length === 0) errors.push(`Allow at least one student ${toggle} choice.`)
      if (!allowed.includes(presentation[toggle] as string)) errors.push(`Default ${toggle} must be in the allowed student choices.`)
    }
  }
  number(student.minSpeed, 0.5, 2, 'Minimum speaking speed')
  number(student.maxSpeed, 0.5, 2, 'Maximum speaking speed')
  if (typeof student.minSpeed === 'number' && typeof student.maxSpeed === 'number' && student.minSpeed > student.maxSpeed) {
    errors.push('Minimum speaking speed must not exceed maximum speaking speed.')
  }
  if (student.speed === true && typeof presentation.speed === 'number' && typeof student.minSpeed === 'number' && typeof student.maxSpeed === 'number' && (presentation.speed < student.minSpeed || presentation.speed > student.maxSpeed)) {
    errors.push('Default speaking speed must be within the permitted student range.')
  }

  const assistance = section('assistance')
  for (const action of ACTIONS) {
    const policy = assistance[action]
    if (!isRecord(policy)) {
      errors.push(`${action} policy must be an object.`)
      continue
    }
    boolean(policy, 'enabled', `${action} availability`)
    boolean(policy, 'timerContinues', `${action} timer behavior`)
    choice(policy.modes, ['practice', 'assessed', 'both'], `${action} mode`)
    number(policy.limit, 0, 10, `${action} limit`, true)
    if (policy.enabled === true && policy.limit === 0) errors.push(`Enabled ${action} must allow at least one use.`)
  }

  const behavior = section('behavior')
  number(behavior.followUps, 0, 5, 'Follow-up limit', true)
  choice(behavior.order, ['authored', 'random'], 'Question ordering')
  choice(behavior.responseTiming, ['exam', 'fixed'], 'Response timing')
  number(behavior.responseSeconds, 10, 600, 'Response time in seconds', true)
  choice(behavior.responseUnit, ['seconds', 'minutes'], 'Response time display unit')
  return errors
}

export function isAvailable(policy: AssistancePolicy, mode: 'practice' | 'assessed'): boolean {
  return policy.enabled && policy.limit > 0 && (policy.modes === 'both' || policy.modes === mode)
}

/** A small replaceable adapter: only known mock settings are written to browser storage. */
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type DraftResult = { settings: Settings | null; error?: string }

function draftKey(examId: string, instructorId: string): string {
  if (typeof examId !== 'string' || !examId.trim() || typeof instructorId !== 'string' || !instructorId.trim()) {
    throw new Error('An exam identifier and instructor identifier are required for local drafts.')
  }
  return `oral-exam-avatar:v1:${JSON.stringify([examId, instructorId])}`
}

function cleanSettings(settings: Settings): Settings {
  const { presentation: p, student: s, assistance: a, behavior: b } = settings
  const policy = (action: Action): AssistancePolicy => ({
    enabled: a[action].enabled, modes: a[action].modes,
    limit: a[action].limit, timerContinues: a[action].timerContinues,
  })
  return {
    presentation: {
      avatar: p.avatar, background: p.background, voice: p.voice, speed: p.speed,
      customAvatar: p.customAvatar, customBackground: p.customBackground,
      animation: p.animation, reducedMotion: p.reducedMotion, stateLabels: p.stateLabels,
    },
    student: {
      avatar: s.avatar, background: s.background, speed: s.speed,
      avatars: [...s.avatars], backgrounds: [...s.backgrounds],
      minSpeed: s.minSpeed, maxSpeed: s.maxSpeed,
    },
    assistance: {
      repeat: policy('repeat'), clarification: policy('clarification'), hint: policy('hint'),
      explanation: policy('explanation'), correctness: policy('correctness'),
    },
    behavior: {
      followUps: b.followUps, order: b.order, responseTiming: b.responseTiming,
      responseSeconds: b.responseSeconds, responseUnit: b.responseUnit,
    },
  }
}

/** Upgrade the original prototype without modifying its saved draft until Save is chosen. */
function migrateV1(value: unknown): unknown {
  if (!isRecord(value)) return value
  const p = isRecord(value.presentation) ? value.presentation : {}
  const s = isRecord(value.student) ? value.student : {}
  const b = isRecord(value.behavior) ? value.behavior : {}
  return {
    presentation: {
      avatar: p.avatar, background: p.background, voice: p.voice, speed: p.speed,
      animation: p.animation, reducedMotion: p.reducedMotion, stateLabels: p.stateLabels,
      customAvatar: null, customBackground: null,
    },
    student: {
      avatar: s.avatar, background: s.background, speed: s.speed,
      avatars: s.avatars, backgrounds: s.backgrounds, minSpeed: s.minSpeed, maxSpeed: s.maxSpeed,
    },
    assistance: value.assistance,
    behavior: {
      followUps: b.followUps, order: b.order, responseTiming: b.responseTiming,
      responseSeconds: b.responseSeconds, responseUnit: 'seconds',
    },
  }
}

export function createDraftStore(storage?: DraftStorage) {
  const getStorage = (): DraftStorage => {
    const available = storage ?? globalThis.localStorage
    if (!available) throw new Error('Local draft storage is unavailable in this browser.')
    return available
  }
  return {
    load(examId: string, instructorId: string): DraftResult {
      try {
        const key = draftKey(examId, instructorId)
        const raw = getStorage().getItem(key)
        if (raw === null) return { settings: null }
        const envelope: unknown = JSON.parse(raw)
        if (!isRecord(envelope) || (envelope.version !== 1 && envelope.version !== 2)) throw new Error('The saved draft uses an unsupported format.')
        const candidate = envelope.version === 1 ? migrateV1(envelope.settings) : envelope.settings
        const errors = validateSettings(candidate)
        if (errors.length) throw new Error(`The saved draft is invalid: ${errors.join(' ')}`)
        return { settings: cleanSettings(candidate as Settings) }
      } catch (error) {
        return { settings: null, error: `Unable to load local draft. ${error instanceof Error ? error.message : 'Storage could not be read.'}` }
      }
    },
    save(examId: string, instructorId: string, settings: Settings): void {
      const key = draftKey(examId, instructorId)
      const errors = validateSettings(settings)
      if (errors.length) throw new Error(errors.join(' '))
      getStorage().setItem(key, JSON.stringify({ version: 2, settings: cleanSettings(settings) }))
    },
    remove(examId: string, instructorId: string): void {
      getStorage().removeItem(draftKey(examId, instructorId))
    },
  }
}
