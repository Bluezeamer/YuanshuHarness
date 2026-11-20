// 文件管理器标签：浏览、面包屑、新建/重命名/删除；点文件走 store.openPreview 的打开路由。
// 目录属于 git 仓库时多一个「版本」视图（分支与未提交改动），diff 交给上层打开。
// 每台主机各持一份文件树：当前目录存在 tab.cwd，经 patchTab 写回，没有任何全局状态。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileEntry } from "../../../../api/files";
import {
  makeDir,
  removeEntry,
  renameEntry,
  saveTextFile,
} from "../../../../api/files";
import {
  type GitFileStatus,
  type GitStatus,
  gitStatus,
  statusByPath,
} from "../../../../api/git";
import { loadToken } from "../../../../api/http";
import { environmentIdOf } from "../../../../app/shell/hosts";
import { Button, Empty, toast } from "../../../../ui";
import { useFsWatch } from "../../../chat";
import { useHostName, useLayoutStore } from "../../layoutContext";
import type { TabRenderProps } from "../registry";
import { useTabView } from "../useTabView";
import { Crumbs } from "./Crumbs";
import { ConflictDialog, DeleteDialog, NameDialog } from "./Dialogs";
import { DragGhost, TransferStrip } from "./DragOverlays";
import { useFileDnd } from "./dnd";
import { downloadEntry } from "./download";
import { useExternalDrop } from "./dropExternal";
import { FileRow } from "./FileRow";
import { emitFsChange, onFsChange } from "./fsEvents";
import { GitView } from "./GitView";
import { baseName, joinPath, parentOf } from "./paths";
import { retargetPreviews } from "./retarget";
import { FilesBar, SelBar } from "./Toolbar";
import { registerStripHost, useIsStripHost } from "./transfer";
import { failText, useListing } from "./useListing";
import { parseFilesView } from "./viewState";

type Dialog =
  | { kind: "newFile" }
  | { kind: "mkdir" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "delete"; entry: FileEntry };

type View = "files" | "git";

export interface FilesTabProps extends TabRenderProps {
  /** 版本视图点条目时交给上层的 diff 打开动作；上层没接线就不传，条目禁用 */
  onOpenDiff?: (absPath: string) => void;
}

