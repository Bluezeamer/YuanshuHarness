// 文件预览标签：头部（文件、路径、类型标签、主机、复制路径、下载）+ 按类型渲染的内容。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readDownload } from "../../../../api/files";
import { loadToken } from "../../../../api/http";
import { environmentIdOf } from "../../../../app/shell/hosts";
import {
  Button,
  Empty,
  IconButton,
  InlineNotice,
  saveBlob,
  toast,
} from "../../../../ui";
import { CopyIcon } from "../../../../ui/icons";
import { useFsWatch } from "../../../chat";
import type { ImageBase } from "../../../markdown/imageRef";
import { useLayoutStore } from "../../layoutContext";
import { parentOf, sizeText } from "../files/paths";
import type { TabRenderProps } from "../registry";
import { useTabView } from "../useTabView";
import { BarSlotsProvider } from "./BarSlots";
import { dropFileDraft } from "./fileDraft";
import { HtmlInBrowser } from "./HtmlInBrowser";
import { HtmlView } from "./HtmlView";
import { ImageView } from "./ImageView";
import { baseName, FAIL, kindLabel } from "./kind";
import { MarkdownView } from "./MarkdownView";
import { isMarkdownPath, saveMdImages } from "./mdImages";
import { PdfView } from "./PdfView";
import { isRich, RichView } from "./renderers";
import { SvgPreview } from "./SvgPreview";
import { TextView } from "./TextView";
import { type PreviewState, usePreview } from "./usePreview";
import { type PreviewView, parsePreviewView } from "./viewState";
import { canvasRootOf, resolveWikilink } from "./wikilinks";

// 自己保存后这么久之内收到的变更认为是自己的写入，不弹「已被改动」
const OWN_SAVE_MS = 2000;

// 工具条上的文件信息：类型，知道体积的再加体积（完整路径在悬停提示里）
function metaText(path: string, state: PreviewState): string {
  const label = kindLabel(path, state.kind);
  const size =
    "total" in state && state.kind !== "too_large"
      ? ` · ${sizeText(state.total)}`
      : "";
  return `${label}${size}`;
}

