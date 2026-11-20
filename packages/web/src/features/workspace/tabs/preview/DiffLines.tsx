// 逐行差异的显示（行号 + 增删标记）：保存冲突与画布的版本历史共用。行由 diffLines / trimDiff 算出。
import type { DiffLine } from "./diffLines";

export function DiffLines({ lines }: { lines: readonly DiffLine[] }) {
  return (
    <div className="ws-pv-diff t-mono">
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: 差异行按顺序排列且内容只读
          key={i}
          className="ws-pv-diff-line"
          data-kind={l.kind}
        >
          <span className="ws-pv-diff-n">{l.a ?? ""}</span>
          <span className="ws-pv-diff-n">{l.b ?? ""}</span>
          <span className="ws-pv-diff-t">
            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
            {l.text || " "}
          </span>
        </div>
      ))}
    </div>
  );
}
