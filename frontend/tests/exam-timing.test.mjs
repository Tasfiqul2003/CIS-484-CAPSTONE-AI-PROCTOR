import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = await readFile(new URL('../src/pages/student/examTiming.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { readExamClock, remainingTime, formatRemaining } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
);
const timing = {
  server_now: '2026-01-01T12:00:00Z',
  deadline: '2026-01-01T12:30:00Z',
  question_deadline: '2026-01-01T12:02:00Z',
};

test('exam and question clocks use server time plus monotonic elapsed time', () => {
  const clock = readExamClock(timing, 5000);
  assert.deepEqual(remainingTime(clock, 5000), { exam: 1800, question: 120 });
  assert.deepEqual(remainingTime(clock, 6500), { exam: 1799, question: 119 });
  assert.deepEqual(remainingTime(clock, 125000), { exam: 1680, question: 0 });
  assert.deepEqual(remainingTime(clock, 2000000), { exam: 0, question: 0 });
});

test('resuming retains deadlines and a new question resets only the question clock', () => {
  const resumed = readExamClock({ ...timing, server_now: '2026-01-01T12:01:30Z' }, 0);
  assert.deepEqual(remainingTime(resumed, 0), { exam: 1710, question: 30 });
  const next = readExamClock({
    ...timing, server_now: '2026-01-01T12:02:00Z', question_deadline: '2026-01-01T12:04:00Z',
  }, 0);
  assert.deepEqual(remainingTime(next, 0), { exam: 1680, question: 120 });
});

test('no question limit and an earlier exam deadline remain independent', () => {
  assert.deepEqual(remainingTime(readExamClock({ ...timing, question_deadline: null }, 0), 0),
    { exam: 1800, question: null });
  const clock = readExamClock({ ...timing, deadline: '2026-01-01T12:01:00Z' }, 0);
  assert.deepEqual(remainingTime(clock, 60000), { exam: 0, question: 60 });
  assert.deepEqual(remainingTime(readExamClock({ ...timing, deadline: null, question_deadline: null }, 0), 0),
    { exam: null, question: null });
});

test('invalid server clocks fail visibly instead of silently disabling a timer', () => {
  for (const key of ['server_now', 'deadline', 'question_deadline']) {
    for (const value of ['invalid', '', undefined, 12]) {
      assert.throws(() => readExamClock({ ...timing, [key]: value }, 0), /invalid timing information/);
    }
  }
  assert.throws(() => readExamClock({ ...timing, server_now: null }, 0), /invalid timing information/);
  assert.equal(formatRemaining(0), '0:00');
  assert.equal(formatRemaining(61), '1:01');
  assert.equal(formatRemaining(14400), '240:00');
});

test('bounded server assistance pauses freeze both clocks and completion resumes them', () => {
  const paused = readExamClock({ ...timing, pause_until: '2026-01-01T12:01:00Z' }, 0);
  assert.deepEqual(remainingTime(paused, 30000), { exam: 1800, question: 120 });
  assert.deepEqual(remainingTime(paused, 65000), { exam: 1795, question: 115 });
  const completed = readExamClock({ ...timing, server_now: '2026-01-01T12:00:30Z',
    deadline: '2026-01-01T12:30:30Z', question_deadline: '2026-01-01T12:02:30Z', pause_until: null }, 30000);
  assert.deepEqual(remainingTime(completed, 35000), { exam: 1795, question: 115 });
  assert.throws(() => readExamClock({ ...timing, pause_until: 'invalid' }, 0), /invalid timing information/);
});
