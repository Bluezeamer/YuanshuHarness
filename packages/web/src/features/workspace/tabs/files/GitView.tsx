// 「版本」视图：当前分支、切分支、未提交改动列表。
// 只由 FilesTab 在当前目录属于 git 仓库时挂载；diff 的渲染归上层，这里只把绝对路径回调出去。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type GitBranches,
  type GitDirtyPolicy,
  type GitStatus,
  type GitStatusEntry,
  gitBranches,
  gitCheckout,
} from "../../../../api/git";
import { loadToken } from "../../../../api/http";
import {
  Button,
  Empty,
  ListRow,
  Menu,
  type MenuItem,
  Modal,
  toast,
} from "../../../../ui";
import { ChevronDownIcon } from "../../../../ui/icons";
import { GIT_MARK, GIT_TEXT } from "./FileRow";
import { BranchIcon } from "./icons";
import { failText } from "./useListing";

interface ChangeRowProps {
  entry: GitStatusEntry;
  root: string;
  onOpenDiff: ((absPath: string) => void) | undefined;
}

function ChangeRow({ entry, root, onOpenDiff }: ChangeRowProps) {
  const abs = `${root.replace(/\/+$/, "")}/${entry.path}`;
  // 分组头已经写了目录，行里只留文件名
  const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  const why = GIT_TEXT[entry.status];
  const open = onOpenDiff ? () => onOpenDiff(abs) : undefined;
  return (
    <ListRow
      size="compact"
      className="ws-fm-grow"
      data-git={entry.status}
      data-path={abs}
      lead={
        <span className="ws-fm-gstat t-mono" title={why}>
          {GIT_MARK[entry.status]}
        </span>
      }
      label={name}
      disabled={!open}
      title={
        open
          ? `${abs}\n${why}`
          : `${abs}\n${why}\n（diff 视图还没接上，暂时只能看路径）`
      }
      onClick={open}
    />
  );
}

export interface GitViewProps {
  env: string;
  sessionId: string | null;
  git: GitStatus;
  /** diff 视图由上层注入；没人接线时条目不可点 */
  onOpenDiff: ((absPath: string) => void) | undefined;
  /** 切完分支：目录与 HEAD 都变了，让文件管理器重取状态 */
  onChanged(): void;
}

export function GitView({
  env,
  sessionId,
  git,
  onOpenDiff,
  onChanged,
}: GitViewProps) {
  const root = git.root ?? "";
  const [branches, setBranches] = useState<GitBranches | null>(null);
  // 待确认的目标分支：非 null 就说明有脏改动，得先让用户选策略
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState<GitDirtyPolicy | null>(null);

  const loadBranches = useCallback(() => {
    void gitBranches(loadToken(), env, root).then((r) => {
      if (r.ok) setBranches(r.data);
    });
  }, [env, root]);

  // 进视图取一次；切完分支再取，菜单里的对勾要跟着走
  useEffect(loadBranches, [loadBranches]);

  const dirty = git.entries.length > 0;

  const checkout = async (branch: string, policy: GitDirtyPolicy) => {
    setBusy(policy);
    const r = await gitCheckout(
      loadToken(),
      env,
      root,
      branch,
      policy,
      sessionId,
    );
    setBusy(null);
    if (r.ok) {
      setPending(null);
      toast(`已切换到 ${r.data.branch}`, { tone: "ok" });
      onChanged();
      loadBranches();
      return;
    }
    if ("dirty" in r) {
      // 服务端认为目录不干净：把「选策略」补上，别直接报错
      setPending(branch);
      return;
    }
    setPending(null);
    // 服务端给了原因就用它（比如 git 自己拒绝切换），否则按失败类型兜个中文说明
    toast(`切换到 ${branch} 失败：${r.message || failText(r.kind)}`, {
      tone: "danger",
    });
  };

  const pick = (branch: string) => {
    // 本地已知脏就先问策略，省下一次注定被拒的请求
    if (dirty) setPending(branch);
    else void checkout(branch, "abort");
  };

  const current = branches?.current ?? git.branch;
  const items: MenuItem[] = branches?.locals.length
    ? branches.locals.map((b) => ({
        id: b,
        label: b === current ? `${b} ✓` : b,
        disabled: b === current,
        onSelect: () => pick(b),
      }))
    : [
        {
          id: "branches",
          label: branches ? "没有其它本地分支" : "正在读取分支…",
          disabled: true,
          onSelect: loadBranches,
        },
      ];

  // 按目录分组：仓库根下的文件直接平铺，嵌套的多一层目录头
  const groups = useMemo(() => {
    const map = new Map<string, GitStatusEntry[]>();
    for (const e of git.entries) {
      const at = e.path.lastIndexOf("/");
      const dir = at < 0 ? "" : e.path.slice(0, at);
      const list = map.get(dir);
      if (list) list.push(e);
      else map.set(dir, [e]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [git.entries]);

  return (
    <div className="ws-fm-gitview">
      <div className="ws-fm-githead">
        <Menu
          label="切换分支"
          placement="bottom-start"
          items={items}
          trigger={(p) => (
            <Button
              {...p}
              variant="ghost"
              size="sm"
              className="ws-fm-gbranch"
              data-detached={git.detached || undefined}
              loading={busy === "abort"}
              aria-label="切换分支"
              title={
                git.detached
                  ? "detached HEAD：不在任何分支上；点开切换分支"
                  : "切换分支"
              }
              icon={<BranchIcon />}
            >
              <span className="t-mono">
                {git.detached ? "HEAD detached" : (current ?? "未知分支")}
              </span>
              <ChevronDownIcon size={12} />
            </Button>
          )}
        />
        <span className="ws-fm-gap" />
        {dirty && (
          <span className="ws-fm-gnote t-aux">
            {git.entries.length} 项未提交
          </span>
        )}
      </div>

      {git.truncated && (
        <p className="ws-fm-note t-aux">改动太多，只列出了前面一部分</p>
      )}

      <div className="ws-fm-glist">
        {groups.length === 0 ? (
          <Empty
            compact
            title="没有未提交的改动"
            description="目录是干净的，切分支不会丢东西"
          />
        ) : (
          groups.map(([dir, list]) => (
            <section key={dir || "/"} className="ws-fm-ggroup">
              <div className="ws-fm-gdir t-aux">
                <span className="t-mono">{dir || "仓库根"}</span>
                <span className="ws-fm-gcount t-mono">{list.length}</span>
              </div>
              {list.map((e) => (
                <ChangeRow
                  key={e.path}
                  entry={e}
                  root={root}
                  onOpenDiff={onOpenDiff}
                />
              ))}
            </section>
          ))
        )}
      </div>

      {pending && (
        <Modal
          open
          onClose={() => setPending(null)}
          size="sm"
          title={`切换到 ${pending}？`}
          description="当前目录有未提交的改动。先决定这些改动怎么处理，再切分支。"
          footer={
            <>
              <Button onClick={() => setPending(null)}>取消</Button>
              <Button
                loading={busy === "stash"}
                onClick={() => void checkout(pending, "stash")}
              >
                暂存改动
              </Button>
              <Button
                variant="primary"
                loading={busy === "carry"}
                onClick={() => void checkout(pending, "carry")}
              >
                一起带走
              </Button>
            </>
          }
        >
          <p className="ws-fm-hint t-aux">
            暂存改动：把改动收进 git stash，工作区干净后再切，之后用 git stash
            pop 取回。
          </p>
          <p className="ws-fm-hint t-aux">
            一起带走：带着改动直接切过去，改动会跟到新分支，可能产生冲突。
          </p>
        </Modal>
      )}
    </div>
  );
}
