// 文件标签测试夹具：内存文件系统 + api/files 的替身。只被 *.test.tsx 引用。
// 用法：vi.mock("<相对路径>/api/files", async () => (await import("./testkit")).fakeFilesApi)。
// 另有 fakeGitApi：mock api/git 时用 {...实际模块, ...fakeGitApi} 覆盖取数部分，保住 statusByPath 等纯函数。
import type {
  FileEntry,
  FileListing,
  TransferJob,
  TransferRequest,
} from "../../../../api/files";
import type { GitStatusEntry } from "../../../../api/git";
import type { CallFailure } from "../../../../api/http";

type Node = { type: "dir" } | { type: "file"; size: number };
type Res<T> = { ok: true; data: T } | ({ ok: false } & CallFailure);

const ok = <T>(data: T): Res<T> => ({ ok: true, data });
const bad = (kind: CallFailure["kind"]): Res<never> =>
  ({ ok: false, kind }) as Res<never>;

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? "/";
const parent = (p: string) => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};
const join = (d: string, n: string) => (d === "/" ? `/${n}` : `${d}/${n}`);

const TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  ts: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};
const typeOfPath = (p: string) =>
  TYPES[p.split(".").pop() ?? ""] ?? "application/octet-stream";

export class World {
  fs = new Map<string, Map<string, Node>>();
  /** 记录所有调用，供断言「没有多余请求」 */
  calls: string[] = [];
  /** 给某个目录的列表请求注入失败：key = `${env}:${path}` */
  listFail = new Map<string, CallFailure["kind"]>();
  /** 挂起列表请求直到 release() 被调用 */
  listGate: Promise<void> | null = null;
  jobs = new Map<string, TransferJob>();
  /** 控制传输任务是否自动完成；false 时由测试用 finishJob / progress 推进 */
  autoFinish = false;
  startFail: CallFailure["kind"] | null = null;
  private seq = 0;
  /** 文件内容（预览用）：key = `${env}:${path}` */
  contents = new Map<string, { type: string; bytes: Uint8Array }>();
  /** 挂起预览读取直到 release */
  readGate: Promise<void> | null = null;
  /** 下一次 saveTextFile 是否返回冲突（用完自动清掉） */
  saveConflict = false;
  /** 挂起上传请求直到测试放行（验「上传中」的可见状态） */
  uploadGate: Promise<void> | null = null;
  /** 同时在飞的上传请求数（验并发度，串行实现恒为 1） */
  uploading = 0;
  /** 给某个路径的建目录注入失败：key = `${env}:${path}` */
  mkdirFail = new Map<
    string,
    "unauthorized" | "forbidden" | "not_found" | "network" | "server"
  >();
  /** 给某个路径的上传注入失败：key = `${env}:${path}` */
  uploadFail = new Map<
    string,
    "unauthorized" | "forbidden" | "not_found" | "network" | "server"
  >();
  /** 给某个文件的读取注入失败：key = `${env}:${path}` */
  readFail = new Map<
    string,
    "unauthorized" | "forbidden" | "not_found" | "network" | "server"
  >();

  reset(): void {
    this.contents.clear();
    this.readGate = null;
    this.readFail.clear();
    this.uploadFail.clear();
    this.uploadGate = null;
    this.mkdirFail.clear();
    this.fs.clear();
    this.calls = [];
    this.listFail.clear();
    this.listGate = null;
    this.jobs.clear();
    this.autoFinish = false;
    this.startFail = null;
    this.seq = 0;
  }

  /** tree：路径 → 文件大小；值为 null 表示目录。父目录自动补齐 */
  seed(env: string, tree: Record<string, number | null>): void {
    const m = this.fs.get(env) ?? new Map<string, Node>();
    this.fs.set(env, m);
    m.set("/", { type: "dir" });
    for (const [p, size] of Object.entries(tree)) {
      for (let d = parent(p); d !== "/"; d = parent(d))
        if (!m.has(d)) m.set(d, { type: "dir" });
      m.set(p, size === null ? { type: "dir" } : { type: "file", size });
    }
  }

  /** 放一个有内容的文件（同时进文件树）；type 缺省按扩展名猜，与服务端的映射一致 */
  put(
    env: string,
    path: string,
    content: string | Uint8Array,
    type?: string,
  ): void {
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.seed(env, { [path]: bytes.length });
    this.contents.set(`${env}:${path}`, {
      type: type ?? typeOfPath(path),
      bytes,
    });
  }

  has(env: string, path: string): boolean {
    return this.fs.get(env)?.has(path) ?? false;
  }

  /** 某目录下的直接子项名（排序） */
  names(env: string, dir: string): string[] {
    return [...(this.fs.get(env)?.keys() ?? [])]
      .filter((p) => p !== "/" && parent(p) === dir)
      .map(base)
      .sort();
  }

