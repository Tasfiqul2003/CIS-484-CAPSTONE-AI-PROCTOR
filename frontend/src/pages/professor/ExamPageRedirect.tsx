import { useEffect } from "react";

/** Keep saved links useful after consolidating the exam editors. */
export default function ExamPageRedirect({ to }: { to: string }) {
  useEffect(() => { window.location.replace(to); }, [to]);
  return <p role="status">Opening exam page…</p>;
}
