import Home from "./pages/Home";

import StudentVerification from "./pages/student/StudentVerification";
import FaceVerification from "./pages/student/FaceVerification";
import StudentExams from "./pages/student/StudentExams";
import StudentExam from "./pages/student/StudentExam";
import StudentSettingsPreview from "./pages/student/StudentSettingsPreview";

import ProfessorLogin from "./pages/professor/ProfessorLogin";
import ProfessorDashboard from "./pages/professor/ProfessorDashboard";
import ProfessorExams from "./pages/professor/ProfessorExams";
import QuestionBank from "./pages/professor/QuestionBank";
import MaterialUpload from "./pages/professor/MaterialUpload";
import CreateExam from "./pages/professor/CreateExam";
import ManageExam from "./pages/professor/ManageExam";
import ExamSettingsPage, { LegacyAvatarSettingsRedirect } from "./pages/professor/ExamSettingsPage";
import { examSettingsCategories } from "./pages/professor/examSettingsNavigation";
import ExamSubmissions from "./pages/professor/ExamSubmissions";
import ExamSubmitted from "./pages/student/ExamSubmitted";

function App() {
  const path = window.location.pathname;

  /* ================================
     STUDENT PATHS
  ================================= */

  if (path === "/student/verification") {
    return <StudentVerification />;
  }

  if (path === "/student/face-verification") {
    return <FaceVerification />;
  }

  if (path === "/student/exams") {
    return <StudentExams />;
  }

  if (path === "/student/settings-preview") {
    return <StudentSettingsPreview />;
  }

  if (path === "/student/exam/submitted") {
  return <ExamSubmitted />;
  }

  if (path === "/student/exam") {
    return <StudentExam />;
  }

  /* ================================
     PROFESSOR PATHS
  ================================= */

  if (path === "/professor/login") {
    return <ProfessorLogin />;
  }

  if (path === "/professor/dashboard") {
    return <ProfessorDashboard />;
  }

  if (path === "/professor/exams") {
    return <ProfessorExams />;
  }

  if (path === "/professor/questions") {
    return <QuestionBank />;
  }

  if (path === "/professor/materials") {
    return <MaterialUpload />;
  }

  /* CREATE NEW EXAM
     This MUST come before the dynamic
     /professor/exams/:id route.
  */

if (path === "/professor/exams/new") {
  return <CreateExam />;
}

  // Specific settings pages must precede the general Manage Exam route.
  const settingsRoute = path.match(/^\/professor\/exams\/([^/]+)\/settings\/([^/]+)\/?$/);
  const settingsCategory = examSettingsCategories.find(item => item.slug === settingsRoute?.[2]);
  if (settingsRoute && settingsCategory) {
    return <ExamSettingsPage examId={settingsRoute[1]} category={settingsCategory.slug} />;
  }

  // Preserve bookmarks from the original inline avatar editor.
  const legacyAvatar = path.match(/^\/professor\/exams\/([^/]+)\/avatar-settings\/?$/)
    ?? (window.location.hash === "#avatar-settings" ? path.match(/^\/professor\/exams\/([^/]+)\/?$/) : null);
  if (legacyAvatar) {
    return <LegacyAvatarSettingsRedirect examId={legacyAvatar[1]} />;
  }

if (
  path.startsWith("/professor/exams/") &&
  path.endsWith("/questions")
  ) {
    return <QuestionBank />;
  }

  if (
    path.startsWith("/professor/exams/") &&
    path.endsWith("/materials")
  ) {
    return <MaterialUpload />;
  }

  if (
  path.startsWith("/professor/exams/") &&
  path.endsWith("/submissions")
  ) {
    return <ExamSubmissions />;
  }

  if (
    path.startsWith("/professor/exams/") &&
    !path.includes("/questions") &&
    !path.includes("/materials") &&
    !path.includes("/submissions")
  ) {
    return <ManageExam />;
  }

  /* ================================
     HOME FALLBACK
  ================================= */

  return <Home />;
}

export default App;
