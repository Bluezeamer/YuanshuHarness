import { type Failure, failure, sendJson } from "./http";

export interface Workbench {
  revision: number;
  document: unknown | null;
}

export type PutResult =
  | { ok: true; revision: number }
  | { ok: false; kind: "conflict"; current: Workbench }
  | ({ ok: false } & Failure);

// 工作区布局的写入；409 带回当前文档，所以不走通用的 get。pagehide 期间走 keepalive。
export async function putDocument(
  path: string,
  token: string | null,
  baseRevision: number,
  document: unknown,
  keepalive = false,
): Promise<PutResult> {
  const res = await sendJson(
    "PUT",
    path,
    token,
    { baseRevision, document },
    keepalive,
  );
  if (!res) return { ok: false, kind: "network" };
  try {
    if (res.status === 409) {
      const b = (await res.json()) as Workbench;
      return {
        ok: false,
        kind: "conflict",
        current: { revision: b.revision, document: b.document ?? null },
      };
    }
    if (!res.ok) return { ok: false, ...failure(res) };
    const b = (await res.json()) as { revision: number };
    if (typeof b.revision !== "number") return { ok: false, kind: "server" };
    return { ok: true, revision: b.revision };
  } catch {
    return { ok: false, kind: "server" };
  }
}
