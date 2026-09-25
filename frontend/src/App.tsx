import Home from "./pages/Home";
import StudentVerification from "./pages/student/StudentVerification";

function App() {
  const path = window.location.pathname;

  if (path === "/student/verification") {
    return <StudentVerification />;
  }

  return <Home />;
}

export default App;