  node(env: string, path: string): Node | undefined {
    return this.fs.get(env)?.get(path);
  }

  private under(env: string, root: string): string[] {
    return [...(this.fs.get(env)?.keys() ?? [])].filter(
      (p) => p === root || p.startsWith(`${root}/`),
    );
  }

  list(env: string, path: string, hidden: boolean): Res<FileListing> {
    const m = this.fs.get(env);
    const fail = this.listFail.get(`${env}:${path}`);
    if (fail) return bad(fail);
    if (m?.get(path)?.type !== "dir") return bad("not_found");
    const entries: FileEntry[] = this.names(env, path)
      .filter((n) => hidden || !n.startsWith("."))
      .map((name) => {
        const n = m.get(join(path, name)) as Node;
        return {
          name,
          type: n.type,
          size: n.type === "file" ? n.size : 0,
          mtimeMs: Date.UTC(2020, 0, 2, 3, 4),
        };
      })
      .sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir"));
    return ok({
      path,
      parent: path === "/" ? null : parent(path),
      entries,
      truncated: false,
    });
  }

  mkdir(env: string, path: string): Res<{ path: string }> {
    const m = this.fs.get(env);
    if (!m) return bad("not_found");
    if (m.has(path)) return bad("conflict");
    m.set(path, { type: "dir" });
    return ok({ path });
  }

  remove(env: string, path: string, recursive: boolean): Res<undefined> {
    const m = this.fs.get(env);
    const n = m?.get(path);
    if (!m || !n) return bad("not_found");
    const inside = this.under(env, path);
    if (n.type === "dir" && inside.length > 1 && !recursive)
      return bad("bad_request");
    for (const p of inside) m.delete(p);
    return ok(undefined);
  }

  rename(env: string, from: string, to: string): Res<undefined> {
    const m = this.fs.get(env);
    if (!m?.has(from)) return bad("not_found");
    if (m.has(to)) return bad("conflict");
    for (const p of this.under(env, from)) {
      const n = m.get(p) as Node;
      m.delete(p);
      m.set(to + p.slice(from.length), n);
    }
    return ok(undefined);
  }

  /** 写文件（上传）：父目录必须存在；目标已存在时只有 overwrite 才写得进去 */
  upload(
    env: string,
    path: string,
    size: number,
    overwrite: boolean,
  ): Res<undefined> {
    const m = this.fs.get(env);
    if (!m) return bad("not_found");
    if (m.get(parent(path))?.type !== "dir") return bad("not_found");
    const cur = m.get(path);
    if (cur?.type === "dir") return bad("conflict");
    if (cur && !overwrite) return bad("conflict");
    m.set(path, { type: "file", size });
    return ok(undefined);
  }

  /** 复制 from 到 to（to 为最终路径；目标已存在的文件不覆盖，按冲突失败） */
  copy(req: TransferRequest): TransferJob {
    const { from, to } = req;
    const src = this.fs.get(from.env);
    const dst = this.fs.get(to.env) ?? new Map<string, Node>();
    this.fs.set(to.env, dst);
    const items = this.under(from.env, from.path);
    const files = items.filter((p) => src?.get(p)?.type === "file");
    const sizeOf = (p: string) => {
      const n = src?.get(p);
      return n?.type === "file" ? n.size : 0;
    };
    const bytes = files.reduce((n, p) => n + sizeOf(p), 0);
    const job: TransferJob = {
      id: `job${++this.seq}`,
      state: "running",
      from,
      to,
      startedAt: "2026-01-01T00:00:00Z",
      totalFiles: files.length,
      totalBytes: bytes,
      files: 0,
      bytes: 0,
    };
    this.jobs.set(job.id, job);
    this.pending.set(job.id, () => {
      const clash = items.find(
        (p) =>
          dst.has(to.path + p.slice(from.path.length)) &&
          src?.get(p)?.type === "file",
      );
      if (clash) {
        job.state = "failed";
        job.error = { code: "conflict", message: "目标已存在" };
        return;
      }
      for (const p of items) {
        const target = to.path + p.slice(from.path.length);
        if (!dst.has(target)) dst.set(target, src?.get(p) as Node);
      }
      for (let d = parent(to.path); d !== "/"; d = parent(d))
        if (!dst.has(d)) dst.set(d, { type: "dir" });
      job.state = "done";
      job.files = files.length;
      job.bytes = bytes;
    });
    if (this.autoFinish) this.finishJob(job.id);
    return job;
  }

  private pending = new Map<string, () => void>();

  /** 让任务落盘并转为 done（冲突时转 failed） */
  finishJob(id: string): void {
    this.pending.get(id)?.();
    this.pending.delete(id);
  }

