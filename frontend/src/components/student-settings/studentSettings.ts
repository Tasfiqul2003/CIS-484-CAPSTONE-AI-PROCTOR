/** A standalone synthetic policy for the student settings demonstration only. */
export type Choice = { id: string; label: string }
export type StudentAction = 'repeat' | 'clarification' | 'hint' | 'explanation' | 'correctness'

export type StudentPreferences = {
  volume: number
  textSize: 16 | 20 | 24
  reducedMotion: boolean
  avatar: string
  background: string
  speed: number
}

export type StudentPolicy = {
  mode: 'practice' | 'assessed'
  defaults: {
    avatar: string
    background: string
    customAvatar?: string | null
    customBackground?: string | null
    voiceLabel: string
    speed: number
    reducedMotion: boolean
    animation: boolean
  }
  allowAvatar: boolean
  allowBackground: boolean
  allowSpeed: boolean
  avatarChoices: Choice[]
  backgroundChoices: Choice[]
  minSpeed: number
  maxSpeed: number
  assistance: Record<StudentAction, { enabled: boolean; limit: number; timerContinues: boolean }>
}

/** This policy never reads instructor drafts, browser preferences, or an API. */
export function getDemoPolicy(): StudentPolicy {
  return {
    mode: 'practice',
    defaults: {
      avatar: 'guide', background: 'neutral', voiceLabel: 'Calm voice (preview)',
      speed: 1, reducedMotion: false, animation: true,
    },
    allowAvatar: true, allowBackground: true, allowSpeed: true,
    avatarChoices: [
      { id: 'guide', label: 'Person icon (preview)' },
      { id: 'geometric', label: 'Diamond icon (preview)' },
    ],
    backgroundChoices: [
      { id: 'neutral', label: 'Neutral background (preview)' },
      { id: 'library', label: 'Library background (preview)' },
    ],
    minSpeed: 0.8, maxSpeed: 1.2,
    assistance: {
      repeat: { enabled: true, limit: 2, timerContinues: true },
      clarification: { enabled: true, limit: 1, timerContinues: true },
      hint: { enabled: true, limit: 1, timerContinues: true },
      explanation: { enabled: false, limit: 1, timerContinues: true },
      correctness: { enabled: false, limit: 1, timerContinues: true },
    },
  }
}

