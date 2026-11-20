// 跨主机传输（源保留，目标主机新增）：先规划（重名改名、同名目录合并），再按任务逐个跑并轮询进度。
// 服务端任务不覆盖、不合并，所以重名与合并在规划阶段拆成若干个任务。
// 整个应用同一时刻只允许一次传输：状态是模块级单例，传输条与所有文件标签共用。
import { useSyncExternalStore } from "react";
import {
  cancelTransferJob,
  type FileEntry,
  getTransferJob,
  listFiles,
  startTransferJob,
  type TransferJob,
} from "../../../../api/files";
import { loadToken } from "../../../../api/http";
import { toast } from "../../../../ui";
import { emitFsChange } from "./fsEvents";
import { baseName, freeName, joinPath, sizeText } from "./paths";
import { failText } from "./useListing";
import type { DragEntry, DropTarget, FileDragItem } from "./verdict";

/** 轮询间隔；可调是为了测试不用等 */
export const tuning = { pollMs: 400 };
/** 完成态在传输条上停留多久 */
const DONE_MS = 1200;

interface Job {
  from: string;
  to: string;
}

/** 一条进行中/刚结束的作业。传输与上传共用这套，进度条据此堆叠显示 */
export interface JobView {
  /** 稳定 id：同一作业的多次更新靠它合并 */
  id: string;
  phase: "planning" | "running" | "done" | "failed" | "cancelled";
  /** 「传输到 gpu-04」「上传到 gpu-04」 */
  title: string;
  /** 「3/12 个文件」这类副标题；没有就是 null */
  detail: string | null;
  /** 0..1；统计中为 null */
  progress: number | null;
  error: string | null;
  /** 取消当前作业（只有 running/planning 时有） */
  onCancel?: () => void;
}

let jobs: readonly JobView[] = [];
let seq = 0;
let busy = false;
let current: { id: string; env: string } | null = null;
let cancelled = false;
const hideTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of [...listeners]) l();
};

/** 新作业：返回它的 id，后续用 patchJob 更新 */
export function addJob(init: Omit<JobView, "id">): string {
  const id = `job-${++seq}`;
  jobs = [...jobs, { ...init, id }];
  emit();
  return id;
}

export function patchJob(id: string, next: Partial<Omit<JobView, "id">>): void {
  let hit = false;
  jobs = jobs.map((j) => {
    if (j.id !== id) return j;
    hit = true;
    return { ...j, ...next };
  });
  if (hit) emit();
}

/** 结束的作业停留一会儿再消失，让人看得见结果 */
export function settleJob(id: string, ms = DONE_MS): void {
  clearTimeout(hideTimers.get(id));
  hideTimers.set(
    id,
    setTimeout(() => {
      hideTimers.delete(id);
      jobs = jobs.filter((j) => j.id !== id);
      emit();
    }, ms),
  );
}

export function dropJob(id: string): void {
  clearTimeout(hideTimers.get(id));
  hideTimers.delete(id);
  jobs = jobs.filter((j) => j.id !== id);
  emit();
}

export const useJobs = (): readonly JobView[] =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    () => jobs,
  );

// 传输条是全应用唯一的一条，挂在已挂载的文件标签里：登记顺序里的第一个标签当宿主，
// 它卸载（切走/关闭）后由下一个接手；一个文件标签都不在屏时传输照常进行，只是看不到条。
const hosts: string[] = [];
const hostListeners = new Set<() => void>();
const hostsChanged = () => {
  for (const l of [...hostListeners]) l();
};
export function registerStripHost(id: string): () => void {
  hosts.push(id);
  hostsChanged();
  return () => {
    hosts.splice(hosts.indexOf(id), 1);
    hostsChanged();
  };
}
export const useIsStripHost = (id: string): boolean =>
  useSyncExternalStore(
    (cb) => {
      hostListeners.add(cb);
      return () => void hostListeners.delete(cb);
    },
    () => hosts[0] === id,
  );
export const transferBusy = (): boolean => busy;

/** 测试用：清掉全部作业状态 */
export function resetTransfers(): void {
  for (const t of hideTimers.values()) clearTimeout(t);
  hideTimers.clear();
  busy = false;
  cancelled = false;
  current = null;
  jobs = [];
  emit();
}

