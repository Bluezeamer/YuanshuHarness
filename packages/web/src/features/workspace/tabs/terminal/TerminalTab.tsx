import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { subscribeFontSize } from "../../../../app/fontSize";
import { InlineNotice } from "../../../../ui";
import { useLayoutState } from "../../layoutContext";
import { useTabZoomScale } from "../tabZoom";
import { TerminalLink } from "./link";
import { StatePanel } from "./StatePanel";
import { readFont, readPx, readTheme } from "./theme";
import "./terminal.css";
import "./xterm-base.css";
import type { LinkState, TerminalTabExtra, TerminalTabProps } from "./types";
import { environmentOf } from "./types";

// xterm 体积大，用到时才取；构建产物里它只在这块懒加载 chunk 里。
const loadXterm = () =>
  Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);

function statusText(s: LinkState): string {
  switch (s.kind) {
    case "connecting":
      return s.stage === "creating" ? "正在创建" : "正在接回";
    case "live":
      return "已连接";
    case "reconnecting":
      return `连接中断，重连 ${s.attempt}/${s.max}`;
    case "lost":
      return "连接已断开";
    case "ended":
      return "已结束";
    case "failed":
      return "无法打开";
  }
}

// 复制：有选区时 Ctrl/Cmd+C 复制（否则仍是 SIGINT），Ctrl+Shift+C 始终复制。
// 粘贴交给 xterm 自带的 paste 事件，bracketed paste 也由它处理。
function copyKey(x: Terminal, e: KeyboardEvent): boolean {
  if (e.type !== "keydown" || e.key.toLowerCase() !== "c") return true;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || !(e.shiftKey || x.hasSelection())) return true;
  const text = x.getSelection();
  if (text) void navigator.clipboard?.writeText(text);
  x.clearSelection();
  return false;
}

/**
 * 终端标签内容。挂载时：有 termId 且未结束 → 按 id 接回并回放；没有 termId → 首次创建；
 * 接回遇到 404 → 标记 termEnded，展示已结束态，绝不静默新建 shell。
 * 卸载只断开连接，不杀终端；杀终端发生在关闭标签时（见 close.tsx）。
 */
// 终端字号 = 代码档字号 × 标签比例，取到半个像素（xterm 画在 canvas 上，认不得 CSS 变量，要自己乘）
const fontPx = (root: HTMLElement, zoom: number) =>
  Math.round(readPx(root, "--fs-code", 14) * zoom * 2) / 2;

