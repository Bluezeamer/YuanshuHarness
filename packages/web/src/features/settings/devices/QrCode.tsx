import qrcode from "qrcode-generator";

const QUIET = 4;

/** 文本 → 二维码的方格矩阵（true = 深色）。容错 M，版本按内容长度自动选 */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => qr.isDark(r, c)),
  );
}

/** 深色方格合成一条路径：每个方格一段 `M x y h1 v1 h-1 z`，相邻的不合并（几百个而已） */
export function qrPath(modules: boolean[][]): string {
  let d = "";
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    });
  });
  return d;
}

// 二维码：白底（--surface）深色（--ink），四周留 4 格静区（扫码器要求）。尺寸由外层的 width / height 定。
export function QrCode({ text, label }: { text: string; label: string }) {
  const modules = qrModules(text);
  const size = modules.length + QUIET * 2;
  return (
    <svg
      className="st-dv-qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="var(--surface)" />
      <path d={qrPath(modules)} fill="var(--ink)" />
    </svg>
  );
}
