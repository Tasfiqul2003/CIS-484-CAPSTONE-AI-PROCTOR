import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Compile only the settings model using the frontend's existing TypeScript.
const require = createRequire(import.meta.url);
const ts = require(process.env.AVATAR_TYPESCRIPT_PATH || 'typescript');
const source = await readFile(new URL('../src/components/exam-settings/examSettings.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  reportDiagnostics: true,
});
assert.deepEqual(compiled.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), []);
const {
  defaultExamSettings, categorySettingKeys, examSettingsStorageKey,
  loadExamSettings, saveExamSettingsCategory, hasCategoryChanges,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);

const EXAM_A = 'synthetic-exam-a';
const EXAM_B = 'synthetic-exam-b';

function memoryStorage() {
  const values = new Map();
  let writes = 0;
  return {
    values,
    get writes() { return writes; },
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes += 1; values.set(key, value); },
  };
}

function seed(storage, examId, settings) {
  storage.values.set(examSettingsStorageKey(examId), JSON.stringify(settings));
}

test('defaults retain the existing controls and canonical Manage Exam storage key', () => {
  const storage = memoryStorage();
  assert.equal(examSettingsStorageKey(EXAM_A), 'oralExamSettings-/professor/exams/synthetic-exam-a');
  assert.deepEqual(loadExamSettings(storage, EXAM_A), {
    timeLimit: 30,
    extendedTime: false,
    extendedTimeMultiplier: 1.5,
    breaksAllowed: true,
    reducedDistraction: false,
    assistiveTechnology: false,
    questionCount: 10,
    followUpQuestions: true,
    maxFollowUps: 2,
    allowRephrase: true,
    allowHints: false,
    recordVideo: true,
    recordAudio: true,
    generateTranscript: true,
    recommendedGrade: true,
    generateFeedback: true,
    professorReview: true,
  });
  assert.equal(storage.writes, 0);
  const first = loadExamSettings(storage, EXAM_A);
  first.timeLimit = 99;
  assert.equal(loadExamSettings(storage, EXAM_A).timeLimit, 30);
});

test('loading an existing partial draft supplies defaults without rewriting saved data', () => {
  const storage = memoryStorage();
  seed(storage, EXAM_A, { timeLimit: 48, recordAudio: false, difficulty: 3, teammateMetadata: { keep: true } });
  const before = storage.getItem(examSettingsStorageKey(EXAM_A));
  const loaded = loadExamSettings(storage, EXAM_A);
  assert.equal(loaded.timeLimit, 48);
  assert.equal(loaded.recordAudio, false);
  assert.equal(loaded.maxFollowUps, 2);
  assert.equal(loaded.difficulty, 3);
  assert.deepEqual(loaded.teammateMetadata, { keep: true });
  assert.equal(storage.getItem(examSettingsStorageKey(EXAM_A)), before);
  assert.equal(storage.writes, 0);
});

test('category keys partition every existing field exactly once', () => {
  assert.deepEqual(categorySettingKeys, {
    'time-scheduling': ['timeLimit'],
    'ods-accommodations': ['extendedTime', 'extendedTimeMultiplier', 'breaksAllowed', 'reducedDistraction', 'assistiveTechnology'],
    'ai-questioning': ['questionCount', 'followUpQuestions', 'maxFollowUps', 'allowRephrase', 'allowHints'],
    'recording-transcript': ['recordVideo', 'recordAudio', 'generateTranscript'],
    'ai-results': ['recommendedGrade', 'generateFeedback', 'professorReview'],
  });
  const keys = Object.values(categorySettingKeys).flat();
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...keys].sort(), Object.keys(defaultExamSettings).sort());
});

