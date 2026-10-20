import { useEffect, useState } from "react";
import { loadToken } from "../api";
import { type Mode, type PreviewResult, previewPrompt } from "./agentsApi";

const PART_KIND: Record<string, string> = {
  block: "块",
  "global-file": "全局约定文件",
  "project-file": "项目约定文件",
  mode: "模式",
};

// 实时预览拼接结果：用编辑器里未保存的块列表与模式请求服务端，输入停顿后再发。
export function PromptPreview({
  promptBlocks,
  mode,
  onUnauthorized,
}: {
  promptBlocks: string[];
  mode: Mode;
  onUnauthorized(): void;
}) {
  const [r, setR] = useState<PreviewResult | "loading" | "failed">("loading");
  const key = promptBlocks.join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: key 是 promptBlocks 的稳定摘要
  useEffect(() => {
    let live = true;
    setR("loading");
    const t = setTimeout(() => {
      void previewPrompt(loadToken(), { promptBlocks, mode }).then((res) => {
        if (!live) return;
        if (!res.ok && res.kind === "unauthorized") onUnauthorized();
        setR(res.ok ? res.data : "failed");
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, mode, onUnauthorized]);

  if (r === "loading") return <p className="m-0 text-mute">预览生成中…</p>;
  if (r === "failed")
    return (
      <p role="alert" className="m-0 font-semibold text-acc">
        预览失败，请检查所选块是否仍存在
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-xs text-mute">共 {r.chars} 字符</p>
      <ol
        aria-label="拼接顺序"
        className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs"
      >
        {r.parts.map((p, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: 同一个块可被重复引用，片段列表是只读展示
            key={`${p.kind}:${p.id ?? p.name}:${i}`}
            className="flex justify-between gap-2 border-b border-line2 py-0.5"
          >
            <span>
              <span className="text-mute">{p.group} · </span>
              {p.name}
              <span className="text-mute">
                {" "}
                ({PART_KIND[p.kind] ?? p.kind})
              </span>
            </span>
            <span className="font-mono text-mute">{p.chars}</span>
          </li>
        ))}
      </ol>
      <pre className="m-0 max-h-[320px] overflow-auto whitespace-pre-wrap break-words border border-line bg-panel p-3 font-mono text-xs">
        {r.text || "（空）"}
      </pre>
    </div>
  );
}
