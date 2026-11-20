import { type CallResult, call, enc, openSocket } from "./http";

export interface TerminalInfo {
  id: string;
  environmentId: string;
  cwd: string;
  cols: number;
  rows: number;
  /** 归属的工作区；不是从工作区页创建时为 null */
  workspaceId: string | null;
}

// 列表与详情的单项：创建信息加上随时变化的运行状态（对应服务端 Terminal.status()）。
export interface TerminalStatus extends TerminalInfo {
  createdAt: string;
  attached: number;
  /** pty 读取是否被流控暂停（不影响 shell 存活）。 */
  paused: boolean;
  /** 前台是否有 shell 之外的进程；ssh 环境无法判断为 null。 */
  busy: boolean | null;
}

export const listTerminals = (token: string | null) =>
  call(
    "GET",
    "/api/v1/terminals",
    token,
    undefined,
    (b: { terminals: TerminalStatus[] }) => {
      if (!Array.isArray(b.terminals)) throw new Error("shape");
      return b.terminals;
    },
  );

// 不存在时得到 not_found：终端接回与关闭确认都靠它判断“还在不在”。
export const getTerminal = (token: string | null, id: string) =>
  call(
    "GET",
    `/api/v1/terminals/${enc(id)}`,
    token,
    undefined,
    (b: TerminalStatus) => b,
  );

export const createTerminal = (
  token: string | null,
  body: {
    environmentId: string;
    cwd?: string;
    cols: number;
    rows: number;
    sessionId?: string;
    workspaceId?: string;
  },
): Promise<CallResult<TerminalInfo>> =>
  call("POST", "/api/v1/terminals", token, body, (b: TerminalInfo) => b);

export const closeTerminal = (token: string | null, id: string) =>
  call(
    "DELETE",
    `/api/v1/terminals/${enc(id)}`,
    token,
    undefined,
    () => undefined,
  );

export const openTerminalSocket = (
  id: string,
  token: string | null,
): WebSocket => openSocket(`/api/v1/terminals/${enc(id)}/stream`, token);
