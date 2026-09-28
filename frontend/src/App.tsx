import Home from "./pages/Home";
import StudentVerification from "./pages/student/StudentVerification";
import FaceVerification from "./pages/student/FaceVerification";
import StudentExams from "./pages/student/StudentExams";
import StudentExam from "./pages/student/StudentExam";

function App() {
  const path = window.location.pathname;

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

  return <Home />;
}

export default App;
