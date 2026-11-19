import { useEffect, useState } from "react";
import ExamCategorySettings from "./ExamCategorySettings";
import OdsAccommodations from "./OdsAccommodations";

export default function TimeAndOds({ examId }: { examId: string }) {
  const [timeRevision, setTimeRevision] = useState(0);
  useEffect(() => {
    const target = window.location.hash.slice(1);
    if (["time-limits", "ods-accommodations"].includes(target)) {
      document.getElementById(target)?.scrollIntoView();
    }
  }, []);

  return <div className="exam-combined-page">
    <header className="exam-combined-heading">
      <h1>Time and ODS</h1>
      <p>Set standard time limits and assign approved extended time for students in this exam.</p>
    </header>
    <nav className="exam-section-jump" aria-label="Time and ODS sections">
      <a href="#time-limits">Time limits</a>
      <a href="#ods-accommodations">ODS accommodations</a>
    </nav>
    <div id="time-limits" className="exam-combined-section">
      <ExamCategorySettings examId={examId} category="time-scheduling"
        onTimeSettingsSaved={() => setTimeRevision(current => current + 1)} />
    </div>
    <div id="ods-accommodations" className="exam-combined-section">
      <OdsAccommodations examId={examId} refreshKey={timeRevision} />
    </div>
  </div>;
}
