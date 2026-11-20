// HTML 文件的内嵌预览：自包含的单页（内联脚本与样式、CDN 上的脚本 / 样式 / 字体）直接在 iframe 里运行。
// sandbox 不给 allow-same-origin：页面是不透明源，读不到本应用存在浏览器里的令牌，也调不了带登录态的接口。
// 代价是 localStorage 之类要同源的能力不可用、相对路径的本地资源不加载——这类页面用「在浏览器中打开」。
const SANDBOX =
  "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox";

export function HtmlView({ html }: { html: string }) {
  return (
    <iframe
      className="ws-pv-html-frame"
      title="HTML 预览"
      sandbox={SANDBOX}
      srcDoc={html}
      referrerPolicy="no-referrer"
    />
  );
}
