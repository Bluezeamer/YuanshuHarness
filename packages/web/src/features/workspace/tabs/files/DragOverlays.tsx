// 文件拖拽的两个浮层，都经 portal 挂到 body（窗格有 overflow，fixed 会被裁）：
// 幽灵条（跟随指针，右侧常显落点判定）与传输条（底部居中，进度/完成/失败）。
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button, ProgressBar } from "../../../../ui";
import { startPoint, useHint } from "./dndStore";
import { FileIcon, FolderIcon } from "./icons";
import { dropJob, type JobView, useJobs } from "./transfer";
import type { DragEntry, FileDragItem } from "./verdict";

/** 幽灵条：只在发起拖拽的标签里渲染，所以全局最多一个 */
export function DragGhost({ item }: { item: FileDragItem }) {
  const hint = useHint();
  const box = useRef<HTMLDivElement>(null);
  const first = item.entries[0] as DragEntry;

  useEffect(() => {
    // 位置直接写 style，不走 React，免得每次 dragover 都重渲染
    if (box.current) {
      box.current.style.left = `${startPoint.x}px`;
      box.current.style.top = `${startPoint.y}px`;
    }
    const move = (e: DragEvent) => {
      const el = box.current;
      if (!el || (e.clientX === 0 && e.clientY === 0)) return;
      el.style.left = `${e.clientX}px`;
      el.style.top = `${e.clientY}px`;
    };
    document.addEventListener("dragover", move, true);
    return () => document.removeEventListener("dragover", move, true);
  }, []);

  return createPortal(
    <div
      ref={box}
      className="ws-xghost t-aux"
      data-bad={hint.bad || undefined}
      data-live={(!hint.bad && hint.tone !== null) || undefined}
      style={hint.tone ? { ["--ws-xg-tone" as string]: hint.tone } : undefined}
      aria-hidden="true"
    >
      {first.isDir ? <FolderIcon size={11} /> : <FileIcon size={11} />}
      <span className="ws-xg-name">{first.name}</span>
      {item.entries.length > 1 && (
        <span className="ws-xg-n t-mono">+{item.entries.length - 1}</span>
      )}
      <span className="ws-xg-to t-mono">{hint.text}</span>
    </div>,
    document.body,
  );
}

/** 作业条：传输与上传共用同一套卡片，多个作业时自上而下堆叠 */
export function TransferStrip() {
  const jobs = useJobs();
  if (jobs.length === 0) return null;
  return createPortal(
    <div className="ws-xfer-stack" role="status" aria-live="polite">
      {jobs.map((j) => (
        <JobCard key={j.id} job={j} />
      ))}
    </div>,
    document.body,
  );
}

function JobCard({ job }: { job: JobView }) {
  const pct = job.progress === null ? null : Math.round(job.progress * 100);
  const running = job.phase === "planning" || job.phase === "running";
  return (
    <div className="ws-xfer t-aux" data-phase={job.phase} data-job={job.id}>
      <div className="ws-xfer-k">
        <span className="ws-xfer-t">{job.title}</span>
        {job.detail && <span className="ws-xfer-n t-mono">{job.detail}</span>}
        {running && job.onCancel && (
          <Button size="sm" variant="ghost" onClick={job.onCancel}>
            取消
          </Button>
        )}
        {!running && (
          <Button size="sm" variant="ghost" onClick={() => dropJob(job.id)}>
            关闭
          </Button>
        )}
      </div>
      {job.error && <div className="ws-xfer-err t-aux">{job.error}</div>}
      <ProgressBar value={pct} label="进度" className="ws-xfer-bar" />
    </div>
  );
}
