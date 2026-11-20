// 一轮改动追踪：算出「这一轮 agent 到底改了哪些文件」，并保留能算 diff 的两侧内容。
//
// 两条轨道（参照 dsh 的做法）：
// 1. git 仓库：轮初与轮末各用**独立临时索引**写一棵 tree（不碰用户的 index、不动工作树），
//    两棵 tree 一 diff 就得到本轮改动。这样连 bash 改的文件也能覆盖，且不受「进来时就已经脏」影响。
// 2. 非 git 目录：只能覆盖 write/edit 这类有工具事件的写入——工具调用前先留一份旧内容，
//    轮末与当前内容比对。bash/脚本改的看不到（已确认可接受）。
//
// 存储：旧/新内容副本落在数据目录下的轮次子目录里，不进数据库；数据库只存清单
// （路径/状态/增删行数）。复制件被清掉时只能显示清单，diff 标记为不可用。
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ExecEnv } from "../env/types.js";

export type ChangeStatus = "added" | "modified" | "deleted";

export interface FileChange {
  path: string;
  status: ChangeStatus;
  added: number;
  removed: number;
}

export interface TurnChangeSet {
  mode: "git" | "files";
  files: FileChange[];
  /** 文件太多时截断，total 仍是完整数量 */
  total: number;
}

/** 单个文件的内容上限：再大就不留副本、不提供对比。 */
export const FILE_CONTENT_MAX = 2 * 1024 * 1024;
/** 一轮最多记录多少个文件。 */
export const CHANGES_MAX = 500;

const sha = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 32);

interface TurnMeta {
  mode: "git" | "files";
  root: string;
  /** git 模式：轮初/轮末的 tree 对象名 */
  before?: string;
  after?: string;
  /** files 模式：被工具写过的路径（相对 root） */
  touched?: string[];
}

export class ChangeTracker {
  constructor(
    private readonly opts: {
      /** 轮次副本的根目录（数据目录下，按会话/轮次分子目录） */
      dir: string;
      git?: string;
      timeoutMs?: number;
    },
  ) {}

  private turnDir(key: string): string {
    return path.join(this.opts.dir, key);
  }

  private run(env: ExecEnv, cwd: string, command: string) {
    const out: Buffer[] = [];
    return env
      .exec(command, cwd, {
        onData: (d) => {
          if (out.length < 64) out.push(d);
        },
        timeout: Math.round((this.opts.timeoutMs ?? 10_000) / 1000),
      })
      .then((r) => ({
        code: r.exitCode,
        out: Buffer.concat(out).toString("utf8"),
      }));
  }

  /** git 是否可用且 root 是仓库根（或仓库内）。 */
  private async gitOk(env: ExecEnv, root: string): Promise<boolean> {
    const g = this.opts.git ?? "git";
    const r = await this.run(env, root, `${g} rev-parse --show-toplevel`).catch(
      () => null,
    );
    if (!r || r.code !== 0) return false;
    // 只在仓库根上做快照：子目录跑 add -A 会漏掉上层改动，容易误判
    return r.out.trim() === root.replace(/\/+$/, "");
  }

  /** 用临时索引导出一棵 tree，返回 tree 对象名；失败返回 null。 */
  private async snapshot(
    env: ExecEnv,
    root: string,
    key: string,
    tag: string,
  ): Promise<string | null> {
    const g = this.opts.git ?? "git";
    const idx = path.join(this.turnDir(key), `${tag}.index`);
    mkdirSync(this.turnDir(key), { recursive: true });
    const envs = `GIT_INDEX_FILE=${q(idx)}`;
    // 从 HEAD 起步（没有 HEAD 的新仓库就空索引），再 add -A 得到完整快照
    const hasHead = await this.run(
      env,
      root,
      `${envs} ${g} rev-parse --verify HEAD >/dev/null 2>&1 && echo yes || echo no`,
    ).catch(() => null);
    if (hasHead?.out.trim() === "yes")
      await this.run(env, root, `${envs} ${g} read-tree HEAD`);
    else await this.run(env, root, `${envs} ${g} read-tree --empty`);
    const add = await this.run(
      env,
      root,
      `${envs} ${g} add -A -- . 2>/dev/null || true`,
    ).catch(() => null);
    if (add === null) return null;
    const tree = await this.run(env, root, `${envs} ${g} write-tree`);
    return tree.code === 0 ? tree.out.trim() : null;
  }

  /** 轮次开始：记下基线快照 / 初始化副本目录。 */
  async begin(key: string, env: ExecEnv, root: string): Promise<void> {
    mkdirSync(path.join(this.turnDir(key), "pre"), { recursive: true });
    const git = await this.gitOk(env, root).catch(() => false);
    const meta: TurnMeta = { mode: git ? "git" : "files", root };
    if (git) {
      const before = await this.snapshot(env, root, key, "before");
      if (before) meta.before = before;
      else meta.mode = "files";
    }
    if (meta.mode === "files") meta.touched = [];
    writeFileSync(
      path.join(this.turnDir(key), "meta.json"),
      JSON.stringify(meta),
    );
  }

