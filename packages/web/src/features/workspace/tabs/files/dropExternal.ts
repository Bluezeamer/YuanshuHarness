// 文件浏览器标签里的「本机文件拖入」：落点高亮、读取文件、同名确认、上传与进度。
// 与 dnd.ts 的内部文件行拖拽分工明确：那边靠 dndStore 的拖拽物，这边只认 dataTransfer 里的 Files；
// 两边的 dragover/drop 都会先判一次自己管不管，所以互不抢事件。
import { type DragEvent, type RefObject, useRef, useState } from "react";
import { loadToken } from "../../../../api/http";
import { toast } from "../../../../ui";
import { droppedFilesWithPaths, isFileDrag } from "../../../chat/tab/dropFiles";
import { type DzMark, resolveDrop } from "./dnd";
import { addJob, patchJob, settleJob } from "./transfer";
import {
  type Conflict,
  type ConflictChoice,
  findConflicts,
  runUpload,
  type TakenMap,
  type UploadItem,
  type UploadOutcome,
} from "./upload";
import { failText } from "./useListing";

export interface UseExternalDropArgs {
  sessionId: string | null;
  host: string;
  env: string;
  hostName: string;
  /** 当前目录的绝对路径：落在列表空白/文件行上时上传到这里 */
  here: string;
  root: RefObject<HTMLElement | null>;
  /** 与内部文件行拖拽共用同一个落点标记，两套拖拽的高亮就一致了 */
  setMark(m: DzMark | null): void;
  /** 上传结束（无论成败）后刷新目录 */
  onUploaded(): void;
}

export interface UploadProgress {
  done: number;
  total: number;
}

/** 待用户拍板的同名冲突：一次问完整批 */
export interface ConflictAsk {
  dir: string;
  conflicts: Conflict[];
}

export type Decision = ConflictChoice | "cancel";

interface Pending {
  dir: string;
  items: UploadItem[];
  taken: TakenMap;
}

export function useExternalDrop({
  sessionId,
  host,
  env,
  hostName,
  here,
  root,
  setMark,
  onUploaded,
}: UseExternalDropArgs) {
  // 只挡住「同时弹出两个冲突询问」；上传本身允许并发——每批一个作业卡片堆叠显示
  const asking = useRef(false);
  const pending = useRef<Pending | null>(null);
  const [ask, setAsk] = useState<ConflictAsk | null>(null);

  const execute = async (p: Pending, choice: ConflictChoice) => {
    // 进度复用传输条那套作业卡片（与主机间互传同一形态，多个上传会堆叠）
    const jobId = addJob({
      phase: "running",
      title: `上传到 ${hostName}`,
      detail: `0/${p.items.length} 个文件`,
      progress: 0,
      error: null,
    });
    const out = await runUpload({
      token: loadToken(),
      env,
      dir: p.dir,
      sessionId,
      items: p.items,
      taken: p.taken,
      choice,
      onProgress: (done, total) =>
        patchJob(jobId, {
          detail: `${done}/${total} 个文件`,
          progress: total === 0 ? 1 : done / total,
        }),
    });
    patchJob(jobId, {
      phase: out.failed.length > 0 ? "failed" : "done",
      title:
        out.failed.length > 0
          ? `上传到 ${hostName} 失败 ${out.failed.length} 个`
          : `已上传到 ${hostName}`,
      detail: `${out.done} 个文件${out.renamed ? ` · ${out.renamed} 个改名` : ""}${out.skipped ? ` · ${out.skipped} 个跳过` : ""}`,
      progress: 1,
      error: out.failed[0]
        ? `${out.failed[0].rel}：${out.failed[0].reason}`
        : null,
    });
    settleJob(jobId);
    asking.current = false;
    // 服务端目录变了：让所有显示这台主机的文件标签重取
    onUploaded();
    report(p.dir, out);
  };

  /** 结果反馈：成功给数量与改名/跳过，失败把原因带上，不静默 */
  const report = (dir: string, out: UploadOutcome) => {
    if (out.failed.length > 0) {
      const why = out.failed
        .slice(0, 2)
        .map((f) => `${f.rel}：${f.reason}`)
        .join("；");
      const rest =
        out.failed.length > 2
          ? `，其余 ${out.failed.length - 2} 个同样失败`
          : "";
      toast(
        `${out.done} 个文件已上传，${out.failed.length} 个失败 — ${why}${rest}`,
        { tone: "danger" },
      );
      return;
    }
    const parts = [`已上传 ${out.done} 个文件到 ${dir}`];
    if (out.renamed > 0) parts.push(`${out.renamed} 项重名已改名`);
    if (out.skipped > 0) parts.push(`跳过 ${out.skipped} 项`);
    toast(parts.join(" · "), { tone: "ok" });
  };

  const start = async (dir: string, dt: DataTransfer) => {
    if (asking.current) {
      toast("还在等上一批的同名冲突选择", { tone: "warn" });
      return;
    }
    try {
      // 相对路径保留目录结构：拖进来的文件夹都按它在目标目录里还原
      const dropped = await droppedFilesWithPaths(dt);
      if (dropped.length === 0) {
        toast("没有找到可上传的文件", { tone: "warn" });
        return;
      }
      const items: UploadItem[] = dropped.map((d) => ({
        file: d.file,
        path: d.path,
      }));
      const scan = await findConflicts(loadToken(), env, dir, items);
      if (!scan.ok) {
        toast(failText(scan.kind), { tone: "danger" });
        return;
      }
      const batch = { dir, items, taken: scan.taken };
      if (scan.conflicts.length > 0) {
        // 批量上传不逐个问：一次弹窗对整批做选择
        pending.current = batch;
        asking.current = true;
        setAsk({ dir, conflicts: scan.conflicts });
        return;
      }
      await execute(batch, "overwrite");
    } finally {
      // 弹窗还没答（pending 在）时保持 busy，答完由 decide 收尾
      if (!pending.current) asking.current = false;
    }
  };

  const decide = (choice: Decision) => {
    const p = pending.current;
    pending.current = null;
    setAsk(null);
    if (!p || choice === "cancel") {
      asking.current = false;
      return;
    }
    void execute(p, choice);
  };

  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (!isFileDrag(e.dataTransfer)) return;
    // 文件行也当「当前目录」：与资源管理器一致，拖到文件上不会落空
    const r = resolveDrop(
      e.target,
      { host, env, hostName, here, root },
      "here",
    );
    if (!r || "reject" in r) {
      setMark(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setMark({ ...r.mark, label: "上传" });
  };

  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    if (!isFileDrag(e.dataTransfer)) return;
    if (!e.currentTarget.contains(e.relatedTarget as Node | null))
      setMark(null);
  };

  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    // dataTransfer 只在事件处理期间可读，webkitGetAsEntry 必须在 await 之前同步取完
    const dt = e.dataTransfer;
    const r = resolveDrop(
      e.target,
      { host, env, hostName, here, root },
      "here",
    );
    setMark(null);
    if (!r || "reject" in r) return;
    void start(r.t.dir, dt);
  };

  return {
    ask,
    decide,
    handlers: { onDragOver, onDragLeave, onDrop },
  };
}
