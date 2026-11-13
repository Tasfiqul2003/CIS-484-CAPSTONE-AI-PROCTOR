import { useState } from "react";

type Props = {
  onSwipe: (eid: string) => void;
  busy?: boolean;
};

export default function JACardScanner({ onSwipe, busy = false }: Props) {
  const [scannedValue, setScannedValue] = useState("");

  function submitScan(value: string) {
    const eid = value.trim();
    if (!eid || busy) return;
    setScannedValue("");
    onSwipe(eid);
  }

  return (
    <section
      className="jacard-placeholder"
      aria-labelledby="jacard-prompt"
      aria-busy={busy}
    >
      <h2 id="jacard-prompt">Swipe your JACard</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitScan(scannedValue);
        }}
      >
        <label htmlFor="jacard-eid">JACard or JMU EID</label>
        <p id="jacard-help">Swipe while this field is focused, or type your EID.</p>
        <input
          id="jacard-eid"
          aria-describedby="jacard-help"
          autoComplete="off"
          value={scannedValue}
          disabled={busy}
          onChange={(event) => setScannedValue(event.target.value)}
          placeholder="Enter EID"
        />
        <button type="submit" disabled={busy || !scannedValue.trim()}>
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>
      {busy && <p role="status" aria-live="polite">Checking your student record…</p>}
    </section>
  );
}