  private readMeta(key: string): TurnMeta | null {
    const p = path.join(this.turnDir(key), "meta.json");
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as TurnMeta;
    } catch {
      return null;
    }
  }

  // 同一个键的写入记录排队做：团队里几个成员同时写文件时，meta.json 的读改写不能互相覆盖。
  private readonly pending = new Map<string, Promise<void>>();

  /** 工具写入前留一份旧内容（只在非 git 模式下用；git 模式靠快照）。 */
  noteWrite(
    key: string,
    env: ExecEnv,
    root: string,
    absPath: string,
  ): Promise<void> {
    const next = (this.pending.get(key) ?? Promise.resolve()).then(() =>
      this.recordWrite(key, env, root, absPath),
    );
    // 一次失败不能卡住后面的
    const tail = next.catch(() => {});
    this.pending.set(key, tail);
    void tail.then(() => {
      if (this.pending.get(key) === tail) this.pending.delete(key);
    });
    return next;
  }

  /** 丢弃某个键的全部记录（团队解散、重新建队时） */
  forget(key: string): void {
    rmSync(this.turnDir(key), { recursive: true, force: true });
  }

  private async recordWrite(
    key: string,
    env: ExecEnv,
    root: string,
    absPath: string,
  ): Promise<void> {
    const meta = this.readMeta(key);
    if (!meta || meta.mode !== "files") return;
    const rel = relOf(root, absPath);
    if (rel === null) return;
    if (meta.touched?.includes(rel)) return;
    const dir = path.join(this.turnDir(key), "pre");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, sha(rel));
    try {
      const st = await env.stat(absPath);
      if (st && st.isFile && st.size <= FILE_CONTENT_MAX)
        writeFileSync(file, await env.readFile(absPath));
      else writeFileSync(file, ""); // 空文件等价「原本不存在」
      if (meta.touched) meta.touched.push(rel);
      writeFileSync(
        path.join(this.turnDir(key), "meta.json"),
        JSON.stringify(meta),
      );
    } catch {
      // 读不到就按「原本不存在」处理，别因为一次 IO 失败漏记整轮
      if (meta.touched) meta.touched.push(rel);
      writeFileSync(
        path.join(this.turnDir(key), "meta.json"),
        JSON.stringify(meta),
      );
    }
  }

  /** 轮次结束：算出改动清单。 */
  async finish(key: string, env: ExecEnv): Promise<TurnChangeSet> {
    await this.pending.get(key);
    const meta = this.readMeta(key);
    if (!meta) return { mode: "files", files: [], total: 0 };
    if (meta.mode === "git" && meta.before) {
      const after = await this.snapshot(env, meta.root, key, "after");
      if (after) {
        meta.after = after;
        writeFileSync(
          path.join(this.turnDir(key), "meta.json"),
          JSON.stringify(meta),
        );
        const files = await this.gitChanges(env, meta);
        return {
          mode: "git",
          files: files.slice(0, CHANGES_MAX),
          total: files.length,
        };
      }
    }
    const files = await this.fileChanges(key, env, meta);
    return {
      mode: "files",
      files: files.slice(0, CHANGES_MAX),
      total: files.length,
    };
  }

  /** git diff 两棵树：状态与增删行数分两条命令取，避免两种格式混排解析出错。 */
  private async gitChanges(
    env: ExecEnv,
    meta: TurnMeta,
  ): Promise<FileChange[]> {
    // quotepath=off：中文文件名按原样输出，不然是带引号的八进制转义，既显示成乱码也取不到 diff。
    const g = `${this.opts.git ?? "git"} -c core.quotepath=off`;
    const range = `${meta.before} ${meta.after}`;
    const names = await this.run(
      env,
      meta.root,
      `${g} diff --name-status ${range}`,
    ).catch(() => null);
    const nums = await this.run(
      env,
      meta.root,
      `${g} diff --numstat ${range}`,
    ).catch(() => null);
    if (!names || names.code !== 0) return [];

    const counts = new Map<string, { added: number; removed: number }>();
    for (const line of nums?.out.split("\n") ?? []) {
      if (line === "") continue;
      const cols = line.split("\t");
      if (cols.length < 3) continue;
      // 二进制文件给 "-"：不计行数
      const added = cols[0] === "-" ? 0 : Number(cols[0]);
      const removed = cols[1] === "-" ? 0 : Number(cols[1]);
      counts.set(cols[2] ?? "", {
        added: Number.isFinite(added) ? added : 0,
        removed: Number.isFinite(removed) ? removed : 0,
      });
    }

    const files: FileChange[] = [];
    for (const line of names.out.split("\n")) {
      if (line === "") continue;
      const cols = line.split("\t");
      const code = (cols[0] ?? "")[0];
      // 改名取最后一个字段（新路径）；够用，不必展开 rename 语义
      const p = cols[cols.length - 1] ?? "";
      if (!p) continue;
      const n = counts.get(p) ?? { added: 0, removed: 0 };
      files.push({
        path: p,
        status: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
        added: n.added,
        removed: n.removed,
      });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    return files;
  }

  /** 非 git：按留存的旧内容与当前内容比对。 */
  private async fileChanges(
    key: string,
    env: ExecEnv,
    meta: TurnMeta,
  ): Promise<FileChange[]> {
    const out: FileChange[] = [];
    for (const rel of meta.touched ?? []) {
      const abs = path.join(meta.root, rel);
      const pre = path.join(this.turnDir(key), "pre", sha(rel));
      const before = existsSync(pre) ? readFileSync(pre, "utf8") : "";
      const st = await env.stat(abs).catch(() => null);
      if (!st || !st.isFile) {
        if (before !== "")
          out.push({
            path: rel,
            status: "deleted",
            added: 0,
            removed: countLines(before),
          });
        continue;
      }
      if (st.size > FILE_CONTENT_MAX) continue; // 太大不留副本，也不报改动
      const after = (await env.readFile(abs)).toString("utf8");
      // 存一份新内容，供之后算 diff（工作树后面还会变）
      const post = path.join(this.turnDir(key), "post", sha(rel));
      mkdirSync(path.dirname(post), { recursive: true });
      writeFileSync(post, after);
      if (after === before) continue;
      const { added, removed } = lineStat(before, after);
      out.push({
        path: rel,
        status: before === "" ? "added" : "modified",
        added,
        removed,
      });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : 1));
    return out;
  }

  /**
   * 取某个文件的 diff 文本。git 模式直接问 git；files 模式用留存的副本自己拼。
   * 内容已不可用时返回 null（前端只显示清单）。
   */
  async diff(key: string, env: ExecEnv, rel: string): Promise<string | null> {
    const meta = this.readMeta(key);
    if (!meta) return null;
    if (meta.mode === "git" && meta.before && meta.after) {
      const g = `${this.opts.git ?? "git"} -c core.quotepath=off`;
      const r = await this.run(
        env,
        meta.root,
        `${g} diff --no-color --unified=3 ${meta.before} ${meta.after} -- ${q(rel)}`,
      ).catch(() => null);
      return r && r.code === 0 ? r.out : null;
    }
    const pre = path.join(this.turnDir(key), "pre", sha(rel));
    const post = path.join(this.turnDir(key), "post", sha(rel));
    if (!existsSync(pre) && !existsSync(post)) return null;
    const before = existsSync(pre) ? readFileSync(pre, "utf8") : "";
    const after = existsSync(post) ? readFileSync(post, "utf8") : "";
    return unified(rel, before, after);
  }
}

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const countLines = (s: string) =>
  s === "" ? 0 : s.replace(/\n$/, "").split("\n").length;