test('a stale category editor merges the latest other-category values and unknown fields', () => {
  const storage = memoryStorage();
  seed(storage, EXAM_A, { ...defaultExamSettings, timeLimit: 42, difficulty: 4, teammateMetadata: { retained: true } });
  const staleTime = { ...loadExamSettings(storage, EXAM_A), timeLimit: 55 };
  const staleOds = { ...loadExamSettings(storage, EXAM_A), extendedTime: true, extendedTimeMultiplier: 2 };
  const latest = { ...loadExamSettings(storage, EXAM_A), recordAudio: false };
  saveExamSettingsCategory(storage, EXAM_A, 'recording-transcript', latest);
  saveExamSettingsCategory(storage, EXAM_A, 'ods-accommodations', staleOds);
  const saved = saveExamSettingsCategory(storage, EXAM_A, 'time-scheduling', staleTime);
  assert.equal(saved.timeLimit, 55);
  assert.equal(saved.recordAudio, false);
  assert.equal(saved.extendedTime, true);
  assert.equal(saved.extendedTimeMultiplier, 2);
  assert.equal(saved.difficulty, 4);
  assert.deepEqual(saved.teammateMetadata, { retained: true });
  assert.deepEqual(JSON.parse(storage.getItem(examSettingsStorageKey(EXAM_A))), saved);
});

test('each category save applies only its own fields even when the editor has unrelated changes', () => {
  for (const category of Object.keys(categorySettingKeys)) {
    const storage = memoryStorage();
    const base = { ...defaultExamSettings, teammateMarker: 'keep' };
    seed(storage, EXAM_A, base);
    const changed = Object.fromEntries(Object.entries(defaultExamSettings).map(([key, value]) =>
      [key, typeof value === 'boolean' ? !value : key === 'maxFollowUps' ? 4 : value + 1]));
    const saved = saveExamSettingsCategory(storage, EXAM_A, category, changed);
    const ownKeys = new Set(categorySettingKeys[category]);
    for (const key of Object.keys(defaultExamSettings)) {
      assert.equal(saved[key], ownKeys.has(key) ? changed[key] : base[key], `${category}: ${key}`);
    }
    assert.equal(saved.teammateMarker, 'keep');
  }
});

test('unrelated invalid AI follow-up settings do not block or change another category save', () => {
  const storage = memoryStorage();
  seed(storage, EXAM_A, { ...defaultExamSettings, maxFollowUps: 99, difficulty: 2 });
  const saved = saveExamSettingsCategory(storage, EXAM_A, 'time-scheduling', {
    ...loadExamSettings(storage, EXAM_A), timeLimit: 44,
  });
  assert.equal(saved.timeLimit, 44);
  assert.equal(saved.maxFollowUps, 99);
  assert.equal(saved.difficulty, 2);
});

test('enabled AI follow-ups reject fractions, nonfinite values, and values outside one through four without writes', () => {
  const storage = memoryStorage();
  seed(storage, EXAM_A, { ...defaultExamSettings, difficulty: 3 });
  const before = storage.getItem(examSettingsStorageKey(EXAM_A));
  for (const value of [0, 5, -1, 1.5, NaN, Infinity, -Infinity]) {
    assert.throws(() => saveExamSettingsCategory(storage, EXAM_A, 'ai-questioning', {
      ...defaultExamSettings, maxFollowUps: value,
    }), /Maximum Follow-Ups Per Question must be a whole number from 1 to 4/);
    assert.equal(storage.getItem(examSettingsStorageKey(EXAM_A)), before);
  }
  assert.equal(storage.writes, 0);
});

test('AI save keeps valid follow-up boundaries and removes the obsolete difficulty field only at save time', () => {
  for (const value of [1, 4]) {
    const storage = memoryStorage();
    seed(storage, EXAM_A, { ...defaultExamSettings, difficulty: 5, timeLimit: 51, teammateMarker: 'keep' });
    const loaded = loadExamSettings(storage, EXAM_A);
    assert.equal(loaded.difficulty, 5);
    const saved = saveExamSettingsCategory(storage, EXAM_A, 'ai-questioning', { ...loaded, maxFollowUps: value });
    assert.equal(saved.maxFollowUps, value);
    assert.equal('difficulty' in saved, false);
    assert.equal(saved.timeLimit, 51);
    assert.equal(saved.teammateMarker, 'keep');
  }
});