export function FilesTab({
  tab,
  pane,
  sessionId,
  patchTab,
  onOpenDiff,
}: FilesTabProps) {
  const store = useLayoutStore();
  const hostName = useHostName();
  const host = tab.host ?? "server";
  const env = environmentIdOf(host);
  // 窗格切走会卸载：视图状态存浏览器本地，切回来还原（目录对得上才恢复选中与滚动）
  const { initial: saved, save: saveView } = useTabView(tab.id, parseFilesView);
  const [hidden, setHidden] = useState(saved?.hidden ?? false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [view, setView] = useState<View>(saved?.view ?? "files");
  // 切分支这类由本组件发起的操作不会惊动 fs.watch，用它当重取 git 状态的信号
  const [gitRev, setGitRev] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  // 目录优先取 cwd（默认窗口给的），其次 path（「+」菜单给的）
  const dir = tab.cwd || tab.path || "/";
  const savedHere = saved?.at === dir ? saved : null;
  const { state, reload } = useListing(env, dir, hidden);
  const listing = state.listing;
  const here = listing?.path ?? dir;

  // 有限感知刷新：只订阅当前这个目录，服务端（本地 fs.watch / 远程轮询）有变化就重取
  const watchPaths = useMemo(() => [here], [here]);
  const fsRev = useFsWatch(sessionId ?? undefined, env, watchPaths);
  useEffect(() => {
    if (fsRev > 0) reload();
  }, [fsRev, reload]);

  // git 状态：目录变化或收到变更就重取（服务端有 1.5s 缓存，不会每次刷新都 fork git）
  const [git, setGit] = useState<GitStatus | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fsRev/gitRev 只是「该重取 git 状态」的触发信号
  useEffect(() => {
    let alive = true;
    void gitStatus(loadToken(), env, here).then((r) => {
      if (alive && r.ok) setGit(r.data);
    });
    return () => {
      alive = false;
    };
  }, [env, here, fsRev, gitRev]);
  const gitAt = useMemo(
    () => (git ? statusByPath(git) : new Map<string, GitFileStatus>()),
    [git],
  );

  // 多选：只有 ctrl/⌘ 与 shift 点击才是多选（picked，工具条换成选择条）；
  // 普通点击仍然是「打开」，只留一个灰底标记，不改既有手感
  const entriesRef = useRef<FileEntry[]>([]);
  const [sel, setSel] = useState<Set<string>>(() => new Set(savedHere?.sel));
  const [picked, setPicked] = useState(savedHere?.picked ?? false);
  const [anchor, setAnchor] = useState<string | null>(null);
  const picking = picked && sel.size > 0;
  const clearSel = () => {
    setSel(new Set());
    setPicked(false);
  };
  // 换目录就清空选择（挂载时不清：那是刚恢复出来的）
  const lastHere = useRef(here);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在切目录时清理
  useEffect(() => {
    if (lastHere.current === here) return;
    lastHere.current = here;
    setSel(new Set());
    setPicked(false);
    setAnchor(null);
  }, [here]);

  const listEl = useRef<HTMLDivElement>(null);
  const scroll = useRef(savedHere?.scroll ?? 0);
  const restoreScroll = useRef(savedHere?.scroll ?? 0);
  const persist = useRef(() => {});
  persist.current = () =>
    saveView({
      view,
      hidden,
      at: here,
      sel: [...sel],
      picked,
      scroll: scroll.current,
    });
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些变了就存一次，存的内容由 persist 取最新
  useEffect(() => persist.current(), [view, hidden, here, sel, picked]);

  const selPaths = useMemo(
    () => [...sel].map((name) => joinPath(here, name)),
    [sel, here],
  );
  // 选中的条目按列表顺序（拖拽一次带走整批）
  const selEntries = useMemo(
    () => (listing?.entries ?? []).filter((e) => sel.has(e.name)),
    [listing, sel],
  );

  const dnd = useFileDnd({
    tabId: tab.id,
    sessionId,
    host,
    env,
    here,
    root,
    selected: selEntries,
  });

  // 本机（操作系统）文件拖入：落点高亮与内部拖拽共用一套，上传写进这台主机的文件系统
  const ext = useExternalDrop({
    sessionId,
    host,
    env,
    hostName: hostName(host),
    here,
    root,
    setMark: dnd.setMark,
    onUploaded: () => emitFsChange(env),
  });

  // 两组拖放挂同一个节点：各判各的（内部拖拽物 / dataTransfer 里的 Files），互不抢占
  const dropHandlers = {
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      dnd.handlers.onDragOver(e);
      ext.handlers.onDragOver(e);
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => {
      dnd.handlers.onDragLeave(e);
      ext.handlers.onDragLeave(e);
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      dnd.handlers.onDrop(e);
      ext.handlers.onDrop(e);
    },
  };
  const showStrip = useIsStripHost(tab.id);
  useEffect(() => registerStripHost(tab.id), [tab.id]);

  // 别处（另一个文件标签、拖拽移动）改了这台主机的目录，这里跟着刷新
  useEffect(
    () =>
      onFsChange((changed) => {
        if (changed === env) reload();
      }),
    [env, reload],
  );

  const go = useCallback(
    (path: string) => {
      if (path !== dir) patchTab({ cwd: path });
    },
    [dir, patchTab],
  );

  // 点击语义：ctrl/⌘ 切换单选、shift 区间选择、普通点击清空选择并打开
  const onEntryClick = (
    ev: React.MouseEvent | React.KeyboardEvent,
    e: FileEntry,
    index: number,
  ) => {
    if (ev.ctrlKey || ev.metaKey) {
      setPicked(true);
      setSel((prev) => {
        const next = new Set(prev);
        if (next.has(e.name)) next.delete(e.name);
        else next.add(e.name);
        return next;
      });
      setAnchor(e.name);
      return;
    }
    if (ev.shiftKey && anchor) {
      const from = entriesRef.current.findIndex((x) => x.name === anchor);
      if (from >= 0) {
        const [a, b] = from < index ? [from, index] : [index, from];
        setPicked(true);
        setSel(new Set(entriesRef.current.slice(a, b + 1).map((x) => x.name)));
        return;
      }
    }
    // 单选也留标记：用户点了哪个文件要看得出来
    setPicked(false);
    setSel(new Set([e.name]));
    setAnchor(e.name);
    // 单击与空格 = 临时预览，Enter = 固定（同双击）
    openEntry(e, "key" in ev && ev.key === "Enter");
  };

  const openEntry = (e: FileEntry, pin: boolean) => {
    const path = joinPath(here, e.name);
    if (e.type === "dir") go(path);
    else store.openPreview(pane.pid, tab.id, path, !pin);
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(here);
      toast("已复制路径", { tone: "ok" });
    } catch {
      toast("无法写入剪贴板", { tone: "warn" });
    }
  };

  const mkdir = async (name: string) => {
    const r = await makeDir(loadToken(), env, joinPath(here, name), sessionId);
    if (!r.ok) return r.kind === "conflict" ? "已存在同名项" : failText(r.kind);
    emitFsChange(env);
    return null;
  };

  const rename = (entry: FileEntry) => async (name: string) => {
    const from = joinPath(here, entry.name);
    const to = joinPath(here, name);
    const r = await renameEntry(loadToken(), env, from, to, sessionId);
    if (!r.ok) return r.kind === "conflict" ? "已存在同名项" : failText(r.kind);
    retargetPreviews(store, host, from, to);
    emitFsChange(env);
    return null;
  };

  const remove = (entry: FileEntry) => async () => {
    const r = await removeEntry(
      loadToken(),
      env,
      joinPath(here, entry.name),
      entry.type === "dir",
      sessionId,
    );
    if (!r.ok) return failText(r.kind);
    emitFsChange(env);
    return null;
  };

  // 批量删除：逐个删（目录递归），失败的收集起来一起提示
  const removeSelected = async () => {
    const names = [...sel];
    if (names.length === 0) return;
    let failed = 0;
    for (const name of names) {
      const entry = entriesRef.current.find((x) => x.name === name);
      const r = await removeEntry(
        loadToken(),
        env,
        joinPath(here, name),
        entry?.type === "dir",
        sessionId,
      );
      if (!r.ok) failed += 1;
    }
    clearSel();
    emitFsChange(env);
    if (failed > 0) toast(`${failed} 项删除失败`, { tone: "danger" });
    else toast(`已删除 ${names.length} 项`, { tone: "ok" });
  };

  const copyPathOf = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast("已复制路径", { tone: "ok" });
    } catch {
      toast("无法写入剪贴板", { tone: "warn" });
    }
  };

  const copySelectedPaths = async () => {
    const paths = selPaths;
    if (paths.length === 0) return;
    try {
      await navigator.clipboard.writeText(paths.join("\n"));
      toast(`已复制 ${paths.length} 条路径`, { tone: "ok" });
    } catch {
      toast("无法写入剪贴板", { tone: "warn" });
    }
  };

  // 新建空文件：复用保存接口（不带基线就是「新建」）
  const createFile = async (name: string) => {
    const path = joinPath(here, name);
    const r = await saveTextFile(
      loadToken(),
      env,
      path,
      "",
      { mtimeMs: null, sha256: null },
      sessionId,
    );
    if (!r.ok) return "conflict" in r ? "已存在同名项" : "创建失败";
    emitFsChange(env);
    return null;
  };

  const entries = listing?.entries ?? [];
  entriesRef.current = entries;
  // 目录读出来、行画好之后滚回上次的位置；只做一次
  useLayoutEffect(() => {
    if (state.status !== "ready") return;
    if (listEl.current && restoreScroll.current > 0)
      listEl.current.scrollTop = restoreScroll.current;
    restoreScroll.current = 0;
  }, [state.status]);
  const refreshing = state.status === "ready" && state.refreshing;
  // 版本视图只在仓库里成立：目录一旦不再是仓库就退回文件视图，不留一个空面板
  const inGit = view === "git" && git?.root != null;

  // 切分支会动工作区文件：自己重取 git 状态，别的文件标签也一起刷新
  const afterCheckout = () => {
    setGitRev((n) => n + 1);
    emitFsChange(env);
  };

  return (
    <div className="ws-fm" data-host={host} ref={root} {...dropHandlers}>
      {picking ? (
        <SelBar
          count={sel.size}
          onCopy={copySelectedPaths}
          onDelete={removeSelected}
          onClear={clearSel}
        />
      ) : (
        <FilesBar
          path={here}
          canUp={here !== "/" && listing?.parent !== null}
          onUp={() => go(parentOf(here))}
          onGo={go}
          dropMark={dnd.mark?.at === "crumb" ? dnd.mark : null}
          branch={
            git?.root && git.branch
              ? { name: git.branch, changes: git.entries.length }
              : null
          }
          inGit={inGit}
          onToggleGit={() => setView(inGit ? "files" : "git")}
          ready={state.status === "ready"}
          onNewFile={() => setDialog({ kind: "newFile" })}
          onMkdir={() => setDialog({ kind: "mkdir" })}
          refreshing={refreshing}
          onRefresh={reload}
          showHidden={hidden}
          onToggleHidden={() => setHidden((v) => !v)}
          onCopyPath={copyPath}
        />
      )}

      {inGit && git ? (
        <GitView
          env={env}
          sessionId={sessionId}
          git={git}
          onOpenDiff={onOpenDiff}
          onChanged={afterCheckout}
        />
      ) : (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: 点空白清空选择是鼠标便利，键盘用选择条的「取消选择」 */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: 同上，清空选择不配快捷键 */}
          <div
            className="ws-fm-list"
            ref={listEl}
            onScroll={(e) => {
              scroll.current = e.currentTarget.scrollTop;
              persist.current();
            }}
            onClick={(e) => {
              // 只有点在空白（不是某一行）时才算取消选择
              if ((e.target as Element).closest(".ws-fm-row")) return;
              clearSel();
            }}
            aria-busy={state.status === "loading" || undefined}
            data-dz={dnd.mark?.at === "list" ? dnd.mark.label : undefined}
          >
            {state.status === "loading" && (
              <p className="ws-fm-note t-aux" role="status">
                正在读取目录…
              </p>
            )}
            {state.status === "error" && (
              <Empty
                tone="danger"
                title="无法读取目录"
                description={failText(state.kind)}
                action={
                  <div className="ws-fm-actions">
                    <Button size="sm" onClick={reload}>
                      重试
                    </Button>
                    {here !== "/" && (
                      <Button size="sm" onClick={() => go(parentOf(here))}>
                        回到上一级
                      </Button>
                    )}
                  </div>
                }
              />
            )}
            {state.status === "ready" && entries.length === 0 && (
              <Empty
                compact
                title="空目录"
                description={
                  hidden
                    ? "可以把文件拖到这里"
                    : "没有可见的项，点工具条的眼睛可以显示隐藏文件；也可以把文件拖到这里"
                }
              />
            )}
            {state.status === "ready" &&
              entries.map((e, i) => (
                <FileRow
                  key={e.name}
                  entry={e}
                  path={joinPath(here, e.name)}
                  git={gitAt.get(joinPath(here, e.name))}
                  current={!picking && sel.has(e.name)}
                  selected={picking && sel.has(e.name)}
                  onOpen={(ev) => onEntryClick(ev, e, i)}
                  {...(e.type === "dir"
                    ? {}
                    : { onPin: () => openEntry(e, true) })}
                  onDownload={() =>
                    void downloadEntry(env, joinPath(here, e.name), e)
                  }
                  onRename={() => setDialog({ kind: "rename", entry: e })}
                  onDelete={() => setDialog({ kind: "delete", entry: e })}
                  onCopyPath={() => void copyPathOf(joinPath(here, e.name))}
                  drag={dnd.rowDrag(e)}
                />
              ))}
            {listing?.truncated && (
              <p className="ws-fm-note t-aux">
                目录条目太多，只显示了前面一部分
              </p>
            )}
          </div>
        </>
      )}

      {dnd.item?.tabId === tab.id && <DragGhost item={dnd.item} />}
      {showStrip && <TransferStrip />}

      {ext.ask && (
        <ConflictDialog
          dir={ext.ask.dir}
          names={ext.ask.conflicts.map((c) => c.rel)}
          onChoose={ext.decide}
          onClose={() => ext.decide("cancel")}
        />
      )}

      {dialog?.kind === "newFile" && (
        <NameDialog
          title="新建文件"
          initial=""
          confirmLabel="创建"
          onClose={() => setDialog(null)}
          onSubmit={createFile}
        />
      )}
      {dialog?.kind === "mkdir" && (
        <NameDialog
          title="新建文件夹"
          initial=""
          confirmLabel="创建"
          onClose={() => setDialog(null)}
          onSubmit={mkdir}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title={`重命名 ${dialog.entry.name}`}
          initial={dialog.entry.name}
          confirmLabel="重命名"
          onClose={() => setDialog(null)}
          onSubmit={rename(dialog.entry)}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteDialog
          name={baseName(dialog.entry.name)}
          isDir={dialog.entry.type === "dir"}
          onClose={() => setDialog(null)}
          onConfirm={remove(dialog.entry)}
        />
      )}
    </div>
  );
}
