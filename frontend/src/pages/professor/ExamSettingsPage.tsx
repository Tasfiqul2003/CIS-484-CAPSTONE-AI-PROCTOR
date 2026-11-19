import { useEffect } from "react";
import AvatarSettings from "../../components/avatar/AvatarSettings";
import ExamCategorySettings from "../../components/exam-settings/ExamCategorySettings";
import TimeAndOds from "../../components/exam-settings/TimeAndOds";
import RubricEditor from "../../components/exam-settings/RubricEditor";
import ExamManagementLayout from "./ExamManagementLayout";
import { examSettingsCategories, examSettingsPath, type ExamSettingsSlug } from "./examSettingsNavigation";

export function LegacyAvatarSettingsRedirect({ examId }: { examId: string }) {
  useEffect(() => {
    window.location.replace(examSettingsPath(examId, "avatar-interaction") + window.location.search);
  }, [examId]);
  return <p role="status">Opening Avatar &amp; Interaction Settings…</p>;
}

export default function ExamSettingsPage({ examId, category }: { examId: string; category: ExamSettingsSlug }) {
  const selected = examSettingsCategories.find(item => item.slug === category)!;
  return <ExamManagementLayout examId={examId} section={category} category={selected.title}>{exam =>
    category === "avatar-interaction"
      ? <AvatarSettings examId={exam.id} defaultOpen />
      : category === "time-ods"
        ? <TimeAndOds key={exam.id} examId={exam.id} />
        : category === "ai-results"
          ? <><RubricEditor examId={exam.id} /><ExamCategorySettings examId={exam.id} category={category} /></>
          : <ExamCategorySettings examId={exam.id} category={category} />
  }</ExamManagementLayout>;
}
