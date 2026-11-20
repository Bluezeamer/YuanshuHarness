// 文件管理器的工具条：永远只有一行。平时是「上一级 / 面包屑 / 分支 / 新建 / 隐藏文件 / 刷新 / 更多」，
// 多选时同一行换成选择条（不增减行，列表不会跳）。
import { Button, IconButton, Menu } from "../../../../ui";
import { CloseIcon, PlusIcon } from "../../../../ui/icons";
import { Crumbs, type CrumbsProps } from "./Crumbs";
import { BranchIcon, EyeIcon, EyeOffIcon, RefreshIcon, UpIcon } from "./icons";

export interface FilesBarProps {
  path: string;
  /** 根目录或没有上级时禁用「上一级」 */
  canUp: boolean;
  onUp(): void;
  onGo(path: string): void;
  dropMark: CrumbsProps["mark"];
  /** 在 git 仓库里才有：分支名与未提交条数；点它进 / 出版本视图 */
  branch: { name: string; changes: number } | null;
  inGit: boolean;
  onToggleGit(): void;
  /** 目录没读出来（读取中 / 失败）时，新建不可用 */
  ready: boolean;
  onNewFile(): void;
  onMkdir(): void;
  refreshing: boolean;
  onRefresh(): void;
  showHidden: boolean;
  onToggleHidden(): void;
  onCopyPath(): void;
}

export function FilesBar(p: FilesBarProps) {
  return (
    <div className="ws-fm-bar">
      <IconButton
        label="上一级"
        icon={<UpIcon />}
        disabled={!p.canUp}
        onClick={p.onUp}
      />
      <Crumbs path={p.path} onGo={p.onGo} mark={p.dropMark} />
      <span className="ws-fm-gap" />
      {p.branch && (
        <Button
          variant="ghost"
          size="sm"
          className="ws-fm-branch"
          aria-pressed={p.inGit}
          title={
            p.inGit
              ? "回到文件列表"
              : p.branch.changes > 0
                ? `分支 ${p.branch.name}，${p.branch.changes} 项未提交改动；点开看版本`
                : `分支 ${p.branch.name}；点开看版本`
          }
          onClick={p.onToggleGit}
        >
          <BranchIcon />
          <span className="ws-fm-bname t-mono">{p.branch.name}</span>
          {p.branch.changes > 0 && (
            <span className="ws-fm-bcount t-mono">{p.branch.changes}</span>
          )}
        </Button>
      )}
      <Menu
        label="新建"
        items={[
          { id: "file", label: "新建文件", onSelect: p.onNewFile },
          { id: "dir", label: "新建文件夹", onSelect: p.onMkdir },
        ]}
        trigger={(t) => (
          <Button
            {...t}
            variant="ghost"
            size="sm"
            icon={<PlusIcon />}
            aria-label="新建"
            disabled={!p.ready || p.inGit}
          >
            <span className="ws-fm-newtxt">新建</span>
          </Button>
        )}
      />
      <IconButton
        label="显示隐藏文件"
        icon={p.showHidden ? <EyeIcon /> : <EyeOffIcon />}
        aria-pressed={p.showHidden}
        onClick={p.onToggleHidden}
      />
      <IconButton
        label="刷新"
        icon={<RefreshIcon />}
        aria-busy={p.refreshing || undefined}
        onClick={p.onRefresh}
      />
      <Menu
        label="更多"
        items={[{ id: "copy", label: "复制路径", onSelect: p.onCopyPath }]}
      />
    </div>
  );
}

export function SelBar({
  count,
  onCopy,
  onDelete,
  onClear,
}: {
  count: number;
  onCopy(): void;
  onDelete(): void;
  onClear(): void;
}) {
  return (
    <div className="ws-fm-bar ws-fm-selbar">
      <IconButton label="取消选择" icon={<CloseIcon />} onClick={onClear} />
      <span className="t-entry">已选 {count} 项</span>
      <span className="ws-fm-gap" />
      <Button variant="ghost" size="sm" onClick={onCopy}>
        复制路径
      </Button>
      <Button variant="danger" size="sm" onClick={onDelete}>
        删除
      </Button>
    </div>
  );
}