export function TerminalTab({
  tab,
  sessionId,
  active,
  patchTab,
  onManage,
}: TerminalTabProps & TerminalTabExtra) {
  const workspaceId = useLayoutState((s) => s.workspaceId);
  const rootRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState<LinkState>(() =>
    tab.termId && tab.termEnded
      ? { kind: "ended", reason: "gone", exitCode: null }
      : { kind: "connecting", stage: tab.termId ? "attaching" : "creating" },
  );
  const linkRef = useRef<TerminalLink | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  // 回调与 props 放 ref：连接 effect 只随挂载点重跑，不因它们换身份而重连。
  const latest = useRef({ tab, sessionId, workspaceId, patchTab });
  latest.current = { tab, sessionId, workspaceId, patchTab };
  const activeRef = useRef(active);
  activeRef.current = active;
  // Ctrl+滚轮的标签比例（layout/TabBody 提供）
  const zoom = useTabZoomScale();
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // 比例变了：同步字号并重新 fit（终端还没建好时，建的时候会读到当前比例）
  useEffect(() => {
    const term = termRef.current;
    const root = rootRef.current;
    if (!term || !root) return;
    term.options.fontSize = fontPx(root, zoom);
    fitRef.current?.();
  }, [zoom]);

  // 切到前台时补一次 fit（后台时容器可能是 0 尺寸）并聚焦。
  useEffect(() => {
    if (!active) return;
    fitRef.current?.();
    termRef.current?.focus();
  }, [active]);

  useEffect(() => {
    const root = rootRef.current;
    if (!box || !root) return;
    let disposed = false;
    let x: Terminal | null = null;
    let ro: ResizeObserver | null = null;
    let frame = 0;
    let unsubFont: (() => void) | null = null;

    void loadXterm().then(([{ Terminal }, { FitAddon }]) => {
      if (disposed) return;
      const term = new Terminal({
        cursorBlink: true,
        scrollback: 5000,
        minimumContrastRatio: 4.5,
        fontFamily: readFont(root),
        // 终端是等宽阅读面，跟代码档走；--fs-code 由界面字号设置写到根元素（兜底 14px）
        fontSize: fontPx(root, zoomRef.current),
        theme: readTheme(root),
      });
      const fit: FitAddon = new FitAddon();
      term.loadAddon(fit);
      term.open(box);
      x = term;
      termRef.current = term;

      // 非前台时不 fit：display:none 下量出的尺寸是 0，会把终端缩成一行。
      const doFit = () => {
        if (!activeRef.current || !box.clientWidth || !box.clientHeight) return;
        try {
          fit.fit();
        } catch {
          // 容器尚未布局完成，下一次 resize 再来
        }
      };
      fitRef.current = doFit;
      doFit();

      const link = new TerminalLink({
        target: () => ({
          termId: latest.current.tab.termId,
          termEnded: latest.current.tab.termEnded ?? false,
          environmentId: environmentOf(latest.current.tab.host),
          cwd: latest.current.tab.cwd,
          sessionId: latest.current.sessionId,
          workspaceId: latest.current.workspaceId,
        }),
        size: () => ({ cols: term.cols, rows: term.rows }),
        patch: (p) => latest.current.patchTab(p),
        write: (d) => term.write(d),
        reset: () => term.reset(),
        onState: setState,
      });
      linkRef.current = link;
      term.onData((d) => link.input(d));
      term.onResize(({ cols, rows }) => link.resize(cols, rows));
      term.attachCustomKeyEventHandler((e) => copyKey(term, e));

      ro = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(doFit);
      });
      ro.observe(box);
      // xterm 画在 canvas 上，吃不到 CSS 变量的热更新：字号一变就同步 options 再重算列宽行高。
      // 后台时 doFit 会跳过，切回前台那一次 fit 用的就是新字号。
      unsubFont = subscribeFontSize(() => {
        term.options.fontSize = fontPx(root, zoomRef.current);
        doFit();
      });
      link.start();
      if (activeRef.current) term.focus();
    });

    return () => {
      disposed = true;
      unsubFont?.();
      cancelAnimationFrame(frame);
      ro?.disconnect();
      linkRef.current?.dispose();
      linkRef.current = null;
      fitRef.current = null;
      termRef.current = null;
      x?.dispose();
    };
  }, [box]);

  const env = tab.host && tab.host !== "server" ? tab.host : "本机";
  const where = tab.cwd ? `${env} · ${tab.cwd}` : env;
  // 平时终端占满窗格、没有任何条；只有连接中 / 重连时顶上浮一行提示（浮着不占位，免得屏幕随它跳动）
  const connecting =
    state.kind === "connecting" || state.kind === "reconnecting";
  const covered =
    state.kind === "ended" || state.kind === "lost" || state.kind === "failed";

  return (
    <section
      ref={rootRef}
      className="ws-term"
      aria-label={`终端 ${where}`}
      data-state={state.kind}
    >
      <div className="ws-term-body">
        <div ref={setBox} className="ws-term-screen" />
        {connecting && (
          <InlineNotice
            tone={state.kind === "connecting" ? "info" : "warn"}
            className="ws-term-note"
          >
            {statusText(state)}
          </InlineNotice>
        )}
        {covered && (
          <StatePanel
            state={state}
            tab={tab}
            onReopen={() => linkRef.current?.reopen()}
            onRetry={() => linkRef.current?.retry()}
            onManage={onManage}
          />
        )}
      </div>
    </section>
  );
}
