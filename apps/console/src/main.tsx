import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <main style={{ fontFamily: "monospace", padding: 24 }}>Penstock console (built in task 7)</main>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
