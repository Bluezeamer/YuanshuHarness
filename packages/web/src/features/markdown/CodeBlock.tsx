// 围栏代码块卡片：语言标签 + 行号 + 换行开关 + 复制；语法高亮异步加载，缺失时退回纯文本。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../ui/Button";
import { copyText } from "../../ui/clipboard";
import { cx } from "../../ui/cx";
import { highlightedLines } from "./codeHighlight";

function Row({ n, html, text }: { n: number; html?: string; text?: string }) {
  const body = useRef<HTMLSpanElement>(null);
  // 高亮片段由 highlight.js 生成、文本已转义；直接交给 DOM，避免 React 逐节点 diff。
  useLayoutEffect(() => {
    if (body.current && html !== undefined) body.current.innerHTML = html;
  }, [html]);
  return (
    <div className="md-code-line">
      <span className="md-code-n" aria-hidden="true">
        {n}
      </span>
      {html !== undefined ? (
        <span ref={body} className="md-code-t" />
      ) : (
        <span className="md-code-t">{text}</span>
      )}
    </div>
  );
}

export function CodeBlock({
  code,
  lang,
  streaming = false,
  follow = false,
}: {
  code: string;
  lang: string;
  streaming?: boolean;
  /** 流式写入时自动滚到尾部，让用户始终看到最新内容 */
  follow?: boolean;
}) {
  const [wrap, setWrap] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [lines, setLines] = useState<string[] | null>(null);
  const plain = useMemo(() => code.replace(/\n$/, "").split("\n"), [code]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: code 变化（流式追加）是滚到底的触发信号
  useLayoutEffect(() => {
    if (!follow || !body.current) return;
    body.current.scrollTop = body.current.scrollHeight;
  }, [follow, code]);

  useEffect(() => {
    setLines(null);
    if (streaming) return;
    let alive = true;
    highlightedLines(code, lang).then(
      (out) => {
        if (alive && out) setLines(out);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [code, lang, streaming]);

  const copy = async () => {
    if (!(await copyText(code.replace(/\n$/, "")))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="md-block" data-block="code">
      <div className="md-block-head">
        <span className="md-block-lang t-mono">{lang.toLowerCase()}</span>
        <div className="md-block-acts">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={wrap}
            title={wrap ? "切换为不自动换行" : "切换为自动换行"}
            onClick={() => setWrap((v) => !v)}
          >
            {wrap ? "换行" : "不换行"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={copied ? "已复制" : "复制代码"}
            title={copied ? "已复制" : "复制代码"}
            onClick={() => void copy()}
          >
            {copied ? "已复制" : "复制"}
          </Button>
        </div>
      </div>
      <div
        ref={body}
        className={cx("md-code-body t-code", !wrap && "is-nowrap")}
      >
        {lines
          ? lines.map((html, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 行号即身份，内容只随源码整体变化
              <Row key={i} n={i + 1} html={html} />
            ))
          : plain.map((text, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 行号即身份，内容只随源码整体变化
              <Row key={i} n={i + 1} text={text} />
            ))}
      </div>
    </div>
  );
}
