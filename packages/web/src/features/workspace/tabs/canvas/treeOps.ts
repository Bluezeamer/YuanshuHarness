// 树里的改动落到服务端：新建（笔记 / 画布 / 文件夹）、挪动与改名、删除、查引用。一个目录一组函数，
// 结果统一成 Done（失败带给用户看的话）。引用的改写（画布节点、笔记里的 [[链接]]）都是服务端做的，这里只发请求。
import {
  createBoard,
  createFolder,
  createNote,
  deleteBoard,
  deleteFolder,
  deleteNote,
  moveBoard,
  moveFolder,
  moveNote,
  readRefs,
} from "../../../../api/canvas";
import { loadToken } from "../../../../api/http";
import { boardId, type MoveOp, type Ref } from "./navTree";
import { type Done, failText } from "./store";

type Result<T> = { ok: true; data: T } | { ok: false; kind: string };

const done = <T>(r: Result<T>): Done<T> =>
  r.ok ? { ok: true, data: r.data } : { ok: false, message: failText(r.kind) };

export interface TreeOps {
  /** 建笔记，返回路径（相对 `.canvas/`，带 `.md`） */
  createNote(path: string): Promise<Done<string>>;
  /** 建画布，返回画布名（可以带文件夹） */
  createBoard(name: string): Promise<Done<string>>;
  createFolder(path: string): Promise<Done<string>>;
  /** 一次挪动 / 改名 */
  move(op: MoveOp): Promise<Done>;
  remove(ref: Ref): Promise<Done>;
  /** 谁引用了它：放着它的画布、`[[…]]` 指向它的笔记（画布传树 id，带 `.canvas`） */
  refs(ref: Ref): Promise<Done<{ boards: string[]; notes: string[] }>>;
}

export function treeOps(env: string, dir: string): TreeOps {
  const token = loadToken;
  return {
    async createNote(path) {
      return done(
        await createNote(token(), env, dir, path).then((r) =>
          r.ok ? { ok: true as const, data: r.data.path } : r,
        ),
      );
    },
    async createBoard(name) {
      return done(
        await createBoard(token(), env, dir, name).then((r) =>
          r.ok ? { ok: true as const, data: r.data.name } : r,
        ),
      );
    },
    async createFolder(path) {
      return done(
        await createFolder(token(), env, dir, path).then((r) =>
          r.ok ? { ok: true as const, data: r.data.path } : r,
        ),
      );
    },
    async move(op) {
      const r =
        op.kind === "folder"
          ? await moveFolder(token(), env, dir, op.from, op.to)
          : op.kind === "board"
            ? await moveBoard(token(), env, dir, op.from, op.to)
            : await moveNote(token(), env, dir, op.from, op.to);
      return r.ok ? { ok: true, data: undefined } : done(r);
    },
    async remove(ref) {
      const r =
        ref.kind === "folder"
          ? await deleteFolder(token(), env, dir, ref.path)
          : ref.kind === "board"
            ? await deleteBoard(token(), env, dir, ref.name)
            : await deleteNote(token(), env, dir, ref.path);
      return r.ok ? { ok: true, data: undefined } : done(r);
    },
    async refs(ref) {
      const path =
        ref.kind === "board"
          ? boardId(ref.name)
          : ref.kind === "note"
            ? ref.path
            : "";
      return done(await readRefs(token(), env, dir, path));
    },
  };
}
