// Sends one small camera frame to the server every few seconds during an assessed exam.
// The server counts faces and records a flag for the professor when nobody, or more than one
// person, is visible. Frames are not stored. Failures are silent: this never interrupts the exam.

export const PRESENCE_INTERVAL_MS = 15000;

export function startPresenceMonitor(sessionId: string, token: string, camera: MediaStream,
  interval = PRESENCE_INTERVAL_MS): () => void {
  const tracks = camera.getVideoTracks();
  if (tracks.length === 0 || typeof document === "undefined") return () => undefined;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream(tracks);
  void video.play().catch(() => undefined);
  const canvas = document.createElement("canvas");
  let stopped = false;
  let busy = false;

  const check = async () => {
    if (stopped || busy || video.videoWidth === 0) return;
    busy = true;
    try {
      const scale = Math.min(1, 480 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.7));
      if (!frame || stopped) return;
      await fetch(`/api/exam/sessions/${encodeURIComponent(sessionId)}/presence`, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", Authorization: `Bearer ${token}` },
        body: frame,
      });
    } catch {
      // The professor simply gets no presence data for this interval.
    } finally {
      busy = false;
    }
  };

  const timer = window.setInterval(() => void check(), interval);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    video.srcObject = null;
  };
}