export function defaultPreferences(policy: StudentPolicy): StudentPreferences {
  return {
    volume: 70, textSize: 16, reducedMotion: policy.defaults.reducedMotion,
    avatar: policy.defaults.avatar, background: policy.defaults.background, speed: policy.defaults.speed,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Restrict saved personal preferences to the supplied current policy, without changing that policy. */
export function reconcilePreferences(value: unknown, policy: StudentPolicy): StudentPreferences {
  const defaults = defaultPreferences(policy)
  if (!isRecord(value)) return defaults
  const permittedChoice = (item: unknown, allowed: boolean, choices: Choice[], fallback: string) =>
    allowed && typeof item === 'string' && choices.some(({ id }) => id === item) ? item : fallback
  return {
    volume: finiteNumber(value.volume) ? Math.min(100, Math.max(0, value.volume)) : defaults.volume,
    textSize: value.textSize === 16 || value.textSize === 20 || value.textSize === 24 ? value.textSize : defaults.textSize,
    reducedMotion: policy.defaults.reducedMotion || (typeof value.reducedMotion === 'boolean' ? value.reducedMotion : defaults.reducedMotion),
    avatar: permittedChoice(value.avatar, policy.allowAvatar, policy.avatarChoices, defaults.avatar),
    background: permittedChoice(value.background, policy.allowBackground, policy.backgroundChoices, defaults.background),
    speed: policy.allowSpeed && finiteNumber(value.speed)
      ? Math.min(policy.maxSpeed, Math.max(policy.minSpeed, value.speed)) : defaults.speed,
  }
}

/** Validate raw edits before saving; reconciliation is reserved for safe loading and policy changes. */
export function validatePreferences(value: unknown, policy: StudentPolicy): string[] {
  if (!isRecord(value)) return ['Student preferences must be an object.']
  const errors: string[] = []
  if (!finiteNumber(value.volume) || value.volume < 0 || value.volume > 100) errors.push('Volume must be a number from 0 to 100.')
  if (value.textSize !== 16 && value.textSize !== 20 && value.textSize !== 24) errors.push('Text size must be 16, 20, or 24 pixels.')
  if (typeof value.reducedMotion !== 'boolean') errors.push('Reduced motion must be on or off.')
  else if (policy.defaults.reducedMotion && !value.reducedMotion) errors.push('Reduced motion must remain on under the current policy.')
  const choice = (key: 'avatar' | 'background', allowed: boolean, choices: Choice[]) => {
    if (typeof value[key] !== 'string' || !choices.some(({ id }) => id === value[key])) errors.push(`Choose an available ${key}.`)
    else if (!allowed && value[key] !== policy.defaults[key]) errors.push(`The current policy sets the ${key}; student changes are unavailable.`)
  }
  choice('avatar', policy.allowAvatar, policy.avatarChoices)
  choice('background', policy.allowBackground, policy.backgroundChoices)
  if (!finiteNumber(value.speed) || value.speed < policy.minSpeed || value.speed > policy.maxSpeed) {
    errors.push(`Speaking speed must be a number from ${policy.minSpeed} to ${policy.maxSpeed}.`)
  } else if (!policy.allowSpeed && value.speed !== policy.defaults.speed) errors.push('The current policy sets speaking speed; student changes are unavailable.')
  return errors
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type PreferenceResult = { preferences: StudentPreferences; error?: string }

function preferenceKey(examId: string, studentId: string): string {
  if (typeof examId !== 'string' || !examId.trim() || typeof studentId !== 'string' || !studentId.trim()) {
    throw new Error('An exam identifier and student identifier are required for personal preview preferences.')
  }
  return `oral-exam-student-preview:v1:${JSON.stringify([examId, studentId])}`
}

/** This adapter stores only presentation/accessibility preferences, never policy or attempt state. */
export function createPreferenceStore(storage?: PreferenceStorage) {
  const getStorage = (): PreferenceStorage => {
    const available = storage ?? globalThis.localStorage
    if (!available) throw new Error('Personal preference storage is unavailable in this browser.')
    return available
  }
  return {
    load(examId: string, studentId: string, policy: StudentPolicy): PreferenceResult {
      try {
        const key = preferenceKey(examId, studentId)
        const raw = getStorage().getItem(key)
        if (raw === null) return { preferences: defaultPreferences(policy) }
        const envelope: unknown = JSON.parse(raw)
        if (!isRecord(envelope) || envelope.version !== 1) throw new Error('The saved preferences use an unsupported format.')
        const preferences = reconcilePreferences(envelope.preferences, policy)
        if (validatePreferences(envelope.preferences, policy).length) {
          return { preferences, error: 'Some saved preferences are invalid or no longer allowed. Safe preferences are shown for the current demo policy.' }
        }
        return { preferences }
      } catch (error) {
        return { preferences: defaultPreferences(policy), error: `Unable to load personal preview preferences. ${error instanceof Error ? error.message : 'Storage could not be read.'}` }
      }
    },
    save(examId: string, studentId: string, preferences: StudentPreferences, policy: StudentPolicy): void {
      const key = preferenceKey(examId, studentId)
      const errors = validatePreferences(preferences, policy)
      if (errors.length) throw new Error(errors.join(' '))
      getStorage().setItem(key, JSON.stringify({ version: 1, preferences: reconcilePreferences(preferences, policy) }))
    },
    remove(examId: string, studentId: string): void {
      const key = preferenceKey(examId, studentId)
      getStorage().removeItem(key)
    },
  }
}
