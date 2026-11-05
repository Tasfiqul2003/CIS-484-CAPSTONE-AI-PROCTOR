export const extendedTimeMultipliers = [1.25, 1.5, 2, 3] as const;

export type OdsAssignment = {
  student_id: string;
  eid: string;
  name: string;
  extended_time_multiplier: number;
  effective_time_limit_minutes: number | null;
};

export type OdsAccommodationsState = {
  time_limit_minutes: number | null;
  question_time_limit_minutes: number | null;
  assignments: OdsAssignment[];
};

export function validExtendedTimeMultiplier(value: unknown): value is number {
  return typeof value === "number" && extendedTimeMultipliers.some(multiplier => multiplier === value);
}

export function normalizedEid(value: string): string {
  const eid = value.trim();
  if (!eid) throw new Error("Enter the student's roster EID.");
  return eid;
}

export function readOdsAccommodations(value: unknown): OdsAccommodationsState {
  const invalid = () => new Error("The server returned invalid ODS assignments. Reload to verify the saved list.");
  const record = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item);
  const limit = (item: unknown): item is number | null => item === null ||
    (typeof item === "number" && Number.isInteger(item) && item >= 1 && item <= 240);
  if (!record(value) || !limit(value.time_limit_minutes) ||
      !limit(value.question_time_limit_minutes) || !Array.isArray(value.assignments)) throw invalid();
  const examMinutes = value.time_limit_minutes;
  const questionMinutes = value.question_time_limit_minutes;

  const ids = new Set<string>();
  const eids = new Set<string>();
  const assignments = value.assignments.map((item: unknown): OdsAssignment => {
    if (!record(item) || typeof item.student_id !== "string" || !item.student_id.trim() ||
        typeof item.eid !== "string" || !item.eid.trim() || typeof item.name !== "string" ||
        !validExtendedTimeMultiplier(item.extended_time_multiplier)) throw invalid();
    const minutes = item.effective_time_limit_minutes;
    if (examMinutes === null ? minutes !== null :
        typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0 ||
        minutes !== examMinutes * item.extended_time_multiplier) throw invalid();
    const eid = item.eid.trim().toLowerCase();
    if (ids.has(item.student_id) || eids.has(eid)) throw invalid();
    ids.add(item.student_id);
    eids.add(eid);
    return {
      student_id: item.student_id, eid: item.eid, name: item.name,
      extended_time_multiplier: item.extended_time_multiplier,
      effective_time_limit_minutes: minutes as number | null,
    };
  });
  return {
    time_limit_minutes: examMinutes,
    question_time_limit_minutes: questionMinutes,
    assignments,
  };
}
