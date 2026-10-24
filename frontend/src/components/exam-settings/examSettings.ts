export type ExamSettingsCategory =
  | "time-scheduling"
  | "ods-accommodations"
  | "ai-questioning"
  | "recording-transcript"
  | "ai-results";

export type ExamSettings = {
  timeLimit: number;
  extendedTime: boolean;
  extendedTimeMultiplier: number;
  breaksAllowed: boolean;
  reducedDistraction: boolean;
  assistiveTechnology: boolean;
  questionCount: number;
  followUpQuestions: boolean;
  maxFollowUps: number;
  allowRephrase: boolean;
  allowHints: boolean;
  recordVideo: boolean;
  recordAudio: boolean;
  generateTranscript: boolean;
  recommendedGrade: boolean;
  generateFeedback: boolean;
  professorReview: boolean;
};

export const defaultExamSettings: ExamSettings = {
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
};

export const categorySettingKeys: Record<ExamSettingsCategory, readonly (keyof ExamSettings)[]> = {
  "time-scheduling": ["timeLimit"],
  "ods-accommodations": ["extendedTime", "extendedTimeMultiplier", "breaksAllowed", "reducedDistraction", "assistiveTechnology"],
  "ai-questioning": ["questionCount", "followUpQuestions", "maxFollowUps", "allowRephrase", "allowHints"],
  "recording-transcript": ["recordVideo", "recordAudio", "generateTranscript"],
  "ai-results": ["recommendedGrade", "generateFeedback", "professorReview"],
};

type SettingsStorage = Pick<Storage, "getItem" | "setItem">;
type StoredSettings = ExamSettings & Record<string, unknown>;

// Keep the original Manage Exam key so dedicated settings URLs share existing data.
export function examSettingsStorageKey(examId: string): string {
  return `oralExamSettings-/professor/exams/${examId}`;
}

export function loadExamSettings(storage: Pick<SettingsStorage, "getItem">, examId: string): StoredSettings {
  const raw = storage.getItem(examSettingsStorageKey(examId));
  if (raw === null) return { ...defaultExamSettings };
  const saved: unknown = JSON.parse(raw);
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
    throw new Error("The saved browser draft is not a settings object.");
  }
  return { ...defaultExamSettings, ...saved } as StoredSettings;
}

export function hasCategoryChanges(category: ExamSettingsCategory, current: ExamSettings, saved: ExamSettings): boolean {
  return categorySettingKeys[category].some(key => !Object.is(current[key], saved[key]));
}

export function validMaxFollowUps(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 4;
}

export function saveExamSettingsCategory(
  storage: SettingsStorage,
  examId: string,
  category: ExamSettingsCategory,
  settings: ExamSettings,
): StoredSettings {
  if (category === "ai-questioning" && settings.followUpQuestions && !validMaxFollowUps(settings.maxFollowUps)) {
    throw new Error("Maximum Follow-Ups Per Question must be a whole number from 1 to 4.");
  }
  // Read again at save time: another category may have saved since this page loaded.
  const next = loadExamSettings(storage, examId);
  for (const key of categorySettingKeys[category]) {
    Object.assign(next, { [key]: settings[key] });
  }
  if (category === "ai-questioning") {
    // Match the former editor's save-time cleanup without changing other categories.
    delete next.difficulty;
    if (!validMaxFollowUps(next.maxFollowUps)) next.maxFollowUps = defaultExamSettings.maxFollowUps;
  }
  storage.setItem(examSettingsStorageKey(examId), JSON.stringify(next));
  return next;
}
