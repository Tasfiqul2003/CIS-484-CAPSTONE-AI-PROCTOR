import { useEffect, useRef, useState } from "react";
import { createLiveVideo, type LiveVideoState } from "../../components/media/liveVideo";

export default function ProfessorLiveVideo() {
  const sessionId = window.location.pathname.split("/").filter(Boolean).at(-2);
  const controller = useRef<ReturnType<typeof createLiveVideo> | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<LiveVideoState>("waiting");
  const [message, setMessage] = useState("Start live viewing to connect to this active assessed attempt.");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => () => { controller.current?.stop(); }, []);
  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
    return () => { if (video.current) video.current.srcObject = null; };
  }, [stream]);

  function connect() {
    if (!sessionId) {
      setState("unavailable");
      setMessage("The attempt identifier is missing.");
      return;
    }
    controller.current?.stop();
    setStarted(true);
    controller.current = createLiveVideo({
      sessionId, role: "professor", onStream: setStream,
      onState: (next, detail) => { setState(next); setMessage(detail); },
    });
  }
  function disconnect() {
    controller.current?.stop();
    controller.current = null;
    setStarted(false);
    setState("ended");
    setMessage("Live viewing stopped.");
  }
  const active = started && !["ended", "unavailable"].includes(state);
  return (
    <main className="dashboard-main" style={{ maxWidth: "70rem", margin: "0 auto", padding: "1rem" }}>
      <a href="/professor/exams">Back to exams</a>
      <h1>Live student video</h1>
      <p>This view is available to the owning professor during an active assessed recording. Saved recording review is available separately after submission.</p>
      <p>Local live connections require a supported browser and a direct network path. Video starts muted; use the video controls to hear audio.</p>
      <p role="status" aria-live="polite">{message}</p>
      <div style={{ background: "#111827", borderRadius: "0.5rem", width: "100%", aspectRatio: "16 / 9" }}>
        <video ref={video} autoPlay playsInline muted controls aria-label="Authorized live student camera and microphone"
          style={{ visibility: state === "connected" ? "visible" : "hidden", width: "100%", height: "100%", objectFit: "contain" }} />
      </div>
      <div style={{ display: "flex", gap: "1rem", marginTop: "1rem", flexWrap: "wrap" }}>
        <button type="button" onClick={connect} disabled={active}>{started ? "Retry live viewing" : "Start live viewing"}</button>
        <button type="button" onClick={disconnect} disabled={!active}>Stop live viewing</button>
      </div>
      {state === "unavailable" && <p>If another live tab was interrupted, close it and wait fifteen seconds before retrying. This does not resume an interrupted assessed recording.</p>}
    </main>
  );
}
