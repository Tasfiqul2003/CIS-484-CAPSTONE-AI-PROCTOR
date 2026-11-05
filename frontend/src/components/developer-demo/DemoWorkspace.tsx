import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { loadDeveloperCapabilities } from "./developerDemo";
import type { DeveloperCapabilities } from "./developerDemo";
import "./developer-demo.css";

const DeveloperContext = createContext<DeveloperCapabilities>({ enabled: false });
export const useDeveloperDemo = () => useContext(DeveloperContext);

export function DemoAttemptNotice() {
  return <aside className="developer-demo-note" aria-label="Developer demo attempt">
    <strong>Developer demo attempt · no grading</strong>
    <p>This saved attempt may contain sample questions, answers or assistance. It cannot receive grades, even after demo mode is turned off.</p>
  </aside>;
}

export function DeveloperDemoProvider({ children }: { children: ReactNode }) {
  const [capabilities, setCapabilities] = useState<DeveloperCapabilities>({ enabled: false });
  useEffect(() => {
    const controller = new AbortController();
    void loadDeveloperCapabilities(controller.signal).then(value => {
      if (!controller.signal.aborted) setCapabilities(value);
    });
    return () => controller.abort();
  }, []);
  return <DeveloperContext.Provider value={capabilities}>
    {capabilities.enabled && <aside className="developer-demo-banner" aria-label="Developer demo workspace">
      <strong>Developer demo workspace</strong>
      <p>New attempts are marked as demos and cannot be graded. Missing optional AI or media can use labeled substitutes. Sign-in and exam access are still required.</p>
      {capabilities.aiAvailable === false && <p>AI model unavailable: sample content is available for new demo attempts.</p>}
    </aside>}
    {children}
  </DeveloperContext.Provider>;
}
