// 对话正文与文件预览共用的 mermaid 渲染组件。
// 只负责「把源码渲染成 SVG」：样式与卡片外壳由调用方决定；
// 渲染期间保留上一张图，失败且没有旧图时才显示错误。
import { useEffect, useRef, useState } from "react";
import { cx } from "../../ui/cx";
import { InlineNotice } from "../../ui/InlineNotice";
import "./markdown.css";
import { mermaidErrorText, renderMermaid } from "./mermaidRuntime";

interface MermaidState {
  svg?: string;
  error?: string;
}

export function Mermaid({
  code,
  className,
  errorClassName,
  label = "Mermaid 图表",
  onRendered,
}: {
  code: string;
  /** 外层容器的上下文类（如 ch-mermaid / ws-pv-mermaid） */
  className: string;
  /** 失败提示的上下文类（如 ch-mermaid-err / ws-pv-mermaid-err） */
  errorClassName: string;
  label?: string;
  /** SVG 挂载/替换后回调（大画布需要拿到同一个节点） */
  onRendered?: (svg: SVGSVGElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<MermaidState>({});

  useEffect(() => {
    const src = code.trim();
    if (src === "") {
      setState({});
      return;
    }
    let alive = true;
    const width = ref.current?.clientWidth || 720;
    renderMermaid(src, width).then(
      ({ svg }) => {
        if (alive) setState({ svg });
      },
      (err: unknown) => {
        if (!alive) return;
        // 旧图还在就继续显示旧图，避免图突然消失。
        setState((prev) =>
          prev.svg ? prev : { error: mermaidErrorText(err) },
        );
      },
    );
    return () => {
      alive = false;
    };
  }, [code]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: state.svg 只是“图已更新”的触发信号
  useEffect(() => {
    onRendered?.(ref.current?.querySelector("svg") ?? null);
  }, [state.svg, onRendered]);

  if (state.error && !state.svg)
    return (
      <InlineNotice
        tone="danger"
        className={cx("md-mermaid-err", errorClassName)}
      >
        图表渲染失败：{state.error}
      </InlineNotice>
    );

  return (
    <div
      ref={ref}
      className={cx(
        "md-mermaid",
        className,
        state.svg ? undefined : "is-loading",
      )}
      role="img"
      aria-label={label}
      // mermaid 输出已经过 DOMPurify（securityLevel: strict）清洗。
      {...(state.svg ? { dangerouslySetInnerHTML: { __html: state.svg } } : {})}
    />
  );
}
