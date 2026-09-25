import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Could not find the root element.");
}

try {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
} catch (error) {
  console.error("React failed to render:", error);

  rootElement.innerHTML = `
    <div style="font-family: Arial; padding: 40px;">
      <h1>React Error</h1>
      <pre>${String(error)}</pre>
    </div>
  `;
}
