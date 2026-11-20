// Word 预览：docx-preview 把 docx 渲染成 HTML/CSS（分页、页眉页脚、表格、图片都能还原）。
// docx-preview 体积不小，用到时才取，和 PdfView 取 pdf.js 的方式一致。
import { useEffect, useRef, useState } from "react";
import { InlineNotice } from "../../../../ui";

type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "failed" };

export function DocxView({ bytes }: { bytes: Uint8Array }) {
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let alive = true;
    setPhase({ kind: "loading" });
    void (async () => {
      try {
        const m = await import("docx-preview");
        if (!alive) return;
        el.replaceChildren();
        // 传 Blob 而不是 ArrayBuffer：库内部按 zip 解析，Blob 更省一次拷贝
        await m.renderAsync(
          new Blob([bytes as BlobPart], {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          }),
          el,
          undefined,
          {
            inWrapper: true,
            breakPages: true,
            ignoreLastRenderedPageBreak: true,
          },
        );
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
    <div className="ws-pv-doc">
      {phase.kind === "loading" && (
        <p className="ws-pv-note t-aux" role="status">
          正在解析文档…
        </p>
      )}
      {phase.kind === "failed" && (
        <InlineNotice tone="danger" className="ws-pv-note-bad">
          这个文档解析不了：可能已加密、已损坏，或是旧版 .doc 格式（请先另存为
          .docx）。
        </InlineNotice>
      )}
      <div ref={host} className="ws-pv-doc-body" />
    </div>
  );
}
