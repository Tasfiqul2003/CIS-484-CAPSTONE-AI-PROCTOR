import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, BookOpen, ClipboardList, FolderOpen, LayoutDashboard, Users } from "lucide-react";
import { examManagementPath, examSettingsCategories, examSettingsPath } from "./examSettingsNavigation";
import ProfessorHeader from "../../components/professor/ProfessorHeader";
import "./exam-management.css";

export type ManagedExam = {
  id: string;
  title: string;
  course: string;
  description?: string;
  icon?: string;
  status?: string;
  question_count?: number;
  in_progress_count?: number;
  flagged_count?: number;
  submitted_student_count?: number;
  roster_count?: number;
};

/** Which part of the exam is open: the overview, a content page, or one of the settings areas. */
export type ExamSection = "overview" | "questions" | "materials" | "roster" | (typeof examSettingsCategories)[number]["slug"];

/** Manage Exam: a side menu of every part of the exam, with the open part on the right. */
export default function ExamManagementLayout({ examId, section = "overview", category: _category, children }: {
  examId: string;
  section?: ExamSection;
  /** Older callers pass the settings title; the side menu shows it now. */
  category?: string;
  children: (exam: ManagedExam, reload: () => Promise<void>) => ReactNode;
}) {
  const [exam, setExam] = useState<ManagedExam | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      if (!examId) throw new Error("Invalid exam URL.");
      // Keep the existing ownership check before mounting any settings editor.
      const response = await fetch("/api/auth/professor/exams", { credentials: "include", signal });
      if (!response.ok) throw new Error("Unable to load your examinations.");
      const exams: ManagedExam[] = await response.json();
      const selected = exams.find(item => item.id === examId);
      if (!selected) throw new Error("Exam not found, or you do not have permission to access it.");
      if (!signal?.aborted) setExam(selected);
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "Unable to load the examination.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setExam(null);
    setError("");
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const base = examManagementPath(examId);
  const link = (key: ExamSection, href: string, label: string, icon: ReactNode) =>
    <a href={href} aria-current={section === key ? "page" : undefined}>{icon}<span>{label}</span></a>;
  const published = exam?.status === "published";
  const sectionHref = (key: ExamSection) => key === "overview" ? base
    : key === "questions" || key === "materials" || key === "roster" ? `${base}/${key}`
      : examSettingsPath(examId, key);

  return <div className="professor-dashboard-page manage-exam-page manage-exam-v3">
    <ProfessorHeader title="Manage exam" current="exams" />
    <main className="manage-exam-shell">
      {loading ? <p role="status">Loading examination...</p> : error || !exam ? <p role="alert">{error || "Examination not found."}</p> : <>
        <aside className="manage-exam-sidebar" aria-label="This exam">
          <a href="/professor/exams" className="manage-exam-back"><ArrowLeft size={16} aria-hidden="true" />My Exams</a>
          <div className="manage-exam-sidebar-title">
            <span className={`exam-row-status ${published ? "published" : "draft"}`}>{published ? "Published" : "Draft"}</span>
            <p className="manage-exam-sidebar-name">{exam.title}</p>
            <p className="manage-exam-sidebar-course">{exam.course}</p>
          </div>
          <label className="manage-exam-jump">
            <span>Go to</span>
            <select value={section} onChange={event => { window.location.href = sectionHref(event.target.value as ExamSection); }}>
              <option value="overview">Overview</option>
              <option value="questions">Questions</option>
              <option value="materials">Course materials</option>
              <option value="roster">Student roster</option>
              <optgroup label="Settings">
                {examSettingsCategories.map(category => <option key={category.slug} value={category.slug}>{category.title.replace(" Settings", "")}</option>)}
              </optgroup>
            </select>
          </label>
          <nav aria-label="Exam sections">
            {link("overview", base, "Overview", <LayoutDashboard size={17} aria-hidden="true" />)}
            {link("questions", `${base}/questions`, "Questions", <BookOpen size={17} aria-hidden="true" />)}
            {link("materials", `${base}/materials`, "Course materials", <FolderOpen size={17} aria-hidden="true" />)}
            {link("roster", `${base}/roster`, "Student roster", <Users size={17} aria-hidden="true" />)}
            <p className="manage-exam-nav-heading">Settings</p>
            {examSettingsCategories.map(category => link(category.slug, examSettingsPath(examId, category.slug), category.title.replace(" Settings", ""),
              <span className="manage-exam-nav-glyph" aria-hidden="true">{category.icon}</span>))}
            <p className="manage-exam-nav-heading">Results</p>
            <a href={`${base}/submissions`}><ClipboardList size={17} aria-hidden="true" /><span>Student progress</span></a>
          </nav>
        </aside>
        <div className="manage-exam-main">{children(exam, () => load())}</div>
      </>}
    </main>
    <footer className="home-footer"><p>OralExam AI</p><p>AI-assisted oral examination platform</p></footer>
  </div>;
}