/** 取消正在跑的跨主机任务：发出请求，之后以轮询到的状态为准 */
export function cancelTransfer(): void {
  cancelled = true;
  if (current) void cancelTransferJob(loadToken(), current.id);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function listAll(env: string, dir: string): Promise<FileEntry[]> {
  const r = await listFiles(loadToken(), env, dir, true);
  if (!r.ok) throw new Error(failText(r.kind));
  if (r.data.truncated) throw new Error(`${dir} 里的条目太多，无法合并`);
  return r.data.entries;
}

interface Plan {
  jobs: Job[];
  renamed: number;
}

/** 规划：目标已有同名文件 → 改名；已有同名目录 → 递归合并；否则整体一个任务 */
async function plan(item: FileDragItem, t: DropTarget): Promise<Plan> {
  const names = new Map<string, Map<string, FileEntry["type"]>>();
  const namesOf = async (dir: string) => {
    let m = names.get(dir);
    if (!m) {
      const rows = await listAll(t.env, dir);
      m = new Map(rows.map((e) => [e.name, e.type]));
      names.set(dir, m);
    }
    return m;
  };
  const out: Plan = { jobs: [], renamed: 0 };
  const into = async (src: string, isDir: boolean, dstDir: string) => {
    const taken = await namesOf(dstDir);
    const name = baseName(src);
    const existing = taken.get(name);
    if (isDir && existing === "dir") {
      const dst = joinPath(dstDir, name);
      for (const c of await listAll(item.env, src))
        await into(joinPath(src, c.name), c.type === "dir", dst);
      return;
    }
    const target = existing
      ? freeName(new Set(taken.keys()), name, isDir)
      : name;
    if (target !== name) out.renamed++;
    taken.set(target, isDir ? "dir" : "file");
    out.jobs.push({ from: src, to: joinPath(dstDir, target) });
  };
  for (const e of item.entries) await into(e.path, e.isDir, t.dir);
  return out;
}

const fraction = (j: TransferJob): number => {
  if (j.state === "done") return 1;
  if (j.totalBytes && j.totalBytes > 0)
    return Math.min(1, j.bytes / j.totalBytes);
  if (j.totalFiles && j.totalFiles > 0)
    return Math.min(1, j.files / j.totalFiles);
  return 0;
};

interface Run {
  ok: boolean;
  error: string | null;
}

async function runJobs(
  item: FileDragItem,
  t: DropTarget,
  jobs: Job[],
  title: string,
  initialDetail: string | null,
  jobId: string,
): Promise<Run> {
  for (const [i, job] of jobs.entries()) {
    const started = await startTransferJob(loadToken(), {
      from: { env: item.env, path: job.from },
      to: { env: t.env, path: job.to },
      overwrite: false,
      // 拖放动作不归到会话审计时间线（审计只记模型调用）
      sessionId: null,
    });
    if (!started.ok) return { ok: false, error: failText(started.kind) };
    let cur = started.data;
    current = { id: cur.id, env: t.env };
    const show = () => {
      // 服务端扫描完才有总量；合并成多个任务时只写项数
      const detail =
        jobs.length > 1
          ? `${jobs.length} 项 · 逐项传输`
          : cur.totalFiles !== null
            ? `${cur.totalFiles} 个文件${cur.totalBytes !== null ? ` · ${sizeText(cur.totalBytes)}` : ""}`
            : initialDetail;
      patchJob(jobId, {
        phase: "running",
        title,
        detail,
        progress: (i + fraction(cur)) / jobs.length,
        error: null,
      });
    };
    show();
    while (cur.state === "running") {
      await sleep(tuning.pollMs);
      const r = await getTransferJob(loadToken(), cur.id);
      if (!r.ok) return { ok: false, error: failText(r.kind) };
      cur = r.data;
      show();
    }
    current = null;
    if (cur.state === "cancelled" || cancelled)
      return { ok: false, error: null };
    if (cur.state === "failed")
      return { ok: false, error: cur.error?.message ?? "传输失败" };
  }
  return { ok: true, error: null };
}

/**
 * 发起传输。同一时刻只允许一次：忙时返回 false 并提示，不排队。
 * 结束才落盘：任务 done 之前目标主机上看不到任何东西。
 */
export async function startTransfer(
  item: FileDragItem,
  t: DropTarget,
): Promise<boolean> {
  if (busy) {
    toast("前一次传输还没结束", { tone: "warn" });
    return false;
  }
  busy = true;
  cancelled = false;
  const title = `传输到 ${t.hostName}`;
  // 只有一个文件时数量与体积已知；目录与批量要等服务端扫描
  const only =
    item.entries.length === 1 ? (item.entries[0] as DragEntry) : null;
  const detail =
    only && !only.isDir ? `1 个文件 · ${sizeText(only.size)}` : null;
  const what = only ? only.name : `${item.entries.length} 项`;
  const jobId = addJob({
    phase: "planning",
    title,
    detail,
    progress: null,
    error: null,
    onCancel: cancelTransfer,
  });
  try {
    const p = await plan(item, t);
    const run = await runJobs(item, t, p.jobs, title, detail, jobId);
    if (run.ok) {
      emitFsChange(t.env);
      toast(
        `已传输 ${what} → ${t.hostName}:${t.dir}${p.renamed ? ` · ${p.renamed} 项重名已改名` : ""}`,
        { tone: "ok" },
      );
      patchJob(jobId, {
        phase: "done",
        title: `已传输到 ${t.hostName}`,
        detail: null,
        progress: 1,
        error: null,
        onCancel: undefined,
      });
      settleJob(jobId);
    } else if (run.error === null) {
      emitFsChange(t.env);
      patchJob(jobId, {
        phase: "cancelled",
        title: "传输已取消",
        detail: null,
        progress: null,
        error: null,
        onCancel: undefined,
      });
      settleJob(jobId);
    } else {
      emitFsChange(t.env);
      patchJob(jobId, {
        phase: "failed",
        title: `传输到 ${t.hostName} 失败`,
        detail: null,
        progress: null,
        error: run.error,
        onCancel: undefined,
      });
    }
    return run.ok;
  } catch (e) {
    patchJob(jobId, {
      phase: "failed",
      title: `传输到 ${t.hostName} 失败`,
      detail: null,
      progress: null,
      error: e instanceof Error ? e.message : "传输失败",
      onCancel: undefined,
    });
    return false;
  } finally {
    busy = false;
    current = null;
  }
}
