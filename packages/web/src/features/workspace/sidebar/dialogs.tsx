import type { RemovalPreview } from "../../../api/workspaces";
import { Chip, ConfirmDialog } from "../../../ui";
import type { Confirm } from "./controller";

// 删除确认的内容。工作区的影响清单来自服务端的 GET /workspaces/:id/removal-preview。
export const RUNNING_ERROR = "有会话正在运行，先停止它再删除。";

function WorkspaceRemoval({ preview }: { preview: RemovalPreview | null }) {
  if (preview === null) return <p className="t-aux">正在读取会被删除的内容…</p>;
  return (
    <>
      <p>
        连同它的会话一起删除，不可恢复：{preview.sessions} 个会话
        {preview.terminals > 0 &&
          `，并关闭 ${preview.terminals} 个终端、终止其中的进程`}
        。
      </p>
      <div className="rl-impact">
        <div className="rl-impact-h t-group">
          目录 · 只清库里的登记，磁盘上的文件不动
        </div>
        {preview.directories.map((d) => (
          <div key={d.id} className="rl-impact-row">
            <span className="t-mono rl-impact-path">{d.path}</span>
            <span className="t-aux rl-impact-n">
              {d.removed
                ? `规则 ${d.rules} · hooks ${d.hooks}`
                : "另一个工作区也在用"}
            </span>
            <Chip tone={d.removed ? "danger" : undefined} dot={d.removed}>
              {d.removed ? "随之删除" : "保留"}
            </Chip>
          </div>
        ))}
      </div>
    </>
  );
}

function SessionRemoval({
  titles,
  derived,
}: {
  titles: readonly string[];
  derived: number;
}) {
  return (
    <>
      <p>
        {titles.length === 1
          ? `「${titles[0]}」的对话记录会被删除，不可恢复。`
          : `这 ${titles.length} 个会话的对话记录会被删除，不可恢复。`}
      </p>
      {derived > 0 && (
        <p className="rl-note t-aux">
          它有 {derived}{" "}
          个派生会话，不会被删除；删除后它们升为顶层，并标注「派生自已删除的会话」。
        </p>
      )}
    </>
  );
}

export function ConfirmLayer({
  confirm,
  error,
  busy,
  onConfirm,
  onClose,
}: {
  confirm: Confirm | null;
  error: string | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ws = confirm?.kind === "workspace" ? confirm : null;
  const sess = confirm?.kind === "session" ? confirm : null;
  const grp = confirm?.kind === "group" ? confirm : null;
  return (
    <ConfirmDialog
      open={confirm !== null}
      title={
        ws
          ? `删除工作区「${ws.ws.name}」？`
          : grp
            ? `解散分组「${grp.group.name}」？`
            : "删除会话？"
      }
      confirmLabel={grp ? "解散" : "删除"}
      busy={busy || (ws !== null && ws.preview === null)}
      error={error}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {ws && <WorkspaceRemoval preview={ws.preview} />}
      {grp && (
        <p>
          {grp.count > 0
            ? `里面的 ${grp.count} 个工作区会回到「未分组」，工作区和它们的会话都不动。`
            : "这个分组是空的。"}
        </p>
      )}
      {sess && (
        <SessionRemoval
          titles={sess.list.map((s) => s.title)}
          derived={sess.derived}
        />
      )}
    </ConfirmDialog>
  );
}
