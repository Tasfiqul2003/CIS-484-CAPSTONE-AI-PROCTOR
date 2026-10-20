import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
async function moduleUrl(path, imports = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true })
  assert.deepEqual(result.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), [])
  let compiled = result.outputText
  for (const [specifier, url] of Object.entries(imports)) compiled = compiled.replaceAll(`'${specifier}'`, JSON.stringify(url))
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
}
const settingsUrl = await moduleUrl('../src/components/avatar/settings.ts')
const { defaultSettings } = await import(settingsUrl)
const { toStudentPolicy, createLocalExamPolicyStore, snapshotPolicy, loadExamPolicy, saveExamPolicy } = await import(
  await moduleUrl('../src/components/avatar/examPolicy.ts', { './settings': settingsUrl }),
)
const { defaultPreferences, validatePreferences } = await import(await moduleUrl('../src/components/student-settings/studentSettings.ts'))

function memoryStorage() {
  const values = new Map()
  let writes = 0
  return {
    values, get writes() { return writes },
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes += 1; values.set(key, value) },
    removeItem: key => values.delete(key),
  }
}
function envelope(examId = 'synthetic-exam', revision = 0) {
  return { exam_id: examId, revision, settings: defaultSettings(), effective_for: 'new_attempts', assistance_scope: 'per_question', updated_at: revision ? '2026-10-15T12:00:00.000Z' : null }
}

test('student adapter exposes selected choices, current mode actions, and independent objects', () => {
  const settings = defaultSettings()
  settings.student.avatar = true
  settings.student.avatars = ['guide']
  settings.student.background = true
  settings.student.backgrounds = ['neutral', 'library']
  settings.student.speed = true
  settings.assistance.hint = { enabled: true, modes: 'practice', limit: 3, timerContinues: false }
  settings.assistance.explanation = { enabled: true, modes: 'assessed', limit: 1, timerContinues: true }
  const practice = toStudentPolicy(settings, 'practice')
  const assessed = toStudentPolicy(settings, 'assessed')
  assert.deepEqual(practice.avatarChoices, [{ id: 'guide', label: 'Person icon (preview)' }])
  assert.deepEqual(practice.backgroundChoices.map(({ id }) => id), ['neutral', 'library'])
  assert.deepEqual([practice.minSpeed, practice.maxSpeed], [0.8, 1.2])
  assert.equal(practice.defaults.voiceLabel, 'Calm voice (preview)')
  assert.deepEqual(practice.assistance.hint, { enabled: true, limit: 3, timerContinues: false })
  assert.equal(assessed.assistance.hint.enabled, false)
  assert.equal(practice.assistance.explanation.enabled, false)
  assert.equal(assessed.assistance.explanation.enabled, true)
  practice.assistance.hint.limit = 99
  practice.avatarChoices[0].label = 'changed'
  assert.equal(settings.assistance.hint.limit, 3)
  assert.equal(toStudentPolicy(settings, 'practice').avatarChoices[0].label, 'Person icon (preview)')
  assert.equal('voice' in practice, false)
  assert.equal('behavior' in practice, false)
})

test('locked defaults remain valid outside optional speed range and exclude unselected options', () => {
  const settings = defaultSettings()
  settings.presentation.avatar = 'geometric'
  settings.presentation.background = 'library'
  settings.presentation.speed = 1.9
  settings.presentation.reducedMotion = true
  const policy = toStudentPolicy(settings, 'assessed')
  assert.deepEqual([policy.allowAvatar, policy.allowBackground, policy.allowSpeed], [false, false, false])
  assert.deepEqual(policy.avatarChoices.map(({ id }) => id), ['geometric'])
  assert.deepEqual(policy.backgroundChoices.map(({ id }) => id), ['library'])
  assert.deepEqual([policy.minSpeed, policy.maxSpeed], [1.9, 1.9])
  assert.deepEqual(validatePreferences(defaultPreferences(policy), policy), [])
})

