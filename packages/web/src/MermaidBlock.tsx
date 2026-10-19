import { useEffect, useRef, useState } from "react";

// 点到图才加载 mermaid，主包不背它的体积。
let loading: Promise<typeof import("mermaid").default> | null = null;
const loadMermaid = () => {
  loading ??= import("mermaid").then(({ default: m }) => {
    m.initialize({
      startOnLoad: false,
      theme: "neutral",
      securityLevel: "strict",
      fontFamily: "var(--font-sans)",
    });
    return m;
  });
  return loading;
};

export function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const id = `mermaid-${Math.random().toString(36).slice(2, 11)}`;
    el.innerHTML = "";
    setError(null);
    loadMermaid()
      .then((m) => m.render(id, code))
      .then(({ svg }) => {
        if (el === ref.current) el.innerHTML = svg;
      })
      .catch((err: unknown) => {
        if (el === ref.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
  }, [code]);

  if (error) {
    return (
      <pre className="overflow-auto border border-acc/30 bg-acc/5 p-3 text-xs text-acc">
        Mermaid 渲染失败: {error}
      </pre>
    );
  }

  return (
    <div
      ref={ref}
      className="my-3 flex justify-center overflow-auto border border-line bg-panel p-4"
    />
  );
}
