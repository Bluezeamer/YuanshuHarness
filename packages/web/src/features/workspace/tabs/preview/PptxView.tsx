// 幻灯片预览：pptx-preview 把 pptx 拆成逐页 HTML 渲染，够看不够编辑。
// 两个坑（都踩过）：
// 1. 传给库的 height 会让它把 wrapper 固定成那个高度并内部滚动，于是只看到第一页、
//    下面全是空白——所以只给 width，让 wrapper 高度随所有页自然增长，由外层容器滚动；
// 2. 库把 wrapper 背景写死成纯黑，得用 CSS 覆盖回透明，不然出现黑边。
// 另外库按固定像素排版，这里按容器宽度整体缩放（zoom），窄窗格里不会被裁掉。
import { useEffect, useRef, useState } from "react";
import { InlineNotice } from "../../../../ui";

/** 画布逻辑宽度：库按它排版，再整体缩放适配。 */
const W = 960;

type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "failed" };

export function PptxView({ bytes }: { bytes: Uint8Array }) {
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [fit, setFit] = useState(1);

  // 量外层容器的宽度（不能量被 zoom 的子树，否则会自己喂自己）
  useEffect(() => {
    const outer = host.current?.closest(".ws-pv-ppt");
    if (!outer) return;
    const measure = () => {
      const w = outer.clientWidth - 40; // 去掉左右内边距
      if (w > 0) setFit(Math.min(1, w / W));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let alive = true;
    setPhase({ kind: "loading" });
    void (async () => {
      try {
        const m = await import("pptx-preview");
        if (!alive) return;
        el.replaceChildren();
        // 不传 height：wrapper 高度随全部页增长，外层滚动
        const previewer = m.init(el, { width: W, mode: "list" });
        const buf = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        await previewer.preview(buf);
        if (alive) setPhase({ kind: "ready" });
      } catch {
        if (alive) setPhase({ kind: "failed" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [bytes]);

  return (
    <div className="ws-pv-ppt">
      {phase.kind === "loading" && (
        <p className="ws-pv-note t-aux" role="status">
          正在解析幻灯片…
        </p>
      )}
      {phase.kind === "failed" && (
        <InlineNotice tone="danger" className="ws-pv-note-bad">
          这份幻灯片解析不了：可能已加密或已损坏。
        </InlineNotice>
      )}
      <div className="ws-pv-ppt-fit" style={{ zoom: fit }}>
        <div ref={host} className="ws-pv-ppt-body" />
      </div>
    </div>
  );
}
