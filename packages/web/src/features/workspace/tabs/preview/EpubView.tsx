// 电子书预览：epubjs 负责解包与分页，这里给一个能翻页的阅读框，不做书签/批注。
// epubjs 需要一个确定的视口尺寸，所以按固定画布渲染再按容器宽度整体缩放；
// 翻页用两侧按钮（分页流下键盘/滚轮由库自己接管）。
import { useEffect, useRef, useState } from "react";
import { IconButton, InlineNotice } from "../../../../ui";
import { BackIcon, ChevronRightIcon } from "../../../../ui/icons";

const W = 800;
const H = 620;

type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "failed" };

interface Rendition {
  display(): Promise<void>;
  prev(): Promise<void>;
  next(): Promise<void>;
}

export function EpubView({ bytes }: { bytes: Uint8Array }) {
  const host = useRef<HTMLDivElement>(null);
  const rendition = useRef<Rendition | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [fit, setFit] = useState(1);
  const [at, setAt] = useState("");

  useEffect(() => {
    const el = host.current?.parentElement;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth - 20;
      if (w > 0) setFit(Math.min(1, w / W));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let alive = true;
    let book: { destroy(): void } | null = null;
    setPhase({ kind: "loading" });
    void (async () => {
      try {
        const { default: ePub } = await import("epubjs");
        if (!alive) return;
        el.replaceChildren();
        const buf = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        const b = ePub(buf);
        book = b;
        const r = b.renderTo(el, { width: W, height: H });
        rendition.current = r as unknown as Rendition;
        // 翻页后更新页码提示（epubjs 的 relocated 事件给出当前位置）
        (
          r as unknown as {
            on(
              e: string,
              cb: (loc: { start?: { displayed?: unknown } }) => void,
            ): void;
          }
        ).on("relocated", (loc) => {
          const page = loc.start?.displayed;
          if (typeof page === "object" && page) {
            const p = page as { page?: number; total?: number };
            if (typeof p.page === "number")
              setAt(`第 ${p.page}${p.total ? ` / ${p.total}` : ""} 页`);
          }
        });
        await r.display();
        if (alive) setPhase({ kind: "ready" });
      } catch {
        if (alive) setPhase({ kind: "failed" });
      }
    })();
    return () => {
      alive = false;
      rendition.current = null;
      book?.destroy();
    };
  }, [bytes]);

  const turn = (dir: "prev" | "next") => {
    const r = rendition.current;
    if (!r) return;
    void (dir === "prev" ? r.prev() : r.next());
  };

  return (
    <div className="ws-pv-epub">
      {phase.kind === "failed" ? (
        <InlineNotice tone="danger" className="ws-pv-note-bad">
          这本电子书打不开：可能不是标准 epub。
        </InlineNotice>
      ) : (
        <>
          <div className="ws-pv-epub-bar">
            <IconButton
              label="上一页"
              icon={<BackIcon size={13} />}
              onClick={() => turn("prev")}
            />
            <span className="ws-pv-epub-at t-aux">{at || "正在打开…"}</span>
            <IconButton
              label="下一页"
              icon={<ChevronRightIcon size={13} />}
              onClick={() => turn("next")}
            />
          </div>
          <div className="ws-pv-epub-fit" style={{ zoom: fit }}>
            <div ref={host} className="ws-pv-epub-body" />
          </div>
        </>
      )}
    </div>
  );
}
