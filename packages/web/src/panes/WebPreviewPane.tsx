import { useEffect, useState } from "react";
import type { PaneProps } from "../layout/types";

export interface WebPreviewConfig {
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
  "grid size-6 place-items-center rounded-lg text-mute hover:bg-line2 hover:text-ink";

export function WebPreviewPane({
  config,
  onUpdateConfig,
}: PaneProps<WebPreviewConfig>) {
  const [input, setInput] = useState(config.url);
  const [bad, setBad] = useState(false);
  // 重新加载靠换 key 重建 iframe
  const [reload, setReload] = useState(0);
  const target = normalizeUrl(config.url);

  useEffect(() => setInput(config.url), [config.url]);

  const go = () => {
    const u = normalizeUrl(input);
    setBad(!u);
    if (!u) return;
    if (u.href === config.url) setReload((n) => n + 1);
    else onUpdateConfig({ url: u.href });
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-web-pane>
      <form
        className="flex items-center gap-2 border-b border-line bg-line2 px-2.5 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
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
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            className="size-3.5"
          >
            <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3" />
          </svg>
        </button>
      </form>
      {bad && (
        <p role="alert" className="px-3 py-1 text-xs text-danger">
          只能打开 http 或 https 地址
        </p>
      )}
      <div className="min-h-0 flex-1 bg-bg">
        {target ? (
          <iframe
            key={reload}
            src={target.href}
            sandbox={sandboxFor(target)}
            title="网页预览"
            referrerPolicy="no-referrer"
            className="size-full border-0 bg-panel"
          />
        ) : (
          <p className="p-4 text-xs text-mute">
            输入地址后回车。页面由浏览器直接加载，所以要浏览器能访问到；
            对方禁止嵌入（X-Frame-Options）时会显示空白。
          </p>
        )}
      </div>
    </div>
  );
}
