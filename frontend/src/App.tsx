import Home from "./pages/Home";

import StudentVerification from "./pages/student/StudentVerification";
import FaceVerification from "./pages/student/FaceVerification";
import StudentExams from "./pages/student/StudentExams";
import StudentExam from "./pages/student/StudentExam";

import ProfessorLogin from "./pages/professor/ProfessorLogin";
import ProfessorDashboard from "./pages/professor/ProfessorDashboard";
import ProfessorExams from "./pages/professor/ProfessorExams";
import QuestionBank from "./pages/professor/QuestionBank";
import MaterialUpload from "./pages/professor/MaterialUpload";
import CreateExam from "./pages/professor/CreateExam";
import ManageExam from "./pages/professor/ManageExam";

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

  /* INDIVIDUAL EXAM */

  if (
    path.startsWith("/professor/exams/") &&
    path.split("/").length === 4
  ) {
    return <ManageExam />;
  }

  /* ================================
     HOME FALLBACK
  ================================= */

  return <Home />;
}

export default App;
