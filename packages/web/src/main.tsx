import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Gate } from "./Gate";
import { Shell } from "./Shell";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("缺少 #root");

createRoot(root).render(
  <StrictMode>
    <Gate>
      {(sessions, onUnauthorized) => (
        <Shell sessions={sessions} onUnauthorized={onUnauthorized} />
      )}
    </Gate>
  </StrictMode>,
);
