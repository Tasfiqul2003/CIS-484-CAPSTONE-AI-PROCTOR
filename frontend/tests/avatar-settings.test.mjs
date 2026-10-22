import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

// Use the frontend's existing TypeScript installation, without adding dependencies.
// AVATAR_TYPESCRIPT_PATH permits running this file from a staged review workspace.
const require = createRequire(import.meta.url)
const ts = require(process.env.AVATAR_TYPESCRIPT_PATH || 'typescript')
const source = await readFile(new URL('../src/components/avatar/settings.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  reportDiagnostics: true,
})
assert.deepEqual(compiled.diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error), [])
const { defaultSettings, validateSettings, isAvailable, createDraftStore, isValidPreviewImage, MAX_PREVIEW_IMAGE_BYTES } = await import(
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

function legacySettings() {
  const settings = defaultSettings()
  delete settings.presentation.customAvatar
  delete settings.presentation.customBackground
  delete settings.behavior.responseUnit
  settings.student.voice = false
  settings.student.voices = ['calm', 'clear']
  settings.behavior.difficulty = 'fixed'
  settings.behavior.minDifficulty = 1
  settings.behavior.maxDifficulty = 5
  return settings
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='

function rasterData(format, size) {
  const bytes = Buffer.alloc(size)
  const signature = format === 'png' ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    : format === 'jpeg' ? Buffer.from([255, 216, 255])
      : Buffer.from('RIFF\0\0\0\0WEBP')
  signature.copy(bytes)
  return `data:image/${format};base64,${bytes.toString('base64')}`
}

test('proposed defaults validate and reset returns independent nested values', () => {
  const first = defaultSettings()
  const second = defaultSettings()
  assert.deepEqual(validateSettings(first), [])
  first.student.avatars.pop()
  first.assistance.repeat.limit = 9
  first.presentation.voice = 'clear'
  assert.equal(second.student.avatars.length, 2)
  assert.equal(second.assistance.repeat.limit, 2)
  assert.equal(second.presentation.voice, 'calm')
  assert.deepEqual(defaultSettings(), second)
})

test('invalid shapes and enum choices are rejected without throwing', () => {
  for (const value of [null, undefined, [], 'settings', 3, {}, { presentation: [] }]) {
    assert.ok(validateSettings(value).length > 0)
  }
  for (const [section, field, value] of [
    ['presentation', 'avatar', 'unapproved'], ['presentation', 'voice', false],
    ['presentation', 'background', 'unknown'], ['presentation', 'animation', 1],
    ['presentation', 'stateLabels', false], ['student', 'speed', 'yes'],
    ['behavior', 'order', 'student'], ['behavior', 'responseTiming', 'unlimited'],
    ['behavior', 'responseUnit', 'hours'],
  ]) {
    const settings = defaultSettings()
    settings[section][field] = value
    assert.ok(validateSettings(settings).length > 0, `${section}.${field}`)
  }
  const settings = defaultSettings()
  settings.assistance.repeat = null
  assert.ok(validateSettings(settings).some((error) => error.includes('repeat policy')))
})

test('numeric fields reject nonfinite values, fractions for counts, and out-of-range values', () => {
  const cases = [
    ['presentation', 'speed', [NaN, Infinity, -Infinity, '1', 0.49, 2.01]],
    ['student', 'minSpeed', [NaN, 0.4, 2.1]],
    ['student', 'maxSpeed', [NaN, 0.4, 2.1]],
    ['behavior', 'followUps', [NaN, -1, 6, 1.5]],
    ['behavior', 'responseSeconds', [NaN, 9, 601, 60.5]],
  ]
  for (const [section, field, values] of cases) {
    for (const value of values) {
      const settings = defaultSettings()
      settings[section][field] = value
      assert.ok(validateSettings(settings).length > 0, `${section}.${field}: ${String(value)}`)
    }
  }
  for (const speed of [0.5, 2]) {
    const settings = defaultSettings()
    settings.presentation.speed = speed
    assert.deepEqual(validateSettings(settings), [])
  }
  const reversed = defaultSettings()
  reversed.student.minSpeed = 1.3
  reversed.student.maxSpeed = 0.8
  assert.ok(validateSettings(reversed).some((error) => error.includes('Minimum speaking speed')))
})

test('student choice permissions require nonempty allowed sets that include the default', () => {
  for (const [toggle, field, alternate] of [
    ['avatar', 'avatars', 'geometric'], ['background', 'backgrounds', 'library'],
  ]) {
    const settings = defaultSettings()
    settings.student[toggle] = true
    settings.student[field] = []
    assert.ok(validateSettings(settings).some((error) => error.includes(`student ${toggle} choice`)))
    settings.student[field] = [alternate]
    assert.ok(validateSettings(settings).some((error) => error.includes(`Default ${toggle}`)))
    settings.student[field] = ['unapproved']
    assert.ok(validateSettings(settings).some((error) => error.includes(`Allowed ${field}`)))
    settings.student[field] = [alternate, alternate]
    assert.ok(validateSettings(settings).some((error) => error.includes(`Allowed ${field}`)))
    settings.student[toggle] = false
    settings.student[field] = []
    assert.deepEqual(validateSettings(settings), [])
  }
})

test('enabled speed selection requires default within range; disabled selections retain safe values', () => {
  const settings = defaultSettings()
  settings.student.minSpeed = 1.1
  settings.student.maxSpeed = 1.5
  assert.deepEqual(validateSettings(settings), [])
  settings.student.speed = true
  assert.ok(validateSettings(settings).some((error) => error.includes('Default speaking speed')))
  settings.presentation.speed = 1.2
  assert.deepEqual(validateSettings(settings), [])
})

test('each assistance policy validates permissions and use limits', () => {
  for (const action of ['repeat', 'clarification', 'hint', 'explanation', 'correctness']) {
    for (const limit of [NaN, Infinity, -1, 11, 0.5]) {
      const settings = defaultSettings()
      settings.assistance[action].limit = limit
      assert.ok(validateSettings(settings).some((error) => error.includes(`${action} limit`)))
    }
    const settings = defaultSettings()
    settings.assistance[action].enabled = true
    settings.assistance[action].limit = 0
    assert.ok(validateSettings(settings).some((error) => error.includes(`Enabled ${action}`)))
    settings.assistance[action].enabled = false
    assert.deepEqual(validateSettings(settings), [])
    settings.assistance[action].modes = 'student-selected'
    settings.assistance[action].timerContinues = 'yes'
    assert.ok(validateSettings(settings).some((error) => error.includes(`${action} mode`)))
    assert.ok(validateSettings(settings).some((error) => error.includes(`${action} timer`)))
  }
})

test('preview availability follows enabled flag, selected mode, and a positive limit', () => {
  const policy = { enabled: true, modes: 'practice', limit: 2, timerContinues: true }
  assert.equal(isAvailable(policy, 'practice'), true)
  assert.equal(isAvailable(policy, 'assessed'), false)
  policy.modes = 'assessed'
  assert.equal(isAvailable(policy, 'practice'), false)
  assert.equal(isAvailable(policy, 'assessed'), true)
  policy.modes = 'both'
  assert.equal(isAvailable(policy, 'practice'), true)
  assert.equal(isAvailable(policy, 'assessed'), true)
  policy.enabled = false
  assert.equal(isAvailable(policy, 'assessed'), false)
  policy.enabled = true
  policy.limit = 0
  assert.equal(isAvailable(policy, 'practice'), false)
})

test('drafts save and reload with exam and instructor isolation and unambiguous keys', () => {
  const storage = memoryStorage()
  const store = createDraftStore(storage)
  const first = defaultSettings()
  first.presentation.voice = 'clear'
  store.save('exam:a', 'instructor:b', first)
  assert.deepEqual(createDraftStore(storage).load('exam:a', 'instructor:b'), { settings: first })
  assert.deepEqual(store.load('exam:other', 'instructor:b'), { settings: null })
  assert.deepEqual(store.load('exam:a', 'instructor:other'), { settings: null })
  store.save('exam', 'a:instructor:b', defaultSettings())
  store.save('exam:a:instructor', 'b', defaultSettings())
  store.save('exam\",\"instructor', 'b', defaultSettings())
  assert.equal(storage.values.size, 4)
  assert.ok([...storage.values.keys()].every((key) => key.startsWith('oral-exam-avatar:v1:[')))
})

test('draft save rejects invalid settings and missing identity without writing', () => {
  const storage = memoryStorage()
  const store = createDraftStore(storage)
  const settings = defaultSettings()
  settings.behavior.followUps = 100
  assert.throws(() => store.save('exam', 'instructor', settings), /Follow-up limit/)
  for (const [examId, instructorId] of [['', 'instructor'], ['exam', ' '], [null, 'instructor']]) {
    assert.throws(() => store.save(examId, instructorId, defaultSettings()), /identifier/)
    assert.ok(store.load(examId, instructorId).error)
    assert.throws(() => store.remove(examId, instructorId), /identifier/)
  }
  assert.equal(storage.values.size, 0)
})

test('malformed, wrong-version, and invalid stored drafts produce recoverable errors', () => {
  const storage = memoryStorage()
  const store = createDraftStore(storage)
  store.save('exam', 'instructor', defaultSettings())
  const key = [...storage.values.keys()][0]
  for (const raw of ['{', 'null', '[]', '{}', JSON.stringify({ version: 3, settings: defaultSettings() }), JSON.stringify({ version: 1, settings: {} }), JSON.stringify({ version: 2, settings: {} })]) {
    storage.setItem(key, raw)
    const result = store.load('exam', 'instructor')
    assert.equal(result.settings, null)
    assert.match(result.error, /Unable to load local draft/)
    assert.equal(storage.getItem(key), raw, 'a failed read preserves the original draft')
  }
})

test('storage access, quota, and removal failures are exposed to the caller', () => {
  const store = createDraftStore({
    getItem() { throw new Error('access denied') },
    setItem() { throw new Error('quota exceeded') },
    removeItem() { throw new Error('removal denied') },
  })
  assert.match(store.load('exam', 'instructor').error, /access denied/)
  assert.throws(() => store.save('exam', 'instructor', defaultSettings()), /quota exceeded/)
  assert.throws(() => store.remove('exam', 'instructor'), /removal denied/)
})

test('only whitelisted settings are persisted and loaded', () => {
  const storage = memoryStorage()
  const store = createDraftStore(storage)
  const settings = defaultSettings()
  settings.unexpected = 'synthetic-extra'
  settings.presentation.unexpected = 'synthetic-extra'
  settings.student.unexpected = { synthetic: true }
  settings.assistance.repeat.unexpected = 'synthetic-extra'
  settings.behavior.unexpected = 'synthetic-extra'
  settings.student.voice = true
  settings.student.voices = ['calm', 'clear']
  settings.behavior.difficulty = 'bounded'
  settings.behavior.minDifficulty = 1
  settings.behavior.maxDifficulty = 5
  settings.presentation.filename = 'synthetic.png'
  store.save('exam', 'instructor', settings)
  const [key, raw] = [...storage.values.entries()][0]
  assert.equal(raw.includes('unexpected'), false)
  assert.equal(raw.includes('difficulty'), false)
  assert.equal(raw.includes('minDifficulty'), false)
  assert.equal(raw.includes('maxDifficulty'), false)
  assert.equal(raw.includes('filename'), false)
  const envelope = JSON.parse(raw)
  assert.equal(envelope.version, 2)
  assert.equal('voice' in envelope.settings.student, false)
  assert.equal('voices' in envelope.settings.student, false)
  envelope.unexpected = 'synthetic-extra'
  envelope.settings.presentation.unexpected = 'synthetic-extra'
  storage.setItem(key, JSON.stringify(envelope))
  assert.deepEqual(store.load('exam', 'instructor'), { settings: defaultSettings() })
})

test('v1 drafts migrate retained fields in memory without writing or retaining removed settings', () => {
  const storage = memoryStorage()
  const key = 'oral-exam-avatar:v1:["exam","instructor"]'
  const legacy = legacySettings()
  legacy.presentation.voice = 'clear'
  legacy.presentation.speed = 1.1
  legacy.student.avatar = true
  legacy.assistance.repeat.limit = 3
  legacy.behavior.responseTiming = 'fixed'
  legacy.behavior.responseSeconds = 90
  const raw = JSON.stringify({ version: 1, settings: legacy })
  storage.setItem(key, raw)
  const store = createDraftStore(storage)
  const before = storage.writes
  const loaded = store.load('exam', 'instructor')
  assert.equal(loaded.error, undefined)
  assert.deepEqual(validateSettings(loaded.settings), [])
  assert.equal(loaded.settings.presentation.voice, 'clear')
  assert.equal(loaded.settings.presentation.speed, 1.1)
  assert.equal(loaded.settings.student.avatar, true)
  assert.equal(loaded.settings.assistance.repeat.limit, 3)
  assert.equal(loaded.settings.presentation.customAvatar, null)
  assert.equal(loaded.settings.presentation.customBackground, null)
  assert.equal(loaded.settings.behavior.responseSeconds, 90)
  assert.equal(loaded.settings.behavior.responseUnit, 'seconds')
  assert.equal('voice' in loaded.settings.student, false)
  assert.equal('voices' in loaded.settings.student, false)
  assert.equal('difficulty' in loaded.settings.behavior, false)
  assert.equal(storage.writes, before)
  assert.equal(storage.getItem(key), raw)
  assert.deepEqual(store.load('other-exam', 'instructor'), { settings: null })
  assert.deepEqual(store.load('exam', 'other-instructor'), { settings: null })
  store.save('exam', 'instructor', loaded.settings)
  assert.equal(JSON.parse(storage.getItem(key)).version, 2)
  assert.equal(storage.writes, before + 1)
})

test('v1 migration validates retained fields and discards obsolete or unexpected data', () => {
  const storage = memoryStorage()
  const key = 'oral-exam-avatar:v1:["exam","instructor"]'
  const legacy = legacySettings()
  legacy.student.voice = { unexpected: 'synthetic' }
  legacy.behavior.difficulty = { unexpected: 'synthetic' }
  legacy.presentation.customAvatar = 'https://example.invalid/image.png'
  legacy.behavior.responseUnit = 'hours'
  storage.setItem(key, JSON.stringify({ version: 1, settings: legacy }))
  const store = createDraftStore(storage)
  assert.deepEqual(store.load('exam', 'instructor'), { settings: defaultSettings() })
  legacy.behavior.responseSeconds = 601
  const raw = JSON.stringify({ version: 1, settings: legacy })
  storage.setItem(key, raw)
  assert.match(store.load('exam', 'instructor').error, /Response time in seconds/)
  assert.equal(storage.getItem(key), raw)
})

test('response unit is a display preference and canonical whole seconds remain unchanged', () => {
  const storage = memoryStorage()
  const store = createDraftStore(storage)
  const settings = defaultSettings()
  assert.equal(settings.behavior.responseUnit, 'seconds')
  settings.behavior.responseTiming = 'fixed'
  for (const seconds of [10, 30, 90, 120, 600]) {
    settings.behavior.responseSeconds = seconds
    for (const unit of ['seconds', 'minutes']) {
      settings.behavior.responseUnit = unit
      assert.deepEqual(validateSettings(settings), [])
      store.save('exam', 'instructor', settings)
      assert.equal(store.load('exam', 'instructor').settings.behavior.responseSeconds, seconds)
      assert.equal(store.load('exam', 'instructor').settings.behavior.responseUnit, unit)
    }
  }
  settings.behavior.responseSeconds = 1.5
  assert.ok(validateSettings(settings).some((error) => error.includes('Response time in seconds')))
})

test('preview images accept bounded PNG, JPEG, and WebP raster data URLs only', () => {
  assert.equal(MAX_PREVIEW_IMAGE_BYTES, 1_048_576)
  assert.equal(isValidPreviewImage(PNG), true)
  for (const format of ['png', 'jpeg', 'webp']) {
    assert.equal(isValidPreviewImage(rasterData(format, 20)), true, format)
    assert.equal(isValidPreviewImage(rasterData(format, MAX_PREVIEW_IMAGE_BYTES)), true, `${format} exact limit`)
    assert.equal(isValidPreviewImage(rasterData(format, MAX_PREVIEW_IMAGE_BYTES + 1)), false, `${format} over limit`)
  }
  for (const value of [null, undefined, {}, 'https://example.invalid/photo.png', 'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:text/html;base64,PGgxPmhpPC9oMT4=',
    'data:image/gif;base64,R0lGODlh', 'data:image/png;base64,', 'data:image/png;base64,====',
    'data:image/png;base64,SGVsbG8=', 'data:image/png;base64,aQ==\n', 'data:image/png;base64,aQ=',
    PNG.replace('image/png', 'image/jpeg'), `${PNG}<script>`,
  ]) assert.equal(isValidPreviewImage(value), false, String(value))
})

test('custom choices require valid matching assets and include the professor default when enabled', () => {
  for (const [kind, image, allowed] of [['avatar', 'customAvatar', 'avatars'], ['background', 'customBackground', 'backgrounds']]) {
    const settings = defaultSettings()
    settings.presentation[kind] = 'custom'
    settings.student[allowed].push('custom')
    assert.ok(validateSettings(settings).some((error) => error.includes(`Default ${kind}`)))
    settings.presentation[image] = PNG
    assert.deepEqual(validateSettings(settings), [])
    settings.student[kind] = true
    settings.student[allowed] = ['custom']
    assert.deepEqual(validateSettings(settings), [])
    settings.student[allowed] = []
    assert.ok(validateSettings(settings).some((error) => error.includes(`Default ${kind}`)))
    settings.student[kind] = false
    settings.presentation[image] = 'data:image/svg+xml;base64,PHN2Zz4='
    assert.ok(validateSettings(settings).some((error) => error.includes(`Custom ${kind}`)))
  }
})

test('v2 image drafts round trip and unexpected prototype fields cannot escape the whitelist', () => {
  const storage = memoryStorage()
  const store = createDraftStore(storage)
  const settings = defaultSettings()
  settings.presentation.customAvatar = PNG
  settings.presentation.customBackground = PNG
  settings.presentation.avatar = 'custom'
  settings.presentation.background = 'custom'
  settings.student.avatars.push('custom')
  settings.student.backgrounds.push('custom')
  store.save('exam', 'instructor', settings)
  assert.deepEqual(store.load('exam', 'instructor'), { settings })
  const [key, raw] = [...storage.values.entries()][0]
  const envelope = JSON.parse(raw)
  envelope.settings.presentation = JSON.parse(JSON.stringify(envelope.settings.presentation).replace('{', '{"__proto__":{"syntheticPollution":true},'))
  envelope.settings.student = JSON.parse(JSON.stringify(envelope.settings.student).replace('{', '{"constructor":{"prototype":{"syntheticPollution":true}},'))
  storage.setItem(key, JSON.stringify(envelope))
  assert.deepEqual(store.load('exam', 'instructor'), { settings })
  assert.equal({}.syntheticPollution, undefined)
  envelope.settings.presentation.customAvatar = 'https://example.invalid/photo.png'
  const malformed = JSON.stringify(envelope)
  storage.setItem(key, malformed)
  assert.match(store.load('exam', 'instructor').error, /Custom avatar/)
  assert.equal(storage.getItem(key), malformed)
})

test('sparse allowed-choice arrays and nested malformed policies cannot create unreadable drafts', () => {
  const storage = memoryStorage()
  const store = createDraftStore(storage)
  const settings = defaultSettings()
  settings.student.avatars = Array(1)
  assert.ok(validateSettings(settings).some((error) => error.includes('Allowed avatars')))
  assert.throws(() => store.save('exam', 'instructor', settings), /Allowed avatars/)
  assert.equal(storage.values.size, 0)
  for (const invalid of [null, [], false, 'policy', 3]) {
    const candidate = defaultSettings()
    candidate.assistance.clarification = invalid
    assert.ok(validateSettings(candidate).some((error) => error.includes('clarification policy')))
  }
})

test('reset removes only the selected draft and defaults do not mutate saved data', () => {
  const storage = memoryStorage()
  const store = createDraftStore(storage)
  const original = defaultSettings()
  store.save('exam-a', 'instructor', original)
  store.save('exam-b', 'instructor', defaultSettings())
  original.presentation.voice = 'clear'
  assert.equal(store.load('exam-a', 'instructor').settings.presentation.voice, 'calm')
  const loaded = store.load('exam-a', 'instructor').settings
  loaded.assistance.repeat.limit = 7
  assert.equal(store.load('exam-a', 'instructor').settings.assistance.repeat.limit, 2)
  store.remove('exam-a', 'instructor')
  assert.deepEqual(store.load('exam-a', 'instructor'), { settings: null })
  assert.deepEqual(store.load('exam-b', 'instructor'), { settings: defaultSettings() })
})
