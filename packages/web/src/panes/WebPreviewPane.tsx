import { useEffect, useRef, useState } from "react";
import type { PaneProps } from "../layout/types";

export interface WebPreviewConfig {
  url: string;
}

// 划选提问的接口位：能读到所嵌页面的选区时回调。跨源页面读不到，不会触发。
export interface WebSelection {
  text: string;
  url: string;
}

// 地址栏里常直接写 localhost:3000 或 host:port，补上协议再解析；只放行 http / https。
const HTTP = "http:";

export function normalizeUrl(raw: string): URL | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `${HTTP}//${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

// 与 WebUI 同源的页面不能同时放开脚本和同源：内容能摘掉自己的 sandbox 并用 WebUI 的令牌。
// 其他源（如本机的开发服务器）需要同源能力才能正常跑，所以只在非同源时放开。
export const sandboxFor = (u: URL) =>
  u.origin === location.origin
    ? "allow-scripts allow-forms"
    : "allow-scripts allow-forms allow-same-origin allow-popups";

const btn =
  "grid size-6 place-items-center rounded-lg text-mute hover:bg-line2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-mute";

const icon = {
  "aria-hidden": true,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: "size-3.5",
};

// 超过这个时间还没 load，提示可能是对方不让嵌入或地址不可达。
export const SLOW_MS = 8000;

// 后退/前进只记地址栏发起的跳转：跨源页面内部的点击链接，外层看不到。
interface Hist {
  list: string[];
  pos: number;
}

export function WebPreviewPane({
  config,
  onUpdateConfig,
  onSelection,
}: PaneProps<WebPreviewConfig> & {
  onSelection?: (sel: WebSelection) => void;
}) {
  const [input, setInput] = useState(config.url);
  const [bad, setBad] = useState(false);
  // 重新加载靠换 key 重建 iframe
  const [reload, setReload] = useState(0);
  const [hist, setHist] = useState<Hist>({ list: [config.url], pos: 0 });
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const target = normalizeUrl(config.url);

  useEffect(() => setInput(config.url), [config.url]);
  // 地址被外部改掉（恢复布局、别处打开）时，历史从这里重新开始。
  useEffect(
    () =>
      setHist((h) =>
        h.list[h.pos] === config.url ? h : { list: [config.url], pos: 0 },
      ),
    [config.url],
  );
  // 每次换地址或重新加载都从“加载中”开始计时。
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload 只是触发器
  useEffect(() => {
    setLoaded(false);
    setSlow(false);
    if (!target) return;
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [target?.href, reload]);

  const goTo = (url: string, next: Hist) => {
    setHist(next);
    onUpdateConfig({ url });
  };
  const go = () => {
    const u = normalizeUrl(input);
    setBad(!u);
    if (!u) return;
    if (u.href === config.url) {
      setReload((n) => n + 1);
      return;
    }
    const list = [...hist.list.slice(0, hist.pos + 1), u.href];
    goTo(u.href, { list, pos: list.length - 1 });
  };
  const step = (d: -1 | 1) => {
    const pos = hist.pos + d;
    const url = hist.list[pos];
    if (url) goTo(url, { list: hist.list, pos });
  };

  const onLoad = () => {
    setLoaded(true);
    setSlow(false);
    if (!onSelection) return;
    // 跨源时 contentDocument 为 null 或抛错，此时没有选区可读。
    try {
      const doc = frameRef.current?.contentDocument;
      doc?.addEventListener("mouseup", () => {
        const text = doc.getSelection()?.toString().trim();
        if (text) onSelection({ text, url: config.url });
      });
    } catch {}
  };

  const loading = !!target && !loaded;
  return (
    <div className="flex h-full min-h-0 flex-col" data-web-pane>
      <form
        className={`relative flex items-center gap-2 border-b border-line bg-line2 px-2.5 py-1.5 ${loading ? "overflow-hidden after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:w-[30%] after:animate-[slide_1.4s_var(--ease)_infinite] after:bg-ok" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <button
          type="button"
          className={btn}
          aria-label="后退"
          disabled={hist.pos === 0}
          onClick={() => step(-1)}
        >
          <svg {...icon} aria-hidden="true">
            <path d="M10 3L5 8l5 5" />
          </svg>
        </button>
        <button
          type="button"
          className={btn}
          aria-label="前进"
          disabled={hist.pos >= hist.list.length - 1}
          onClick={() => step(1)}
        >
          <svg {...icon} aria-hidden="true">
            <path d="M6 3l5 5-5 5" />
          </svg>
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="地址"
          aria-invalid={bad}
          spellCheck={false}
          className={`min-w-0 flex-1 rounded-lg border bg-panel px-2.5 py-1 font-mono text-xs ${
            bad ? "border-danger" : "border-line"
          }`}
        />
        <button type="submit" className={btn} aria-label="打开或重新加载">
          <svg {...icon} aria-hidden="true">
            <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3" />
          </svg>
        </button>
        {target && (
          <a
            href={target.href}
            target="_blank"
            rel="noopener noreferrer"
            className={btn}
            title="在新标签打开"
          >
            <span className="sr-only">在新标签打开</span>
            <svg {...icon} aria-hidden="true">
              <path d="M9 3h4v4M13 3L7 9M11 9v3.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-7a.5.5 0 0 1 .5-.5H7" />
            </svg>
          </a>
        )}
      </form>
      {bad && (
        <p role="alert" className="px-3 py-1 text-xs text-danger">
          只能打开 http 或 https 地址
        </p>
      )}
      {target && (loaded || slow) && (
        <p
          role="status"
          className={`border-b border-line px-3 py-1 text-xs ${slow ? "text-warn-ink" : "text-mute"}`}
        >
          {slow
            ? "加载很久了：地址可能连不上，或对方禁止被嵌入。"
            : "页面空白或提示拒绝连接？对方可能禁止被嵌入（X-Frame-Options / CSP）。"}
          <a
            href={target.href}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 font-semibold text-accent-deep underline"
          >
            在新标签打开
          </a>
        </p>
      )}
      <div className="min-h-0 flex-1 bg-bg">
        {target ? (
          <iframe
            key={`${reload}:${target.href}`}
            ref={frameRef}
            src={target.href}
            sandbox={sandboxFor(target)}
            title="网页预览"
            referrerPolicy="no-referrer"
            onLoad={onLoad}
            className="size-full border-0 bg-panel"
          />
        ) : (
          <p className="p-4 text-xs text-mute">
            输入地址后回车。页面由浏览器直接加载，所以要浏览器能访问到；
            对方禁止嵌入（X-Frame-Options）时会显示空白，可在新标签打开。
          </p>
        )}
      </div>
    </div>
  );
}
