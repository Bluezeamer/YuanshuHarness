import { createContext } from "react";
import type { SessionInfo } from "../api";
import type { SessionHub } from "../sessions/hub";

export interface WorkbenchEnv {
  hub: SessionHub;
  sessions: SessionInfo[];
}

export const EnvContext = createContext<WorkbenchEnv | null>(null);
