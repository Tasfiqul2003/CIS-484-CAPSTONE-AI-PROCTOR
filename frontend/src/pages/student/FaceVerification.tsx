import OralExamMark from "../../components/brand/OralExamMark";
export default function FaceVerification() {
  const studentId = sessionStorage.getItem("oralexam_student_id") || "";
  const studentName = sessionStorage.getItem("oralexam_student_name") || "";

  function continueToPortal() {
    if (!studentId || !sessionStorage.getItem("oralexam_student_eid")) {
      window.location.href = "/student/verification";
      return;
    }

    // Prototype only: this flag represents acknowledgement of the placeholder,
    // not successful biometric or camera verification.
    sessionStorage.setItem("oralexam_face_check_passed", "true");
    window.location.href = "/student/exams";
  }

  if (!studentId) {
    return (
      <main className="face-page">
        <h1>Student verification required</h1>
        <p>Please swipe your JACard before continuing.</p>
        <button type="button" onClick={() => { window.location.href = "/student/verification"; }}>
          Start Verification
        </button>
      </main>
    );
  }

  return (
    <div className="face-page">
      <header className="simple-header">
        <div className="logo"><span className="logo-icon" aria-hidden="true"><OralExamMark size={34} /></span><span>OralExam AI</span></div>
      </header>
      <main className="verification-content">
        <div className="verification-card">
          <p className="eyebrow">STEP 2 OF 3</p>
          <h1>Video / Face Check</h1>
          <p>Welcome, {studentName}. Please position yourself in front of the camera.</p>
          <div className="camera-preview">Camera preview is not connected</div>
          <p role="note">
            Prototype limitation: camera capture and facial identity matching
            are not implemented. Continuing does not verify your face.
          </p>
          <button type="button" className="continue-button" onClick={continueToPortal}>
            Continue to Exam Portal →
          </button>
          <button type="button" className="back-button" onClick={() => { window.location.href = "/"; }}>
            Cancel and Return Home
          </button>
        </div>
      </main>
    </div>
  );
}
