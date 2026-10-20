export default function FaceVerification() {
  const params = new URLSearchParams(window.location.search);
  const templateId = params.get("templateId") || "";
  const studentId = params.get("studentId") || "";

  function continueToExam() {
    if (!templateId || !studentId) {
      window.location.href = "/student/exams";
      return;
    }

    const query = new URLSearchParams({
      templateId,
      studentId,
    });

    window.location.href = `/student/exam?${query.toString()}`;
  }

  if (!templateId || !studentId) {
    return (
      <main className="face-page">
        <h1>Verification information missing</h1>
        <p>Please select an exam and verify your EID first.</p>
        <a href="/student/exams">Return to My Exams</a>
      </main>
    );
  }

  return (
    <div className="face-page">
      <h1>Face Verification</h1>
      <p>Your EID has been checked against the selected exam roster.</p>

      <h2>Position your face in the camera</h2>
      <div className="camera-preview">Camera Preview</div>
      <p>
        Face recognition has not been implemented yet. This screen is a
        placeholder and does not verify a face.
      </p>

      <button type="button" onClick={continueToExam}>
        Continue to Exam →
      </button>
    </div>
  );
}
