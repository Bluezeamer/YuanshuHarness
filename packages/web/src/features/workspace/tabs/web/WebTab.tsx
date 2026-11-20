// 内置浏览器标签：工作区级的「虚拟浏览器窗口」——页面由 Server 持有，标签只记当前显示哪一页（tab.page）。
// 观察 / 手动是同一条工具条的两种状态：agent 在用时你旁观，点「手动操作」接管，点「交还 agent」还给它。
import { useEffect, useRef, useState } from "react";
import {
  type Act,
  answerHandoff,
  answerPageDialog,
  cancelPageUpload,
  closePage,
  discardPendingDownload,
  ensureEngine,
  fetchPendingDownload,
  getLoginOffer,
  openPage,
  putPendingDownload,
  saveLogin,
  setControl,
  uploadPageFiles,
  wakePage,
} from "../../../../api/browser";
import { loadToken } from "../../../../api/http";
import {
  copyText,
  Empty,
  IconButton,
  InlineNotice,
  saveBlob,
  toast,
} from "../../../../ui";
import { CloseIcon } from "../../../../ui/icons";
import {
  type ForwardView,
  type PageView,
  useBrowser,
  useForwards,
  usePageStream,
  usePorts,
} from "../../browser";
import {
  useAnchorSession,
  useDirectoryChoices,
  useHostName,
  useLayoutState,
  useLayoutStore,
  useRunStates,
  useSessionTitles,
} from "../../layoutContext";
import type { TabRenderProps } from "../registry";
import { useTabView } from "../useTabView";
import { BrowserBar, type MainAction } from "./BrowserBar";
import { ConsoleDrawer } from "./ConsoleDrawer";
import { DialogPrompt } from "./DialogPrompt";
import { DownloadDialog } from "./DownloadDialog";
import { HandoffBanner } from "./HandoffBanner";
import { LoginStrip } from "./LoginStrip";
import {
  addressOf,
  currentPage,
  forwardBlocked,
  forwardUrl,
  type PortRow,
  pageName,
} from "./model";
import { PagesPanel } from "./PagesPanel";
import { ReplayView } from "./ReplayView";
import { Stage } from "./Stage";
import { UploadDialog } from "./UploadDialog";
import { useThumb } from "./useThumb";

interface View {
  console: boolean;
  replay: boolean;
}
const parseView = (v: unknown): View | null => {
  if (typeof v !== "object" || v === null) return null;
  const { console: c, replay } = v as { console?: unknown; replay?: unknown };
  return typeof c === "boolean"
    ? { console: c, replay: replay === true }
    : null;
};

export function WebTab(props: TabRenderProps) {
  const workspaceId = useLayoutState((s) => s.workspaceId);
  if (workspaceId === null)
    return (
      <Empty
        compact
        title="没有工作区"
        description="浏览器属于工作区，先打开一个工作区"
      />
    );
  return <WebTabBody {...props} workspaceId={workspaceId} />;
}

