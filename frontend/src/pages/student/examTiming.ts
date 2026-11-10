export type ExamTiming = {
  deadline: string | null;
  question_deadline: string | null;
  server_now: string;
  pause_until?: string | null;
};

export type ExamClock = {
  examDeadline: number | null;
  questionDeadline: number | null;
  serverNow: number;
  received: number;
  pauseUntil: number | null;
};

export type RemainingTime = { exam: number | null; question: number | null };

export function readExamClock(timing: ExamTiming, received: number): ExamClock {
  const parse = (value: string | null): number | null => {
    if (value === null) return null;
    const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(milliseconds)) throw new Error("The server returned invalid timing information.");
    return milliseconds;
  };
  const serverNow = parse(timing.server_now);
  if (serverNow === null) throw new Error("The server returned invalid timing information.");
  return {
    examDeadline: parse(timing.deadline),
    questionDeadline: parse(timing.question_deadline),
    pauseUntil: parse(timing.pause_until === undefined ? null : timing.pause_until),
    serverNow,
    received,
  };
}

export function remainingTime(clock: ExamClock, now: number): RemainingTime {
  const sinceReceipt = Math.max(0, now - clock.received);
  const pause = clock.pauseUntil === null ? 0 : Math.max(0, clock.pauseUntil - clock.serverNow);
  const elapsed = Math.max(0, sinceReceipt - pause);
  const seconds = (deadline: number | null) => deadline === null ? null
    : Math.max(0, Math.ceil((deadline - clock.serverNow - elapsed) / 1000));
  return { exam: seconds(clock.examDeadline), question: seconds(clock.questionDeadline) };
}

export function formatRemaining(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
