import { call, enc, type RawFailure, raw } from "./http";
import type { FileChange } from "./turnChanges";

// 对话标签右侧状态「团队」块里公告板与团队改动两行的数据；名册走 flows。形状对应服务端 api/team.ts。

export interface BoardEntry {
  no: number;
  time: string;
  from: string;
  to: string;
  text: string;
}

export interface TeamView {
  board: {
    /** 公告板文件（Server 本机的路径） */
    file: string;
    count: number;
    /** 最近几条，旧的在前 */
    recent: BoardEntry[];
  };
  /** 建队以来改动的文件；取不到（目录不可用、没开改动追踪）为 null */
  changes: {
    mode: "git" | "files";
    files: FileChange[];
    /** 文件太多时 files 被截断，total 仍是完整数量 */
    total: number;
  } | null;
}

export const getTeam = (token: string | null, sessionId: string) =>
  call(
    "GET",
    `/api/v1/sessions/${enc(sessionId)}/team`,
    token,
    undefined,
    (b: Partial<TeamView>) => {
      if (!b.board || !Array.isArray(b.board.recent)) throw new Error("shape");
      return { board: b.board, changes: b.changes ?? null } satisfies TeamView;
    },
  );

/** 某个文件建队以来的 diff；没有改动返回 410。 */
export const readTeamDiff = (
  token: string | null,
  sessionId: string,
  path: string,
): Promise<{ ok: true; data: string } | { ok: false; kind: RawFailure }> =>
  raw(
    `/api/v1/sessions/${enc(sessionId)}/team/diff?path=${enc(path)}`,
    {},
    token,
    async (res) => ((await res.json()) as { diff?: string }).diff ?? "",
  );