function WebTabBody({
  tab,
  pane,
  patchTab,
  workspaceId,
}: TabRenderProps & { workspaceId: string }) {
  const layout = useLayoutStore();
  const hostName = useHostName();
  const titles = useSessionTitles();
  const runStates = useRunStates();
  const anchorSession = useAnchorSession();
  const directories = useDirectoryChoices();
  const { state, store } = useBrowser(workspaceId);
  const page = currentPage(state.pages, tab.page);

  const canvas = useRef<HTMLCanvasElement>(null);
  const pagesButton = useRef<HTMLButtonElement>(null);
  const [pagesOpen, setPagesOpen] = useState(false);
  const ports = usePorts(workspaceId, pagesOpen);
  const forwards = useForwards(workspaceId, pagesOpen);
  const { initial, save } = useTabView(tab.id, parseView);
  const [consoleOpen, setConsoleOpen] = useState(initial?.console ?? false);
  const [replayOpen, setReplayOpen] = useState(initial?.replay ?? false);
  // 回放开着时不接实时画面（省带宽，也不占操作窗口）；关掉后重新连上
  const stream = usePageStream(
    workspaceId,
    replayOpen ? null : (page?.id ?? null),
    canvas,
  );
  const thumb = useThumb(workspaceId, page);
  const saveView = (next: Partial<View>) =>
    save({ console: consoleOpen, replay: replayOpen, ...next });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // agent 在这个标签显示着别的页面时新开了页面：工具条上提示一下，点了才切（不抢你正在看的）。
  const [hint, setHint] = useState<string | null>(null);
  // 手动操作结束、站点的登录状态与已保存的不同时，问用户要不要保存
  const [loginOffer, setLoginOffer] = useState<{
    pageId: string;
    site: string;
  } | null>(null);
  const [savingLogin, setSavingLogin] = useState(false);

  const shownId = useRef<string | null>(null);
  shownId.current = page?.id ?? null;
  useEffect(
    () =>
      store?.onAgentUse((u) => {
        if (u.fresh && u.page.id !== shownId.current) setHint(u.page.id);
      }),
    [store],
  );

  const token = loadToken();
  /** 跑一个会改页面的请求：失败原因放到顶部提示里，成功返回数据。 */
  const run = async <T,>(call: () => Promise<Act<T>>): Promise<T | null> => {
    const r = await call();
    setProblem(r.ok ? null : r.message);
    return r.ok ? r.data : null;
  };

  const show = (p: PageView) => {
    patchTab({ page: p.id });
    setHint(null);
    setPagesOpen(false);
    if (p.state === "sleeping")
      void run(() => wakePage(token, workspaceId, p.id));
  };
  const openInNewTab = (p: PageView) => {
    setPagesOpen(false);
    layout.openTab(pane.pid, "web", { page: p.id });
    if (p.state === "sleeping")
      void run(() => wakePage(token, workspaceId, p.id));
  };
  const openAddress = async (target: string): Promise<string | null> => {
    const r = await openPage(token, workspaceId, target);
    if (!r.ok) return r.message;
    show(r.data.page);
    return null;
  };

  const toastFailure = (r: Act<unknown>) => {
    if (!r.ok) toast(r.message, { tone: "danger" });
  };
  /** 在用户自己的浏览器里打开转发出来的服务（新窗口；被拦截时把地址告诉用户）。 */
  const openInYourBrowser = (url: string, popup: Window | null) => {
    if (popup) {
      popup.opener = null;
      popup.location.href = url;
    } else toast(`浏览器拦截了新窗口，转发地址：${url}`, { tone: "info" });
  };
  /** 点「在本机浏览器打开」：还没转发就先转发；新窗口要在点击的同一刻开，等请求回来再开会被浏览器当成弹窗拦掉。 */
  const forwardOpen = async (row: PortRow) => {
    const blocked = forwardBlocked(window.location.protocol);
    if (blocked) return toast(blocked, { tone: "danger" });
    const popup = window.open("", "_blank");
    if (row.forward) {
      openInYourBrowser(forwardUrl(row.forward, window.location), popup);
      return;
    }
    const r = await forwards.open(row.target);
    if (!r.ok) {
      popup?.close();
      return toast(r.message, { tone: "danger" });
    }
    openInYourBrowser(forwardUrl(r.data, window.location), popup);
  };
  const forwardCopy = async (f: ForwardView) => {
    const blocked = forwardBlocked(window.location.protocol);
    if (blocked) return toast(blocked, { tone: "danger" });
    const url = forwardUrl(f, window.location);
    if (await copyText(url)) toast("已复制转发地址", { tone: "ok" });
    else toast(`复制失败，转发地址：${url}`, { tone: "danger" });
  };
  /** 手动添加转发：返回失败原因（给输入框下面的提示），成功返回 null；不自动打开窗口。 */
  const forwardAdd = async (target: string): Promise<string | null> => {
    const blocked = forwardBlocked(window.location.protocol);
    if (blocked) return blocked;
    const r = await forwards.open(target);
    return r.ok ? null : r.message;
  };

  // 手动操作结束（不管是点「交还」、点接管横幅，还是在聊天里答复）：站点的登录状态有变就问一句
  const handedBack = page !== null && state.handedBack.includes(page.id);
  const shownPage = page?.id ?? null;
  useEffect(() => {
    if (!handedBack || shownPage === null || !store?.takeHandback(shownPage))
      return;
    void getLoginOffer(token, workspaceId, shownPage).then((r) => {
      if (r.ok && r.data.offer && r.data.site)
        setLoginOffer({ pageId: shownPage, site: r.data.site });
    });
  }, [handedBack, shownPage, store, token, workspaceId]);
  /** 存页面所属站点的登录状态；返回失败原因，成功返回 null。 */
  const saveLoginOf = async (pageId: string): Promise<string | null> => {
    const r = await saveLogin(token, workspaceId, pageId);
    if (!r.ok) return r.message;
    setLoginOffer(null);
    toast(`已保存 ${r.data.site} 的登录状态`, { tone: "ok" });
    return null;
  };

  /** 页面挂着的 JS 对话框最先问（页面被它卡住）；其次是等你选文件的文件选择器；下载一次问一个，处理完再问下一个。 */
  const dialog = page?.dialog ?? null;
  const upload = page?.pendingUpload ?? null;
  const download = page?.pendingDownloads[0] ?? null;
  /** 弹窗里的动作：失败的原因用提示条弹出（弹窗可能随之关掉，留不住行内提示）。 */
  const downloadAct = async <T,>(
    call: () => Promise<Act<T>>,
    done: (data: T) => void,
  ): Promise<void> => {
    const r = await call();
    if (r.ok) done(r.data);
    else toast(r.message, { tone: "danger" });
  };

  const manual = page?.controller === "user";
  const canOperate =
    manual &&
    stream.operator &&
    page?.state === "active" &&
    stream.link === "live";

  const switchTo = async (mode: "user" | "agent") => {
    if (!page) return;
    setBusy(true);
    await run(() => setControl(token, workspaceId, page.id, mode));
    setBusy(false);
  };
  const wake = async () => {
    if (!page) return;
    setBusy(true);
    await run(() => wakePage(token, workspaceId, page.id));
    setBusy(false);
  };

  const main: MainAction | null = !page
    ? null
    : page.state === "sleeping"
      ? { label: "唤醒", busy, onClick: () => void wake() }
      : manual
        ? {
            label: page.userOpened ? "交给 agent" : "交还 agent",
            busy,
            onClick: () => void switchTo("agent"),
          }
        : { label: "手动操作", busy, onClick: () => void switchTo("user") };

  const hinted = state.pages.find((p) => p.id === hint);
  const sandbox = state.engine?.sandbox;
  const noEmoji = state.engine?.emojiFont === false;

  return (
    <div className="ws-wb">
      {sandbox && !sandbox.enabled && (
        <div className="ws-wb-strip">
          <InlineNotice tone="warn">
            浏览器沙盒没有启用：页面里的恶意内容更容易波及 Server 所在的环境。
            {sandbox.reason}
          </InlineNotice>
        </div>
      )}
      {noEmoji && (
        <div className="ws-wb-strip">
          <InlineNotice tone="warn">
            Server 所在的机器上没有彩色 emoji
            字体，页面里的表情会显示成方块（页面是那台机器上的浏览器画的）。
            Debian / Ubuntu 装 fonts-noto-color-emoji；没有 root 权限就把
            NotoColorEmoji.ttf 放进 Server 数据目录下的
            browser/home/.local/share/fonts/。装好后重启 Server 生效。
          </InlineNotice>
        </div>
      )}
      {problem && (
        <div className="ws-wb-strip">
          <InlineNotice tone="danger">{problem}</InlineNotice>
          <IconButton
            size="sm"
            label="关闭提示"
            icon={<CloseIcon size={12} />}
            onClick={() => setProblem(null)}
          />
        </div>
      )}
      {page?.handoffPending && (
        <HandoffBanner
          key={page.id}
          reason={page.handoffReason ?? ""}
          userHasIt={page.controller === "user"}
          onAnswer={async (reply) => {
            const r = await answerHandoff(token, workspaceId, page.id, reply);
            return r.ok ? null : r.message;
          }}
        />
      )}
      {page && loginOffer?.pageId === page.id && (
        <LoginStrip
          key={page.id}
          site={loginOffer.site}
          onSave={() => saveLoginOf(page.id)}
          onDismiss={() => setLoginOffer(null)}
        />
      )}

      <BrowserBar
        pageCount={state.pages.length}
        pagesOpen={pagesOpen}
        pagesButton={pagesButton}
        onTogglePages={() => setPagesOpen((v) => !v)}
        page={page}
        address={addressOf(page?.url ?? "", hostName)}
        manual={manual}
        canOperate={canOperate}
        nav={stream.send}
        consoleOpen={consoleOpen}
        onToggleConsole={() => {
          setConsoleOpen(!consoleOpen);
          saveView({ console: !consoleOpen });
        }}
        replayOpen={replayOpen}
        onToggleReplay={() => {
          setReplayOpen(!replayOpen);
          saveView({ replay: !replayOpen });
        }}
        saveLogin={
          manual && page?.state === "active"
            ? {
                busy: savingLogin,
                onClick: () => {
                  setSavingLogin(true);
                  void saveLoginOf(page.id).then((failed) => {
                    setSavingLogin(false);
                    setProblem(failed);
                  });
                },
              }
            : null
        }
        main={main}
        hint={
          hinted && hinted.id !== page?.id
            ? { name: pageName(hinted, hostName), onClick: () => show(hinted) }
            : null
        }
      />

      <Stage
        page={page}
        engine={state.engine}
        stream={stream}
        send={stream.send}
        canvas={canvas}
        thumb={thumb}
        tag={
          page?.inUseBy
            ? (titles.get(page.inUseBy) ?? page.inUseBy.slice(0, 8))
            : null
        }
        onRetryStream={stream.retry}
        onRetryEngine={() => void ensureEngine(token)}
        onOpenAddress={() => setPagesOpen(true)}
        onClearNotice={stream.clearNotice}
        hidden={replayOpen}
      />

      {replayOpen && (
        <ReplayView
          workspaceId={workspaceId}
          anchor={anchorSession}
          titles={titles}
        />
      )}

      {consoleOpen && page && !replayOpen && (
        <ConsoleDrawer
          workspaceId={workspaceId}
          pageId={page.id}
          live={stream.console}
          onClose={() => {
            setConsoleOpen(false);
            saveView({ console: false });
          }}
        />
      )}

      {page && dialog && (
        <DialogPrompt
          key={`${dialog.type}\n${dialog.message}`}
          item={dialog}
          url={page.url}
          onAnswer={(accept, text) =>
            downloadAct(
              () =>
                answerPageDialog(token, workspaceId, page.id, {
                  accept,
                  ...(text === undefined ? {} : { text }),
                }),
              () => {},
            )
          }
        />
      )}

      {page && !dialog && upload && (
        <UploadDialog
          key={upload.id}
          item={upload}
          onUpload={async (files) => {
            const r = await uploadPageFiles(
              token,
              workspaceId,
              page.id,
              upload.id,
              files,
            );
            if (!r.ok) toast(r.message, { tone: "danger" });
          }}
          onCancel={() =>
            downloadAct(
              () => cancelPageUpload(token, workspaceId, page.id, upload.id),
              () => {},
            )
          }
        />
      )}

      {page && !dialog && !upload && download && (
        <DownloadDialog
          key={download.id}
          item={download}
          more={page.pendingDownloads.length - 1}
          directories={directories}
          onSaveLocal={async () => {
            const r = await fetchPendingDownload(
              token,
              workspaceId,
              page.id,
              download.id,
            );
            if (r.ok) saveBlob(r.data, download.filename);
            else toast(r.message, { tone: "danger" });
          }}
          onPut={(directoryId) =>
            downloadAct(
              () =>
                putPendingDownload(
                  token,
                  workspaceId,
                  page.id,
                  download.id,
                  directoryId,
                ),
              (d) =>
                toast(`已放进「${d.directory}」：${d.name}`, { tone: "ok" }),
            )
          }
          onDiscard={() =>
            downloadAct(
              () =>
                discardPendingDownload(
                  token,
                  workspaceId,
                  page.id,
                  download.id,
                ),
              () => {},
            )
          }
        />
      )}

      <PagesPanel
        open={pagesOpen}
        onClose={() => setPagesOpen(false)}
        anchor={pagesButton}
        pages={state.pages}
        ports={ports}
        forwards={forwards.forwards}
        currentId={page?.id ?? null}
        anchorSession={anchorSession}
        titles={titles}
        runStates={runStates}
        hostName={hostName}
        onPick={show}
        onNewTab={openInNewTab}
        onClosePage={(p) => void run(() => closePage(token, workspaceId, p.id))}
        onOpen={openAddress}
        onForwardOpen={(row) => void forwardOpen(row)}
        onForwardCopy={(f) => void forwardCopy(f)}
        onForwardStop={(f) => void forwards.stop(f.id).then(toastFailure)}
        onForwardAdd={forwardAdd}
      />
    </div>
  );
}
