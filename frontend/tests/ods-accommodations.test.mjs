import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require(process.env.AVATAR_TYPESCRIPT_PATH || 'typescript');
const source = await readFile(new URL('../src/components/exam-settings/odsAssignmentState.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  reportDiagnostics: true,
});
assert.deepEqual(compiled.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), []);
const { normalizedEid, readOdsAccommodations, validExtendedTimeMultiplier } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);

const assignment = {
  student_id: 'synthetic-student-1', eid: '000123', name: 'Synthetic Student',
  extended_time_multiplier: 1.5, effective_time_limit_minutes: 45,
};
const saved = { time_limit_minutes: 30, question_time_limit_minutes: 2, assignments: [assignment] };

test('EIDs remain strings and retain leading zeros while empty input is rejected', () => {
  assert.equal(normalizedEid(' 000123 '), '000123');
  assert.equal(normalizedEid('0'), '0');
  assert.equal(normalizedEid(' SyntheticEID '), 'SyntheticEID');
  for (const eid of ['', ' ', '\n\t']) assert.throws(() => normalizedEid(eid), /roster EID/);
});

test('only supported numeric extended-time multipliers are accepted', () => {
  for (const multiplier of [1.25, 1.5, 2, 3]) assert.equal(validExtendedTimeMultiplier(multiplier), true);
  for (const value of [1, 0, -1, 4, 1.75, '1.5', true, null, undefined, NaN, Infinity]) {
    assert.equal(validExtendedTimeMultiplier(value), false);
  }
});

test('saved assignments preserve EIDs and keep question limits separate from effective exam time', () => {
  const state = readOdsAccommodations(saved);
  assert.deepEqual(state, saved);
  assert.notEqual(state.assignments[0], assignment);
  state.assignments[0].name = 'Edited view';
  assert.equal(assignment.name, 'Synthetic Student');
  assert.equal(state.question_time_limit_minutes, 2);
  for (const multiplier of [1.25, 1.5, 2, 3]) {
    const result = readOdsAccommodations({
      time_limit_minutes: 1, question_time_limit_minutes: null,
      assignments: [{ ...assignment, extended_time_multiplier: multiplier, effective_time_limit_minutes: multiplier }],
    });
    assert.equal(result.assignments[0].effective_time_limit_minutes, multiplier);
  }
});

test('assignments may be saved before a total exam limit is configured', () => {
  assert.deepEqual(readOdsAccommodations({
    time_limit_minutes: null, question_time_limit_minutes: null,
    assignments: [{ ...assignment, effective_time_limit_minutes: null }],
  }).assignments[0].effective_time_limit_minutes, null);
  assert.deepEqual(readOdsAccommodations({ ...saved, assignments: [] }).assignments, []);
});

test('malformed server responses cannot be presented as saved assignments', () => {
  const badAssignments = [
    null, {}, { ...assignment, eid: 123 }, { ...assignment, eid: ' ' },
    { ...assignment, student_id: '' }, { ...assignment, name: null },
    { ...assignment, extended_time_multiplier: '1.5' },
    { ...assignment, extended_time_multiplier: 4 },
    { ...assignment, effective_time_limit_minutes: 30 },
    { ...assignment, effective_time_limit_minutes: null },
    { ...assignment, effective_time_limit_minutes: Infinity },
  ];
  for (const value of [null, [], {}, { ...saved, assignments: null },
    { ...saved, time_limit_minutes: '30' }, { ...saved, time_limit_minutes: 0 },
    { ...saved, question_time_limit_minutes: 1.5 }, { ...saved, question_time_limit_minutes: 241 },
    ...badAssignments.map(item => ({ ...saved, assignments: [item] })),
  ]) assert.throws(() => readOdsAccommodations(value), /invalid ODS assignments/);
});

test('duplicate identities and case-insensitive duplicate EIDs are rejected', () => {
  for (const second of [assignment, { ...assignment, student_id: 'other' },
    { ...assignment, student_id: 'other', eid: ' 000123 ' }]) {
    assert.throws(() => readOdsAccommodations({ ...saved, assignments: [assignment, second] }), /invalid ODS assignments/);
  }
  assert.throws(() => readOdsAccommodations({ ...saved, assignments: [
    { ...assignment, eid: 'Synthetic' }, { ...assignment, student_id: 'other', eid: 'SYNTHETIC' },
  ] }), /invalid ODS assignments/);
});
