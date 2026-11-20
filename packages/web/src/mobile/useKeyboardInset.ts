import { useEffect } from "react";

// 软键盘兜底：viewport 里写了 interactive-widget=resizes-content 的浏览器（Chrome 108+）键盘一弹布局视口就缩小，
// 输入框在文档流里自然被顶上来，这里量出来是 0；不认这个设置的浏览器只缩 visual viewport，
// 键盘高度 = 布局高度 − visualViewport 的高度 − 它的顶部偏移，写到 --m-kb 给根容器当底部内边距。
// 同时监听 resize 与 scroll；用户在捏合缩放（scale > 1）时按 0，免得把页面顶坏。
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      const kb =
        vv.scale > 1.01
          ? 0
          : Math.max(
              0,
              Math.round(root.clientHeight - vv.height - vv.offsetTop),
            );
      root.style.setProperty("--m-kb", `${kb}px`);
      // 键盘弹出后补一次滚到底：聚焦的输入框要看得见
      if (kb > 0) document.activeElement?.scrollIntoView({ block: "nearest" });
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--m-kb");
    };
  }, []);
}