export function PreviewTab({ tab, pane, sessionId, patchTab }: TabRenderProps) {
  const [lead, setLead] = useState<HTMLElement | null>(null);
  const [tail, setTail] = useState<HTMLElement | null>(null);
  const host = tab.host ?? "server";
  const env = environmentIdOf(host);
  const path = tab.path ?? "";
  const { state, retry, applySaved } = usePreview(env, path);
  // 窗格切走会卸载：预览 / 编辑模式与编辑器的光标、滚动位置存浏览器本地，切回来还原（文件对得上才恢复）
  const { initial: savedView, save: saveView } = useTabView(
    tab.id,
    parsePreviewView,
  );
  const view = useRef<PreviewView>(
    savedView?.at === path
      ? savedView
      : { at: path, mode: "edit", caret: 0, top: 0 },
  );
  const [restore] = useState(() =>
    savedView?.at === path
      ? {
          mode: savedView.mode,
          view: { caret: savedView.caret, top: savedView.top },
        }
      : null,
  );
  const onViewState = useCallback(
    (
      patch:
        | { mode: "preview" | "edit" }
        | { view: { caret: number; top: number } },
    ) => {
      const cur: PreviewView =
        view.current.at === path
          ? view.current
          : { at: path, mode: "edit", caret: 0, top: 0 };
      view.current =
        "mode" in patch
          ? { ...cur, mode: patch.mode }
          : { ...cur, caret: patch.view.caret, top: patch.view.top };
      saveView(view.current);
    },
    [path, saveView],
  );
  const layout = useLayoutStore();
  // 笔记在 .canvas/ 里时，正文里的 [[链接]] 可点：画布开成画布标签，笔记开成预览
  const wiki = canvasRootOf(path);
  const wikiRoot = wiki?.root;
  const wikiDir = wiki?.dir;
  const onWikilink = useCallback(
    (target: string) => {
      if (wikiRoot === undefined || wikiDir === undefined) return;
      const to = resolveWikilink(wikiRoot, target);
      if (to.kind === "canvas")
        layout.openTab(pane.pid, "canvas", {
          host,
          path: wikiDir,
          canvas: to.board,
        });
      else layout.openFilePreview(pane.pid, tab.id, host, to.abs);
    },
    [layout, pane.pid, tab.id, host, wikiRoot, wikiDir],
  );
  // 文档里的相对图片地址相对这个 md 所在目录
  const imageBase = useMemo<ImageBase>(
    () => ({ kind: "file", env, dir: parentOf(path) }),
    [env, path],
  );
  // md 里粘贴 / 拖入图片：存到旁边的 <名>.assets/，插入相对路径链接
  const onFiles = useMemo(
    () =>
      isMarkdownPath(path)
        ? async (files: File[], via: "paste" | "drop") => {
            const r = await saveMdImages(env, path, files, via, sessionId);
            if (!r.ok) {
              toast(`图片没能存下来：${r.why}`, { tone: "danger" });
              return null;
            }
            return r.text;
          }
        : undefined,
    [env, path, sessionId],
  );
  const [busy, setBusy] = useState(false);
  // 有限感知刷新：只订阅这个文件本身，agent 改了它（或别处改了）就重取。
  // 编辑中不重取（会把用户没保存的内容顶掉），改为提示「已被别处改动」。
  // 有未保存改动时才不允许自动重载（会把用户内容顶掉）；只是打开着不叫「在编辑」
  const [dirty, setDirty] = useState(false);
  const [moved, setMoved] = useState(false);
  const savedAt = useRef(0);
  const watchPaths = useMemo(() => [path], [path]);
  const fsRev = useFsWatch(sessionId ?? undefined, env, watchPaths);
  // 每个版本号只处理一次：effect 依赖里还有 editing / retry，不记住处理过的版本
  // 就会在每次渲染重复重取（曾因此把浏览器卡死）。
  const handledRev = useRef(0);
  useEffect(() => {
    if (fsRev === handledRev.current) return;
    handledRev.current = fsRev;
    // 自己刚保存引起的变更不算「别处改动」，不打扰
    if (Date.now() - savedAt.current < OWN_SAVE_MS) return;
    if (!dirty) {
      retry();
      return;
    }
    // 有未保存改动：不能替换内容，只提示
    setMoved(true);
  }, [fsRev, dirty, retry]);
  // 换文件时清掉过期提示
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换文件时复位
  useEffect(() => {
    setMoved(false);
    handledRev.current = 0;
  }, [path]);
  const body = useRef<HTMLDivElement>(null);

  // 换文件时回到顶部
  // biome-ignore lint/correctness/useExhaustiveDependencies: 路径变化才需要复位
  useEffect(() => {
    body.current?.scrollTo?.(0, 0);
  }, [path]);

  if (!path)
    return (
      <div className="ws-pv">
        <Empty
          title="没有选择文件"
          description="在文件管理器里点一个文件，这里显示它的内容。"
        />
      </div>
    );

  const truncated =
    (state.kind === "text" ||
      state.kind === "markdown" ||
      state.kind === "json") &&
    state.shown < state.total;

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      toast("已复制路径", { tone: "ok" });
    } catch {
      toast("无法写入剪贴板", { tone: "warn" });
    }
  };
  const download = async () => {
    setBusy(true);
    const r = await readDownload(loadToken(), env, path);
    setBusy(false);
    if (r.ok) saveBlob(r.data, baseName(path));
    else toast(`下载失败：${FAIL[r.kind]}`, { tone: "danger" });
  };

  return (
    <BarSlotsProvider value={{ lead, tail }}>
      <div className="ws-pv" data-kind={state.kind}>
        <div className="ws-pv-bar">
          <div className="ws-pv-lead" ref={setLead} />
          {state.kind !== "loading" && state.kind !== "error" && (
            <span className="ws-pv-meta t-aux" title={path}>
              {metaText(path, state)}
            </span>
          )}
          <span className="ws-pv-gap" />
          <IconButton
            label="复制路径"
            icon={<CopyIcon size={13} />}
            onClick={copyPath}
          />
          <Button variant="ghost" size="sm" loading={busy} onClick={download}>
            下载
          </Button>
          <div className="ws-pv-tail" ref={setTail} />
        </div>

        {moved && (
          <InlineNotice tone="warn" className="ws-pv-note-bar">
            磁盘上的文件已被改动；你正在编辑，没有自动替换内容。
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setMoved(false);
                dropFileDraft(env, path);
                retry();
              }}
            >
              放弃编辑并重载
            </Button>
          </InlineNotice>
        )}

        {truncated && (
          <InlineNotice tone="warn" className="ws-pv-note-bar">
            已截断：文件共 {sizeText(state.total)}，只显示前{" "}
            {sizeText(state.shown)}。完整内容请下载。
          </InlineNotice>
        )}

        <div className="ws-pv-body" ref={body}>
          {state.kind === "loading" && (
            <p className="ws-pv-note t-aux" role="status">
              正在读取…
            </p>
          )}
          {state.kind === "error" && (
            <Empty
              tone="danger"
              title="无法预览"
              description={FAIL[state.failure]}
              action={
                <Button size="sm" onClick={retry}>
                  重试
                </Button>
              }
            />
          )}
          {(state.kind === "text" ||
            state.kind === "json" ||
            state.kind === "markdown" ||
            state.kind === "svg") && (
            <TextView
              env={env}
              path={path}
              text={state.text}
              base={{ mtimeMs: state.mtimeMs, sha256: state.sha256 }}
              editable={state.editable}
              onDirtyChange={(d) => {
                setDirty(d);
                // 开始编辑的文件不能再被下一次单击换掉：自动固定
                if (d && tab.temp) patchTab({ temp: undefined });
              }}
              restore={restore}
              onViewState={onViewState}
              {...(state.kind === "markdown" && onFiles ? { onFiles } : {})}
              onSaved={(next) => {
                savedAt.current = Date.now();
                // 保存后立刻把内容灌回预览态：否则切回预览还是旧内容，得关掉重开才更新
                applySaved(next);
              }}
              {...(state.kind === "markdown"
                ? {
                    rendered: (
                      <MarkdownView
                        text={state.text}
                        imageBase={imageBase}
                        {...(wiki ? { onWikilink } : {})}
                      />
                    ),
                  }
                : state.kind === "svg"
                  ? { rendered: <SvgPreview text={state.text} /> }
                  : {})}
            />
          )}
          {state.kind === "html" && (
            <TextView
              env={env}
              path={path}
              text={state.html}
              base={{ mtimeMs: state.mtimeMs, sha256: state.sha256 }}
              editable={state.editable}
              rendered={
                <>
                  <HtmlView html={state.html} />
                  <HtmlInBrowser host={host} path={path} fromPid={pane.pid} />
                </>
              }
            />
          )}
          {state.kind === "image" && (
            <ImageView src={state.url} alt={baseName(path)} />
          )}
          {state.kind === "pdf" && <PdfView bytes={state.bytes} />}
          {isRich(state) && (
            <RichView
              state={state}
              path={path}
              busy={busy}
              onDownload={() => void download()}
            />
          )}
          {state.kind === "binary" && (
            <Empty
              title="二进制文件"
              description={`${state.contentType || "未知类型"} · ${sizeText(state.total)}，不能在这里显示，可以下载后查看。`}
              action={
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy}
                  onClick={download}
                >
                  下载
                </Button>
              }
            />
          )}
        </div>
      </div>
    </BarSlotsProvider>
  );
}
