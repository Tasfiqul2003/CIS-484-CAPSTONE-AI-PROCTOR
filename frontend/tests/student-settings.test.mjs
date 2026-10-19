import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = await readFile(new URL('../src/components/student-settings/studentSettings.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  reportDiagnostics: true,
})
assert.deepEqual(compiled.diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error), [])
const { getDemoPolicy, defaultPreferences, reconcilePreferences, validatePreferences, createPreferenceStore } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
)

function memoryStorage() {
  const values = new Map()
  let writes = 0
  return {
    values,
    get writes() { return writes },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { writes += 1; values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

test('synthetic policy and reset preferences are independent fresh objects', () => {
  const first = getDemoPolicy()
  const second = getDemoPolicy()
  assert.equal(first.mode, 'practice')
  assert.deepEqual([first.allowAvatar, first.allowBackground, first.allowSpeed], [true, true, true])
  assert.deepEqual(first.avatarChoices.map(({ id }) => id), ['guide', 'geometric'])
  assert.deepEqual(first.backgroundChoices.map(({ id }) => id), ['neutral', 'library'])
  assert.deepEqual([first.assistance.repeat.limit, first.assistance.clarification.limit, first.assistance.hint.limit], [2, 1, 1])
  assert.equal(first.assistance.explanation.enabled, false)
  assert.equal(first.assistance.correctness.enabled, false)
  const original = defaultPreferences(second)
  assert.deepEqual(original, { volume: 70, textSize: 16, reducedMotion: false, avatar: 'guide', background: 'neutral', speed: 1 })
  assert.deepEqual(validatePreferences(original, second), [])
  first.avatarChoices[0].label = 'changed synthetic label'
  first.defaults.avatar = 'geometric'
  first.assistance.repeat.limit = 99
  original.volume = 0
  assert.equal(second.avatarChoices[0].label, 'Person icon (preview)')
  assert.equal(second.defaults.avatar, 'guide')
  assert.equal(second.assistance.repeat.limit, 2)
  assert.equal(defaultPreferences(second).volume, 70)
})

test('raw preferences reject malformed shapes, types, unknown choices, and numeric limits', () => {
  const policy = getDemoPolicy()
  for (const value of [null, undefined, [], 1, 'preferences', {}]) assert.ok(validatePreferences(value, policy).length)
  for (const [key, invalidValues] of [
    ['volume', [NaN, Infinity, -Infinity, '70', -1, 101]],
    ['textSize', [null, '20', 18, 25]],
    ['reducedMotion', [null, 1, 'true']],
    ['avatar', [null, 1, 'custom', 'unknown']],
    ['background', [null, 1, 'custom', 'unknown']],
    ['speed', [NaN, Infinity, '1', 0.79, 1.21]],
  ]) {
    for (const value of invalidValues) {
      const preferences = { ...defaultPreferences(policy), [key]: value }
      assert.ok(validatePreferences(preferences, policy).length, `${key}: ${String(value)}`)
    }
  }
  for (const [volume, speed, textSize] of [[0, 0.8, 16], [100, 1.2, 20], [50, 1, 24]]) {
    assert.deepEqual(validatePreferences({ ...defaultPreferences(policy), volume, speed, textSize }, policy), [])
  }
})

test('reconciliation clamps numbers and falls back for invalid raw fields without mutating input', () => {
  const policy = getDemoPolicy()
  const input = { volume: 150, textSize: 18, reducedMotion: 'yes', avatar: 'unknown', background: 'library', speed: 0.1 }
  const snapshot = structuredClone(input)
  assert.deepEqual(reconcilePreferences(input, policy), { volume: 100, textSize: 16, reducedMotion: false, avatar: 'guide', background: 'library', speed: 0.8 })
  assert.deepEqual(input, snapshot)
  assert.deepEqual(reconcilePreferences({ volume: -1, speed: 7 }, policy), { ...defaultPreferences(policy), volume: 0, speed: 1.2 })
  for (const value of [null, undefined, [], 'preferences']) assert.deepEqual(reconcilePreferences(value, policy), defaultPreferences(policy))
  assert.deepEqual(reconcilePreferences({ ...defaultPreferences(policy), volume: NaN, speed: Infinity }, policy), defaultPreferences(policy))
})

test('locked controls and required reduced motion follow the supplied current policy', () => {
  const policy = getDemoPolicy()
  policy.allowAvatar = false
  policy.allowBackground = false
  policy.allowSpeed = false
  policy.defaults.reducedMotion = true
  const attempted = { volume: 40, textSize: 24, reducedMotion: false, avatar: 'geometric', background: 'library', speed: 1.2 }
  assert.equal(validatePreferences(attempted, policy).length, 4)
  const reconciled = reconcilePreferences(attempted, policy)
  assert.deepEqual(reconciled, { volume: 40, textSize: 24, reducedMotion: true, avatar: 'guide', background: 'neutral', speed: 1 })
  assert.deepEqual(validatePreferences(reconciled, policy), [])
})

test('personal preferences save and reload with separate exam and student scopes', () => {
  const policy = getDemoPolicy()
  const storage = memoryStorage()
  const store = createPreferenceStore(storage)
  const preferences = { ...defaultPreferences(policy), avatar: 'geometric', background: 'library', textSize: 24, speed: 1.15, volume: 40, reducedMotion: true }
  store.save('exam:a', 'student:b', preferences, policy)
  assert.deepEqual(createPreferenceStore(storage).load('exam:a', 'student:b', policy), { preferences })
  assert.deepEqual(store.load('exam:other', 'student:b', policy), { preferences: defaultPreferences(policy) })
  assert.deepEqual(store.load('exam:a', 'student:other', policy), { preferences: defaultPreferences(policy) })
  store.save('exam', 'a:student:b', defaultPreferences(policy), policy)
  store.save('exam:a:student', 'b', defaultPreferences(policy), policy)
  store.save('exam\",\"student', 'b', defaultPreferences(policy), policy)
  assert.equal(storage.values.size, 4)
  assert.ok([...storage.values.keys()].every((key) => key.startsWith('oral-exam-student-preview:v1:[')))
  assert.ok([...storage.values.keys()].every((key) => !key.startsWith('oral-exam-avatar:')))
})

test('storage cannot override policy, assistance, answers, counters, or add arbitrary persisted fields', () => {
  const policy = getDemoPolicy()
  const policySnapshot = structuredClone(policy)
  const storage = memoryStorage()
  const store = createPreferenceStore(storage)
  const preferences = {
    ...defaultPreferences(policy), policy: { mode: 'assessed', allowAvatar: false }, assistance: { hint: { enabled: false } },
    answers: ['synthetic answer'], counters: { repeat: 99 }, filename: 'synthetic.png', photo: 'synthetic image', record: { synthetic: true },
  }
  store.save('exam', 'student', preferences, policy)
  const [key, raw] = [...storage.values.entries()][0]
  assert.deepEqual(JSON.parse(raw), { version: 1, preferences: defaultPreferences(policy) })
  storage.setItem(key, JSON.stringify({ version: 1, preferences, policy: { mode: 'assessed' }, counters: { repeat: 99 } }))
  assert.deepEqual(store.load('exam', 'student', policy), { preferences: defaultPreferences(policy) })
  assert.deepEqual(policy, policySnapshot)
  assert.equal(policy.mode, 'practice')
  assert.equal(policy.assistance.hint.enabled, true)
})

test('saved preferences that become disallowed are safely reconciled without rewriting the draft', () => {
  const policy = getDemoPolicy()
  const storage = memoryStorage()
  const store = createPreferenceStore(storage)
  store.save('exam', 'student', { ...defaultPreferences(policy), avatar: 'geometric', background: 'library', speed: 1.2 }, policy)
  const [key, raw] = [...storage.values.entries()][0]
  const writes = storage.writes
  policy.allowAvatar = false
  policy.allowBackground = false
  policy.allowSpeed = false
  policy.defaults.reducedMotion = true
  const result = store.load('exam', 'student', policy)
  assert.deepEqual(result.preferences, defaultPreferences(policy))
  assert.match(result.error, /no longer allowed/)
  assert.equal(storage.getItem(key), raw)
  assert.equal(storage.writes, writes)
})

test('malformed stored drafts expose recoverable errors and leave defaults usable', () => {
  const policy = getDemoPolicy()
  const storage = memoryStorage()
  const store = createPreferenceStore(storage)
  store.save('exam', 'student', defaultPreferences(policy), policy)
  const key = [...storage.values.keys()][0]
  for (const raw of ['{', 'null', '[]', '{}', JSON.stringify({ version: 2, preferences: defaultPreferences(policy) }), JSON.stringify({ version: 1, preferences: null })]) {
    storage.setItem(key, raw)
    const writes = storage.writes
    const result = store.load('exam', 'student', policy)
    assert.deepEqual(result.preferences, defaultPreferences(policy))
    assert.ok(result.error)
    assert.equal(storage.getItem(key), raw)
    assert.equal(storage.writes, writes)
  }
  storage.setItem(key, JSON.stringify({ version: 1, preferences: { ...defaultPreferences(policy), volume: 900, avatar: 'unknown', speed: -2 } }))
  const reconciled = store.load('exam', 'student', policy)
  assert.deepEqual(reconciled.preferences, { ...defaultPreferences(policy), volume: 100, speed: 0.8 })
  assert.ok(reconciled.error)
})

test('invalid saves and missing identities never write preferences', () => {
  const policy = getDemoPolicy()
  const storage = memoryStorage()
  const store = createPreferenceStore(storage)
  assert.throws(() => store.save('exam', 'student', { ...defaultPreferences(policy), speed: 20 }, policy), /Speaking speed/)
  for (const [examId, studentId] of [['', 'student'], ['exam', ' '], [null, 'student']]) {
    const result = store.load(examId, studentId, policy)
    assert.deepEqual(result.preferences, defaultPreferences(policy))
    assert.match(result.error, /identifier/)
    assert.throws(() => store.save(examId, studentId, defaultPreferences(policy), policy), /identifier/)
    assert.throws(() => store.remove(examId, studentId), /identifier/)
  }
  assert.equal(storage.writes, 0)
})

test('access, quota, and removal errors are surfaced while load still supplies defaults', () => {
  const policy = getDemoPolicy()
  const store = createPreferenceStore({
    getItem() { throw new Error('access denied') },
    setItem() { throw new Error('quota exceeded') },
    removeItem() { throw new Error('removal denied') },
  })
  const result = store.load('exam', 'student', policy)
  assert.deepEqual(result.preferences, defaultPreferences(policy))
  assert.match(result.error, /access denied/)
  assert.throws(() => store.save('exam', 'student', defaultPreferences(policy), policy), /quota exceeded/)
  assert.throws(() => store.remove('exam', 'student'), /removal denied/)
})

test('reset removes only the chosen personal draft and returned preferences cannot mutate saved values', () => {
  const policy = getDemoPolicy()
  const storage = memoryStorage()
  const store = createPreferenceStore(storage)
  const preferences = { ...defaultPreferences(policy), volume: 20 }
  store.save('exam-a', 'student', preferences, policy)
  store.save('exam-b', 'student', defaultPreferences(policy), policy)
  preferences.volume = 90
  const loaded = store.load('exam-a', 'student', policy).preferences
  assert.equal(loaded.volume, 20)
  loaded.volume = 50
  assert.equal(store.load('exam-a', 'student', policy).preferences.volume, 20)
  store.remove('exam-a', 'student')
  assert.deepEqual(store.load('exam-a', 'student', policy), { preferences: defaultPreferences(policy) })
  assert.deepEqual(store.load('exam-b', 'student', policy), { preferences: defaultPreferences(policy) })
})
