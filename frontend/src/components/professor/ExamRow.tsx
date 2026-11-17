export type ExamRowData = {
  id: string;
  title: string;
  course: string | null;
  status: string;
  question_count: number;
  submission_count: number;
  in_progress_count: number;
  flagged_count: number;
  submitted_student_count?: number;
  roster_count?: number;
};

/** One exam in the professor's lists: status, name and course; progress; the three everyday actions.
 *  Deleting an exam lives on its Manage Exam page. */
export default function ExamRow({ exam, busy, onTogglePublication }: {
  exam: ExamRowData;
  busy: boolean;
  onTogglePublication: () => void;
}) {
  const published = exam.status === "published";
  const roster = exam.roster_count ?? 0;
  const submitted = exam.submitted_student_count ?? exam.submission_count;
  return <li className="exam-row exam-row-v3">
    <div className="exam-row-main">
      <span className={`exam-row-status ${published ? "published" : "draft"}`}>{published ? "Published" : "Draft"}</span>
      <h3>{exam.title}</h3>
      <p className="exam-row-course">{exam.course || "Oral exam"}</p>
      <p className="exam-row-questions">{exam.question_count} question{exam.question_count === 1 ? "" : "s"}</p>
    </div>
    <div className="exam-row-progress">
      <p className="exam-row-submitted">
        <strong>{submitted}{roster > 0 ? ` / ${roster}` : ""}</strong> submitted
      </p>
      <p>{exam.in_progress_count} in progress</p>
      <p className={exam.flagged_count > 0 ? "exam-row-flagged" : undefined}>{exam.flagged_count} flagged</p>
    </div>
    <div className="exam-row-actions">
      <a href={`/professor/exams/${exam.id}/submissions`}>View submissions</a>
      <a className="exam-row-primary" href={`/professor/exams/${exam.id}`}>Manage exam</a>
      <button type="button" disabled={busy} onClick={onTogglePublication}>{published ? "Unpublish" : "Publish"}</button>
    </div>
  </li>;
}
