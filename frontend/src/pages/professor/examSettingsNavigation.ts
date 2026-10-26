export const examSettingsCategories = [
  { slug: "avatar-interaction", title: "Avatar & Interaction Settings", icon: "◉", description: "Presentation, student controls, assistance permissions, and exam behavior." },
  { slug: "time-scheduling", title: "Time & Scheduling", icon: "⏱", description: "Set the standard time limit for this examination." },
  { slug: "ods-accommodations", title: "ODS Accommodations", icon: "♿", description: "Configure extended time, breaks, and accessibility features." },
  { slug: "ai-questioning", title: "AI Questioning", icon: "✦", description: "Manage question counts, follow-ups, rephrasing, and hints." },
  { slug: "recording-transcript", title: "Recording & Transcript", icon: "▤", description: "Choose video, audio, and transcript options." },
  { slug: "ai-results", title: "AI Results", icon: "✓", description: "Configure recommended grades, feedback, and professor review." },
] as const;

export type ExamSettingsSlug = typeof examSettingsCategories[number]["slug"];

export function examManagementPath(examId: string) {
  return `/professor/exams/${examId}`;
}

export function examSettingsPath(examId: string, category: ExamSettingsSlug) {
  return `${examManagementPath(examId)}/settings/${category}`;
}