  /** 推进到一半：不落盘 */
  progress(id: string, files: number, bytes: number): void {
    const j = this.jobs.get(id);
    if (j) Object.assign(j, { files, bytes });
  }

  lastJob(): TransferJob | undefined {
    return [...this.jobs.values()].at(-1);
  }
}

export const world = new World();

/** 版本视图的假 git 仓库：一台主机一份，测试按需摆成「在仓库里 / 有改动」 */
export const gitWorld = {
  root: null as string | null,
  branch: null as string | null,
  detached: false,
  entries: [] as GitStatusEntry[],
  locals: [] as string[],
  calls: [] as string[],

  reset(): void {
    this.root = null;
    this.branch = null;
    this.detached = false;
    this.entries = [];
    this.locals = [];
    this.calls = [];
  },

  /** 摆成一个仓库：/w 在 master 上，带若干改动 */
  seedRepo(tree: {
    root?: string;
    branch?: string;
    locals?: string[];
    entries?: GitStatusEntry[];
  }): void {
    this.root = tree.root ?? "/w";
    this.branch = tree.branch ?? "master";
    this.detached = false;
    this.locals = tree.locals ?? [this.branch];
    this.entries = tree.entries ?? [];
  },
};

export const fakeGitApi = {
  gitStatus: async (_t: string | null, env: string, path: string) => {
    gitWorld.calls.push(`status ${env} ${path}`);
    return {
      ok: true as const,
      data: {
        root: gitWorld.root,
        branch: gitWorld.branch,
        detached: gitWorld.detached,
        entries: gitWorld.entries,
        truncated: false,
      },
    };
  },
  gitBranches: async (_t: string | null, env: string, path: string) => {
    gitWorld.calls.push(`branches ${env} ${path}`);
    return {
      ok: true as const,
      data: {
        root: gitWorld.root,
        current: gitWorld.detached ? null : gitWorld.branch,
        detached: gitWorld.detached,
        locals: gitWorld.locals,
      },
    };
  },
  // 与服务端一致：目录脏时 abort 一律被拒，stash / carry 才真的切过去
  gitCheckout: async (
    _t: string | null,
    env: string,
    path: string,
    branch: string,
    dirty: string,
  ) => {
    gitWorld.calls.push(`checkout ${env} ${path} ${branch} ${dirty}`);
    if (dirty === "abort" && gitWorld.entries.length > 0)
      return {
        ok: false as const,
        dirty: true as const,
        message: "工作区有未提交的改动",
      };
    gitWorld.branch = branch;
    return {
      ok: true as const,
      data: { root: gitWorld.root ?? "", branch },
    };
  },
};

