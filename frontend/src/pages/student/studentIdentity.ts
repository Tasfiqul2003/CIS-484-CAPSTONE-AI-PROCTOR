export type DeveloperFaceBypassHint = { student_id: string; eid: string; expires_at: string };
export const DEVELOPER_EIDS = ['student.demo', ...Array.from({ length: 52 }, (_, index) => `student.demo${index + 2}`)];
export const DEVELOPER_FACE_BYPASS_KEY = 'oralexam_developer_face_bypass';

/** Navigation hint only. The HttpOnly server grant authorizes every admission. */
export function readDeveloperFaceBypass(studentId: string, eid?: string): DeveloperFaceBypassHint | null {
  try {
    const raw = sessionStorage.getItem(DEVELOPER_FACE_BYPASS_KEY);
    if (!raw || raw.length > 2048) return null;
    const hint = JSON.parse(raw);
    const currentEid = eid ?? sessionStorage.getItem('oralexam_student_eid');
    if (!studentId || hint.student_id !== studentId || typeof hint.eid !== 'string'
        || hint.eid !== currentEid || !DEVELOPER_EIDS.includes(hint.eid)
        || typeof hint.expires_at !== 'string' || !Number.isFinite(Date.parse(hint.expires_at))
        || Date.parse(hint.expires_at) <= Date.now()) return null;
    return hint;
  } catch { return null; }
}

export function hasStudentFaceAccess(studentId: string, eid?: string) {
  if (!studentId || sessionStorage.getItem('oralexam_student_id') !== studentId) return false;
  return sessionStorage.getItem('oralexam_face_check_passed') === 'true'
    || readDeveloperFaceBypass(studentId, eid) !== null;
}

export function clearDeveloperFaceBypass() {
  sessionStorage.removeItem(DEVELOPER_FACE_BYPASS_KEY);
}