test('validated instructor uploads are available only in their permitted preview choices', () => {
  const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
  const settings = defaultSettings()
  settings.presentation.customAvatar = photo
  settings.presentation.customBackground = photo
  settings.presentation.avatar = 'custom'
  settings.presentation.background = 'custom'
  settings.student.avatar = true
  settings.student.avatars = ['custom']
  const policy = toStudentPolicy(settings, 'practice')
  assert.deepEqual(policy.avatarChoices, [{ id: 'custom', label: 'Instructor-uploaded avatar (preview)' }])
  assert.deepEqual(policy.backgroundChoices, [{ id: 'custom', label: 'Instructor-uploaded background (preview)' }])
  assert.equal(policy.defaults.customAvatar, photo)
  assert.equal(policy.defaults.customBackground, photo)
  assert.deepEqual(validatePreferences(defaultPreferences(policy), policy), [])
  settings.presentation.customAvatar = 'https://example.test/image.png'
  assert.throws(() => toStudentPolicy(settings, 'practice'), /Invalid exam policy/)
})

test('adapter rejects invalid policies and unsupported exam modes', () => {
  for (const bad of [null, [], {}, { ...defaultSettings(), student: { avatar: true } }]) assert.throws(() => toStudentPolicy(bad, 'practice'), /Invalid exam policy/)
  assert.throws(() => toStudentPolicy(defaultSettings(), 'both'), /exam mode/)
  const settings = defaultSettings()
  settings.student.avatar = true
  settings.student.avatars = []
  assert.throws(() => toStudentPolicy(settings, 'practice'), /at least one/)
})

test('shared local policy persists by exam and instructor apart from private preference and draft namespaces', () => {
  const storage = memoryStorage()
  const store = createLocalExamPolicyStore(storage)
  assert.equal(store.load('exam-a', 'instructor-a'), null)
  const settings = defaultSettings()
  settings.presentation.voice = 'clear'
  const saved = store.save('exam-a', 'instructor-a', settings, 0)
  assert.equal(saved.revision, 1)
  assert.equal(saved.exam_id, 'exam-a')
  assert.equal(saved.effective_for, 'new_attempts')
  assert.equal(saved.assistance_scope, 'per_question')
  assert.ok(Number.isFinite(Date.parse(saved.updated_at)))
  assert.deepEqual(createLocalExamPolicyStore(storage).load('exam-a', 'instructor-a'), saved)
  assert.equal(store.load('exam-b', 'instructor-a'), null)
  assert.equal(store.load('exam-a', 'instructor-b'), null)
  store.save('a:b', 'c', settings)
  store.save('a', 'b:c', settings)
  assert.equal(storage.values.size, 3)
  assert.ok([...storage.values.keys()].every(key => key.startsWith('oral-exam-policy-preview:v1:[')))
  settings.presentation.voice = 'calm'
  saved.settings.presentation.voice = 'calm'
  assert.equal(store.load('exam-a', 'instructor-a').settings.presentation.voice, 'clear')
})

test('save detects stale revisions and keeps previous policy intact', () => {
  const storage = memoryStorage()
  const store = createLocalExamPolicyStore(storage)
  const first = store.save('exam', 'instructor', defaultSettings(), 0)
  const settings = defaultSettings()
  settings.presentation.voice = 'clear'
  const second = store.save('exam', 'instructor', settings, first.revision)
  assert.equal(second.revision, 2)
  const before = [...storage.values.entries()]
  const writes = storage.writes
  assert.throws(() => store.save('exam', 'instructor', defaultSettings(), first.revision), error => error.status === 409 && /Reload/.test(error.message))
  assert.deepEqual([...storage.values.entries()], before)
  assert.equal(storage.writes, writes)
  assert.equal(store.save('exam', 'instructor', settings).revision, 3)
})

test('malformed local policy fails without overwriting or resetting rules', () => {
  const storage = memoryStorage()
  const store = createLocalExamPolicyStore(storage)
  store.save('exam', 'instructor', defaultSettings())
  const key = [...storage.values.keys()][0]
  for (const raw of ['{', 'null', '{}', JSON.stringify({ version: 2, policy: envelope('exam') }), JSON.stringify({ version: 1, policy: envelope('other-exam') }), JSON.stringify({ version: 1, policy: { ...envelope('exam'), settings: {} } })]) {
    storage.setItem(key, raw)
    const writes = storage.writes
    assert.throws(() => store.load('exam', 'instructor'))
    assert.throws(() => store.save('exam', 'instructor', defaultSettings(), 0))
    assert.equal(storage.getItem(key), raw)
    assert.equal(storage.writes, writes)
  }
})

