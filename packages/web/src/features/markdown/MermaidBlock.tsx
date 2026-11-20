// 围栏 mermaid 块卡片：块内预览 / 源码切换、复制、展开大画布。
// 流式期间只显示源码（半截图必然解析失败，而且会让画面闪）。
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../ui/Button";
import { copyText } from "../../ui/clipboard";
import { DiagramCanvas } from "./DiagramCanvas";
import { Mermaid } from "./Mermaid";

export function MermaidBlock({
  code,
  streaming = false,
}: {
  code: string;
  streaming?: boolean;
}) {
  const [view, setView] = useState<"preview" | "source">("preview");
  const [canvas, setCanvas] = useState(false);
  const [ready, setReady] = useState(false);
  const [clipped, setClipped] = useState(false);
  const [copied, setCopied] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  const onRendered = useCallback((svg: SVGSVGElement | null) => {
    setReady(svg !== null);
  }, []);

  // 画到一半的图和长图都只显示一部分，底部渐隐提示可以展开。
  // biome-ignore lint/correctness/useExhaustiveDependencies: ready/view 是测量触发信号
  useLayoutEffect(() => {
    const el = body.current;
    setClipped(el !== null && el.scrollHeight > el.clientHeight + 2);
  }, [ready, view]);

  const copy = async () => {
    if (!(await copyText(code))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  if (streaming) {
    return (
      <div className="md-block" data-block="mermaid">
        <div className="md-block-head">
          <span className="md-block-lang t-mono">mermaid · 生成中</span>
        </div>
        <pre className="md-block-src t-code">{code}</pre>
      </div>
    );
  }

  return (
    <div className="md-block" data-block="mermaid">
      <div className="md-block-head">
        <span className="md-block-lang t-mono">mermaid</span>
        <div className="md-block-acts">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={view === "preview"}
            onClick={() =>
              setView((v) => (v === "preview" ? "source" : "preview"))
            }
          >
            {view === "preview" ? "源码" : "预览"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={copied ? "已复制" : "复制源码"}
            title={copied ? "已复制" : "复制源码"}
            onClick={() => void copy()}
          >
            {copied ? "已复制" : "复制"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!ready}
            title={ready ? "放大查看" : "图表还没渲染好"}
            onClick={() => setCanvas(true)}
          >
            展开
          </Button>
        </div>
      </div>
      {view === "source" ? (
        <pre className="md-block-src t-code">{code}</pre>
      ) : (
        <div
          ref={body}
          className="md-mermaid-clamp"
          data-clip={clipped || undefined}
        >
          <Mermaid
            code={code}
            className="md-mermaid-inline"
            errorClassName="md-mermaid-err"
            onRendered={onRendered}
          />
        </div>
      )}
      {canvas && (
        <DiagramCanvas
          hostRef={body}
          code={code}
          onClose={() => setCanvas(false)}
        />
      )}
    </div>
  );
}
