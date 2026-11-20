import { call } from "./http";

// UI 侧动作的审计上报（ADR-0061）；审计是旁路，调用方不看结果。
export const reportAudit = (
  token: string | null,
  e: {
    sessionId: string | null;
    environmentId?: string | null;
    summary: string;
    detail?: Record<string, unknown>;
  },
) =>
  call(
    "POST",
    "/api/v1/audit/events",
    token,
    { kind: "ui", ...e },
    () => undefined,
  );