test('local save strips unrelated fields and rejects invalid input before writing', () => {
  const storage = memoryStorage()
  const store = createLocalExamPolicyStore(storage)
  const settings = defaultSettings()
  settings.student.student_id = 'must not persist'
  settings.answers = ['must not persist']
  settings.presentation.volume = 50
  store.save('exam', 'instructor', settings)
  assert.deepEqual(store.load('exam', 'instructor').settings, defaultSettings())
  const writes = storage.writes
  for (const expected of [-1, 0.5, NaN, Infinity, '1']) assert.throws(() => store.save('exam', 'instructor', defaultSettings(), expected), /revision/)
  for (const [exam, instructor] of [['', 'instructor'], ['exam', ' '], [null, 'instructor']]) assert.throws(() => store.save(exam, instructor, settings), /identifier/)
  settings.presentation.speed = 99
  assert.throws(() => store.save('exam', 'instructor', settings), /Invalid exam policy/)
  assert.equal(storage.writes, writes)
  const broken = createLocalExamPolicyStore({ getItem() { throw Error('denied') }, setItem() { throw Error('quota') }, removeItem() {} })
  assert.throws(() => broken.load('exam', 'instructor'), /denied/)
})

test('attempt snapshot is independent and validates policy metadata', () => {
  const source = envelope()
  const snapshot = snapshotPolicy(source)
  source.settings.assistance.repeat.limit = 10
  source.settings.student.avatars.push('custom')
  assert.equal(snapshot.settings.assistance.repeat.limit, 2)
  assert.deepEqual(snapshot.settings.student.avatars, ['guide', 'geometric'])
  for (const edit of [{ revision: -1 }, { revision: 1.5 }, { exam_id: '' }, { effective_for: 'all_attempts' }, { assistance_scope: 'per_exam' }, { updated_at: 'invalid' }]) assert.throws(() => snapshotPolicy({ ...envelope(), ...edit }), /format/)
})

test('server transport uses credentials, escaped exam ID, strict PUT body, and no browser fallback', async () => {
  const originalFetch = globalThis.fetch
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const calls = []
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('browser storage must never be consulted by transport') } })
  try {
    const signal = new AbortController().signal
    globalThis.fetch = async (url, options) => { calls.push([url, options]); return new Response(JSON.stringify(envelope('exam/one')), { status: 200 }) }
    assert.equal((await loadExamPolicy('exam/one', signal)).revision, 0)
    assert.equal(calls[0][0], '/api/exam/templates/exam%2Fone/avatar-policy')
    assert.equal(calls[0][1].credentials, 'include')
    assert.equal(calls[0][1].signal, signal)
    await saveExamPolicy('exam/one', defaultSettings(), 0)
    assert.equal(calls[1][1].method, 'PUT')
    assert.equal(calls[1][1].credentials, 'include')
    assert.deepEqual(JSON.parse(calls[1][1].body), { settings: defaultSettings(), expected_revision: 0 })
    for (const status of [401, 403, 404, 409, 500]) {
      globalThis.fetch = async () => new Response('{}', { status })
      await assert.rejects(loadExamPolicy('exam/one'), error => error.status === status)
    }
    globalThis.fetch = async () => { throw Error('network unavailable') }
    await assert.rejects(loadExamPolicy('exam/one'), /network unavailable/)
  } finally {
    globalThis.fetch = originalFetch
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else delete globalThis.localStorage
  }
})

test('server transport rejects mismatched, malformed, and invalid response policies and invalid saves', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  try {
    for (const body of ['{', JSON.stringify(envelope('other-exam')), JSON.stringify({ ...envelope(), settings: {} }), JSON.stringify({ ...envelope(), revision: '1' })]) {
      globalThis.fetch = async () => { calls += 1; return new Response(body, { status: 200 }) }
      await assert.rejects(loadExamPolicy('synthetic-exam'))
    }
    const before = calls
    await assert.rejects(saveExamPolicy('synthetic-exam', {}, 0), /Invalid exam policy/)
    await assert.rejects(saveExamPolicy('synthetic-exam', defaultSettings(), -1), /revision/)
    await assert.rejects(loadExamPolicy(' '), /identifier/)
    assert.equal(calls, before)
  } finally { globalThis.fetch = originalFetch }
})