/** 相对仓库根；给出 root 之外的路径就返回 null。 */
export function relOf(root: string, abs: string): string | null {
  const r = root.replace(/\/+$/, "");
  if (!abs.startsWith(`${r}/`)) return null;
  return abs.slice(r.length + 1);
}

/** 行的增删统计：用 LCS 求最长公共子序列，行数不多时够用。 */
export function lineStat(
  before: string,
  after: string,
): { added: number; removed: number } {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  let same = 0;
  // 超过 4000 行不做精确比对，直接按整份替换计
  if (a.length > 4000 || b.length > 4000)
    return { added: b.length, removed: a.length };
  const n = a.length;
  const m = b.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => table[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * (m + 1) + j] =
        a[i] === b[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
  same = at(0, 0);
  return { added: m - same, removed: n - same };
}

/** 拼一份够看的 unified diff（非 git 模式用）。 */
export function unified(rel: string, before: string, after: string): string {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const head = `--- a/${rel}\n+++ b/${rel}\n`;
  const hunk = `@@ -1,${a.length} +1,${b.length} @@\n`;
  if (a.length > 4000 || b.length > 4000) {
    return `${head}${hunk}${a.map((l) => `-${l}`).join("\n")}\n${b.map((l) => `+${l}`).join("\n")}\n`;
  }
  const n = a.length;
  const m = b.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => table[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * (m + 1) + j] =
        a[i] === b[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      lines.push(`-${a[i]}`);
      i++;
    } else {
      lines.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) lines.push(`-${a[i++]}`);
  while (j < m) lines.push(`+${b[j++]}`);
  return `${head}${hunk}${lines.join("\n")}\n`;
}
