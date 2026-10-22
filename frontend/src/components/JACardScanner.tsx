import { useRef, useState } from "react";

type Props = {
  onSwipe: (eid: string) => void;
  busy?: boolean;
};

export default function JACardScanner({ onSwipe, busy = false }: Props) {
  const [scannedValue, setScannedValue] = useState("");
  const [simulationEid, setSimulationEid] = useState("");
  const scannerInput = useRef<HTMLInputElement>(null);

  function submitScan(value: string) {
    const eid = value.trim();
    if (!eid || busy) return;
    setScannedValue("");
    onSwipe(eid);
  }

  return (
    <section className="jacard-placeholder">
      <div className="card-icon">💳</div>
      <h2>Swipe your JACard</h2>
      <p>
        {busy
          ? "Checking your student record..."
          : "Swipe your card through the reader to begin."}
      </p>

      <button
        type="button"
        disabled={busy}
        onClick={() => scannerInput.current?.focus()}
      >
        {busy ? "Verifying..." : "Activate Card Reader"}
      </button>

      <input
        ref={scannerInput}
        aria-label="JACard reader input"
        autoComplete="off"
        value={scannedValue}
        disabled={busy}
        onChange={(event) => setScannedValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submitScan(scannedValue);
          }
        }}
        placeholder="Card reader input"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          opacity: 0.01,
          overflow: "hidden",
        }}
      />

      <details>
        <summary>Development only: simulate a card swipe</summary>
        <p>
          Use this while a physical card reader is unavailable. Enter a test
          EID already present in the student database.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitScan(simulationEid);
          }}
        >
          <label className="settings-field">
            <span>Test EID</span>
            <input
              value={simulationEid}
              onChange={(event) => setSimulationEid(event.target.value)}
              placeholder="Enter test EID"
              disabled={busy}
              autoComplete="off"
            />
          </label>
          <button type="submit" disabled={busy || !simulationEid.trim()}>
            {busy ? "Verifying..." : "Simulate Swipe"}
          </button>
        </form>
      </details>
    </section>
  );
}
