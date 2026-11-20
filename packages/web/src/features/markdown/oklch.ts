// oklch ↔ sRGB 的少量换算：mermaid 的颜色引擎（khroma）只认具体色值，
// 设计令牌却是 oklch，所以渲染前要把令牌换算成 hex。
// 换算用的是 OKLab ←→ linear sRGB 的标准矩阵（Björn Ottosson 的公开推导）。

export interface Oklch {
  /** 明度 0–1 */
  l: number;
  /** 彩度 */
  c: number;
  /** 色相角（度） */
  h: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 解析 `oklch(L C H)`（也接受百分号写法）；不是该格式返回 null。 */
export function parseOklch(value: string): Oklch | null {
  const m = /^oklch\(\s*(.+?)\s*\)$/i.exec(value.trim());
  if (!m?.[1]) return null;
  const parts = m[1].split(/\s+/);
  if (parts.length < 3) return null;
  const num = (raw: string, scale = 1): number | null => {
    const pct = raw.endsWith("%");
    const n = Number(pct ? raw.slice(0, -1) : raw);
    return Number.isFinite(n) ? n / (pct ? scale : 1) : null;
  };
  const l = num(parts[0] as string, 100);
  const c = num(parts[1] as string, 100);
  const h = num(parts[2] as string);
  if (l === null || c === null || h === null) return null;
  return { l, c, h };
}

function toLab({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  return [l, c * Math.cos(rad), c * Math.sin(rad)];
}

function labToHex([L, a, b]: [number, number, number]): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const gamma = (x: number) => {
    const v = clamp01(x);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  const hex = lin
    .map((x) =>
      Math.round(gamma(x) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
  return `#${hex}`;
}

/** oklch → `#rrggbb`（超出 sRGB 的通道按边界裁剪）。 */
export function oklchToHex(color: Oklch): string {
  return labToHex(toLab(color));
}

/** 两色按 t（0–1）在 OKLab 空间混合；用于生成 soft 底色这类派生色。 */
export function mixOklch(a: Oklch, b: Oklch, t: number): Oklch {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  const lerp = (x: number, y: number) => x + (y - x) * t;
  const lab: [number, number, number] = [
    lerp(l1, l2),
    lerp(a1, a2),
    lerp(b1, b2),
  ];
  const l = lab[0];
  const c = Math.hypot(lab[1], lab[2]);
  const h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  return { l, c, h: h < 0 ? h + 360 : h };
}
