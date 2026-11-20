// 行号视图：行号放在 data-n 里由 CSS 伪元素画，复制选区时不会带上行号。
export function CodeView({ text }: { text: string }) {
  // 末尾换行不多算一行
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <ol className="ws-pv-code t-code" aria-label="文件内容">
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 行号即身份，内容只读
        <li key={i} data-n={i + 1}>
          {l || " "}
        </li>
      ))}
    </ol>
  );
}