export const fakeFilesApi = {
  // HTML 预览的 iframe 直接拼内容端点，用的就是这个前缀
  filesBase: (env: string) =>
    `/api/v1/environments/${encodeURIComponent(env)}/files`,
  listFiles: async (
    _t: string | null,
    env: string,
    path: string,
    hidden: boolean,
  ) => {
    world.calls.push(`list ${env} ${path}${hidden ? " hidden" : ""}`);
    if (world.listGate) await world.listGate;
    return world.list(env, path, hidden);
  },
  makeDir: async (_t: string | null, env: string, path: string) => {
    world.calls.push(`mkdir ${env} ${path}`);
    const fail = world.mkdirFail.get(`${env}:${path}`);
    if (fail) return bad(fail);
    return world.mkdir(env, path);
  },
  removeEntry: async (
    _t: string | null,
    env: string,
    path: string,
    recursive: boolean,
    sessionId: string | null,
  ) => {
    world.calls.push(
      `remove ${env} ${path}${recursive ? " -r" : ""} sid=${sessionId}`,
    );
    return world.remove(env, path, recursive);
  },
  renameEntry: async (
    _t: string | null,
    env: string,
    from: string,
    to: string,
    sessionId: string | null,
  ) => {
    world.calls.push(`rename ${env} ${from} ${to} sid=${sessionId}`);
    return world.rename(env, from, to);
  },
  startTransferJob: async (_t: string | null, req: TransferRequest) => {
    world.calls.push(
      `transfer ${req.from.env}:${req.from.path} ${req.to.env}:${req.to.path} sid=${req.sessionId}`,
    );
    if (world.startFail) return bad(world.startFail);
    return ok({ ...world.copy(req) });
  },
  getTransferJob: async (_t: string | null, id: string) => {
    const j = world.jobs.get(id);
    return j ? ok({ ...j }) : bad("not_found");
  },
  cancelTransferJob: async (_t: string | null, id: string) => {
    world.calls.push(`cancel ${id}`);
    const j = world.jobs.get(id);
    if (!j) return bad("not_found");
    if (j.state === "running") j.state = "cancelled";
    return ok({ ...j });
  },
  readPreview: async (
    _t: string | null,
    env: string,
    path: string,
    limit: number,
  ) => {
    world.calls.push(`preview ${env} ${path}`);
    if (world.readGate) await world.readGate;
    const fail = world.readFail.get(`${env}:${path}`);
    if (fail) return { ok: false as const, kind: fail };
    const f = world.contents.get(`${env}:${path}`);
    if (!f) return { ok: false as const, kind: "not_found" as const };
    return {
      ok: true as const,
      data: {
        contentType: f.type,
        bytes: f.bytes.slice(0, limit),
        total: f.bytes.length,
      },
    };
  },
  readBytes: async (_t: string | null, env: string, path: string) => {
    world.calls.push(`bytes ${env} ${path}`);
    if (world.readGate) await world.readGate;
    const fail = world.readFail.get(`${env}:${path}`);
    if (fail) return { ok: false as const, kind: fail };
    const f = world.contents.get(`${env}:${path}`);
    return f
      ? { ok: true as const, data: f.bytes.slice() }
      : { ok: false as const, kind: "not_found" as const };
  },
  // 整份读文本并带上编辑基线（可编辑预览用）。
  readTextFile: async (_t: string | null, env: string, path: string) => {
    world.calls.push(`text ${env} ${path}`);
    if (world.readGate) await world.readGate;
    const fail = world.readFail.get(`${env}:${path}`);
    if (fail) return { ok: false as const, kind: fail };
    const f = world.contents.get(`${env}:${path}`);
    if (!f) return { ok: false as const, kind: "not_found" as const };
    return {
      ok: true as const,
      data: {
        text: new TextDecoder().decode(f.bytes),
        total: f.bytes.length,
        truncated: false,
        mtimeMs: 1000,
        sha256: "0".repeat(64),
      },
    };
  },
  // 保存：调用方给基线，基线不等于当前 mtime 时返回冲突（测试里用 world.base 控制）
  saveTextFile: async (
    _t: string | null,
    env: string,
    path: string,
    text: string,
    base: { mtimeMs: number | null; sha256: string | null },
  ) => {
    world.calls.push(`save ${env} ${path}`);
    if (world.saveConflict) {
      world.saveConflict = false;
      return {
        ok: false as const,
        conflict: {
          conflict: true as const,
          mtimeMs: 2000,
          sha256: "1".repeat(64),
        },
      };
    }
    const bytes = new TextEncoder().encode(text);
    world.put(env, path, bytes);
    return {
      ok: true as const,
      data: {
        size: bytes.length,
        created: false,
        sha256: `${base.sha256 ?? ""}`.replace(/^./, "2"),
        mtimeMs: 3000,
      },
    };
  },
  // 预览前判体积：内容表里有文件就报它的大小，否则按不存在处理。
  statFile: async (_t: string | null, env: string, path: string) => {
    world.calls.push(`stat ${env} ${path}`);
    if (world.readGate) await world.readGate;
    const fail = world.readFail.get(`${env}:${path}`);
    if (fail) return { ok: false as const, kind: fail };
    const f = world.contents.get(`${env}:${path}`);
    return f
      ? {
          ok: true as const,
          data: {
            path,
            name: base(path),
            type: "file" as const,
            size: f.bytes.length,
            mtimeMs: 0,
          },
        }
      : { ok: false as const, kind: "not_found" as const };
  },
  readDownload: async (_t: string | null, env: string, path: string) => {
    world.calls.push(`download ${env} ${path}`);
    const f = world.contents.get(`${env}:${path}`);
    return f
      ? { ok: true as const, data: new Blob([f.bytes as BlobPart]) }
      : { ok: false as const, kind: "not_found" as const };
  },
  readArchive: async (_t: string | null, env: string, path: string) => {
    world.calls.push(`archive ${env} ${path}`);
    return world.has(env, path)
      ? { ok: true as const, data: new Blob(["zip"]) }
      : { ok: false as const, kind: "not_found" as const };
  },
  uploadFile: async (
    _t: string | null,
    env: string,
    path: string,
    body: Blob,
    overwrite: boolean,
    sessionId: string | null,
  ) => {
    world.calls.push(
      `upload ${env} ${path} ${body.size}B${overwrite ? " overwrite" : ""} sid=${sessionId}`,
    );
    world.uploading += 1;
    try {
      if (world.uploadGate) await world.uploadGate;
    } finally {
      world.uploading -= 1;
    }
    const fail = world.uploadFail.get(`${env}:${path}`);
    if (fail) return bad(fail);
    return world.upload(env, path, body.size, overwrite);
  },
  listDirs: async () => bad("not_found"),
};
