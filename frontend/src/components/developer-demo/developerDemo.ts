export type DeveloperCapabilities = { enabled: boolean; aiAvailable?: boolean };

const disabled: DeveloperCapabilities = { enabled: false };

export async function loadDeveloperCapabilities(signal?: AbortSignal): Promise<DeveloperCapabilities> {
  try {
    const response = await fetch("/api/developer/capabilities", { signal, cache: "no-store" });
    if (!response.ok) return disabled;
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("enabled" in value) || value.enabled !== true) return disabled;
    return { enabled: true, ...("ai_available" in value && typeof value.ai_available === "boolean"
      ? { aiAvailable: value.ai_available } : {}) };
  } catch {
    // Older or unavailable backends must not enable demo controls in the browser.
    return disabled;
  }
}

export const demoAnswer = "[Developer demo answer — typed sample, not a recording] One idea I learned can be explained with a simple example. I would check the example against the course materials.";

export type SummaryPreview = { id: string; filename: string; extracted_text: string; summary?: string | null; demo?: boolean };

/** A transient demo summary belongs only to the matching preview, never the saved material. */
export function withTransientSummary(preview: SummaryPreview, result: unknown): SummaryPreview {
  if (result && typeof result === "object" && "id" in result && result.id === preview.id &&
      "demo" in result && result.demo === true && "persisted" in result && result.persisted === false &&
      "summary" in result && typeof result.summary === "string") {
    return { ...preview, summary: result.summary, demo: true };
  }
  return preview;
}