test('disabled AI follow-ups normalize an invalid hidden limit to the existing default', () => {
  const storage = memoryStorage();
  const saved = saveExamSettingsCategory(storage, EXAM_A, 'ai-questioning', {
    ...defaultExamSettings, followUpQuestions: false, maxFollowUps: NaN,
  });
  assert.equal(saved.followUpQuestions, false);
  assert.equal(saved.maxFollowUps, 2);
});

test('saving one exam leaves another exam and independent policy/preference namespaces untouched', () => {
  const storage = memoryStorage();
  seed(storage, EXAM_A, { ...defaultExamSettings, timeLimit: 61 });
  storage.values.set(`oral-exam-avatar:v1:${JSON.stringify([EXAM_A, 'synthetic-instructor'])}`, 'separate avatar draft');
  storage.values.set(`oral-exam-policy-preview:v1:${JSON.stringify([EXAM_A, 'synthetic-instructor'])}`, 'separate policy');
  storage.values.set(`oral-exam-student-preview:v1:${JSON.stringify([EXAM_A, 'synthetic-student'])}`, 'separate preferences');
  const original = new Map(storage.values);
  const saved = saveExamSettingsCategory(storage, EXAM_B, 'ai-results', {
    ...defaultExamSettings, recommendedGrade: false,
  });
  assert.equal(saved.recommendedGrade, false);
  for (const [key, value] of original) assert.equal(storage.getItem(key), value);
  assert.equal(storage.values.size, original.size + 1);
});

test('malformed saved drafts are never overwritten by a category save', () => {
  for (const raw of ['not json', 'null', '[]', '42', '"draft"']) {
    const storage = memoryStorage();
    storage.values.set(examSettingsStorageKey(EXAM_A), raw);
    assert.throws(() => loadExamSettings(storage, EXAM_A));
    assert.throws(() => saveExamSettingsCategory(storage, EXAM_A, 'time-scheduling', defaultExamSettings));
    assert.equal(storage.getItem(examSettingsStorageKey(EXAM_A)), raw);
    assert.equal(storage.writes, 0);
  }
});

test('unreadable storage and quota errors propagate without changing saved values', () => {
  const unreadable = {
    writes: 0,
    getItem: () => { throw new Error('Synthetic read denied'); },
    setItem() { this.writes += 1; },
  };
  assert.throws(() => loadExamSettings(unreadable, EXAM_A), /Synthetic read denied/);
  assert.throws(() => saveExamSettingsCategory(unreadable, EXAM_A, 'time-scheduling', defaultExamSettings), /Synthetic read denied/);
  assert.equal(unreadable.writes, 0);
  const storage = memoryStorage();
  seed(storage, EXAM_A, { ...defaultExamSettings, timeLimit: 64 });
  const before = storage.getItem(examSettingsStorageKey(EXAM_A));
  const full = { getItem: storage.getItem, setItem: () => { throw new Error('Synthetic quota exceeded'); } };
  assert.throws(() => saveExamSettingsCategory(full, EXAM_A, 'time-scheduling', defaultExamSettings), /Synthetic quota exceeded/);
  assert.equal(storage.getItem(examSettingsStorageKey(EXAM_A)), before);
  assert.equal(storage.writes, 0);
});

test('dirty state compares only the current category and clears when its values are restored', () => {
  const saved = { ...defaultExamSettings };
  for (const category of Object.keys(categorySettingKeys)) {
    assert.equal(hasCategoryChanges(category, { ...saved }, saved), false);
    const key = categorySettingKeys[category][0];
    const changed = { ...saved, [key]: typeof saved[key] === 'boolean' ? !saved[key] : saved[key] + 1 };
    assert.equal(hasCategoryChanges(category, changed, saved), true);
    for (const other of Object.keys(categorySettingKeys).filter(item => item !== category)) {
      assert.equal(hasCategoryChanges(other, changed, saved), false);
    }
    changed[key] = saved[key];
    assert.equal(hasCategoryChanges(category, changed, saved), false);
  }
  assert.equal(hasCategoryChanges('ai-questioning', { ...saved, maxFollowUps: NaN }, saved), true);
});
