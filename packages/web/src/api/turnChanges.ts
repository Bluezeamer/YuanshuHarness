// 轮次改动清单与单个文件的 diff。
import { call, enc, type RawFailure, raw } from "./http";

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  added: number;
  removed: number;
}

export interface StoredTurn {
  turn: number;
  mode: "git" | "files";
  total: number;
  createdAt: string;
  /** 这一轮最后一条助手消息的 ts：卡片按它挂到对应消息下面 */
  anchorTs: string | null;
  files: FileChange[];
}

export const listTurnChanges = (token: string | null, sessionId: string) =>
  call(
    "GET",
    `/api/v1/sessions/${enc(sessionId)}/turn-changes`,
    token,
    undefined,
    (b: { turns: StoredTurn[] }) => b.turns ?? [],
  );

/** diff 不可用（副本被清掉）时返回 410，调用方只显示清单。 */
export const readTurnDiff = (
  token: string | null,
  sessionId: string,
  turn: number,
  path: string,
): Promise<{ ok: true; data: string } | { ok: false; kind: RawFailure }> =>
  raw(
    `/api/v1/sessions/${enc(sessionId)}/turn-changes/${turn}/diff?path=${enc(path)}`,
    {},
    token,
    async (res) => ((await res.json()) as { diff?: string }).diff ?? "",
  );
