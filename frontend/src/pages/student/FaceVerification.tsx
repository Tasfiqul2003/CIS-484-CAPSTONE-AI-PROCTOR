import { useEffect, useRef, useState } from "react";
import OralExamMark from "../../components/brand/OralExamMark";

export default function FaceVerification() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraRequestRef = useRef(0);
  const cameraStartingRef = useRef(false);

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraComplete, setCameraComplete] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(5);
  const [error, setError] = useState("");

  const studentId = sessionStorage.getItem("oralexam_student_id");
  const studentName = sessionStorage.getItem("oralexam_student_name");

  useEffect(() => {
    return () => {
      cameraRequestRef.current += 1;
      streamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!cameraActive) return;
    if (remainingSeconds === 0) {
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setCameraActive(false);
      setCameraComplete(true);
      return;
    }

    const timer = window.setTimeout(
      () => setRemainingSeconds(seconds => seconds - 1),
      1000
    );
    return () => window.clearTimeout(timer);
  }, [cameraActive, remainingSeconds]);

  async function startCamera() {
    setError("");
    if (cameraStartingRef.current) return;

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError("Camera access requires HTTPS (or localhost) and a supported browser.");
      return;
    }

    const requestId = ++cameraRequestRef.current;
    cameraStartingRef.current = true;
    setCameraStarting(true);
    setCameraComplete(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false
      });

      if (requestId !== cameraRequestRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      streamRef.current = stream;
      setRemainingSeconds(5);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setCameraActive(true);
    } catch (cameraError) {
      if (requestId !== cameraRequestRef.current) return;
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;

      if (cameraError instanceof DOMException && cameraError.name === "NotAllowedError") {
        setError("Camera permission was denied. Allow camera access in your browser and try again.");
      } else if (cameraError instanceof DOMException && cameraError.name === "NotFoundError") {
        setError("No camera was found. Connect a camera and try again.");
      } else {
        setError("Unable to start the camera. Check browser permissions and try again.");
      }
    } finally {
      if (requestId === cameraRequestRef.current) {
        cameraStartingRef.current = false;
        setCameraStarting(false);
      }
    }
  }

  function stopCamera() {
    cameraRequestRef.current += 1;
    cameraStartingRef.current = false;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraActive(false);
    setCameraStarting(false);
    setCameraComplete(false);
    setRemainingSeconds(5);
  }

  function continueToPortal() {
    if (
      !cameraComplete ||
      !studentId ||
      !sessionStorage.getItem("oralexam_student_eid")
    ) {
      window.location.href = "/student/verification";
      return;
    }

    // This client-side flag gates the prototype flow; it does not verify identity.
    sessionStorage.setItem("oralexam_face_check_passed", "true");
    window.location.href = "/student/exams";
  }

  if (!studentId) {
    return (
      <main className="face-page">
        <h1>Student verification required</h1>
        <p>Please complete JACard verification first.</p>
        <a href="/student/verification">Start Verification</a>
      </main>
    );
  }

  return (
    <div className="face-page">
      <header className="simple-header">
        <div className="logo">
          <span className="logo-icon">
            <OralExamMark size={34} />
          </span>
          <span>OralExam AI</span>
        </div>
      </header>

      <main className="verification-content">
        <div className="verification-card">
          <p className="eyebrow">STEP 2 OF 3</p>
          <h1>Camera Check</h1>

          <p>
            Welcome, {studentName}.
            Look at the camera for five seconds. You do not need to hold your JACard.
          </p>

          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="camera-live-preview"
            aria-label="Live camera preview"
          />

          {error && <p role="alert">{error}</p>}

          {cameraStarting ? (
            <p role="status">Waiting for camera access…</p>
          ) : cameraActive ? (
            <>
              <p role="status" aria-live="polite">
                Camera preview ends in {remainingSeconds} seconds.
              </p>
              <button
                type="button"
                className="back-button"
                onClick={stopCamera}
              >
                Stop Camera
              </button>
            </>
          ) : cameraComplete ? (
            <>
              <p role="status">
                Five-second preview complete. No video was recorded or saved.
              </p>
              <button
                type="button"
                className="continue-button"
                onClick={continueToPortal}
              >
                Continue to Exam Portal →
              </button>
              <button
                type="button"
                className="back-button"
                onClick={() => void startCamera()}
              >
                Repeat Camera Preview
              </button>
            </>
          ) : (
            <button
              type="button"
              className="continue-button"
              onClick={() => void startCamera()}
            >
              Start 5-Second Camera Preview
            </button>
          )}

          <p role="note">
            This is a camera preview only, not facial recognition or identity
            matching. The video is not recorded or stored.
          </p>

          <button
            type="button"
            className="back-button"
            onClick={() => { window.location.href = "/"; }}
          >
            Cancel and Return Home
          </button>
        </div>
      </main>
    </div>
  );
}
