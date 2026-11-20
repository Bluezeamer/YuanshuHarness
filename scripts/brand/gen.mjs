#!/usr/bin/env node
// 生成元枢的标记与图标（确定性，无随机数）：node scripts/brand/gen.mjs
// 标记：一笔倾斜的椭圆轨道，笔头（圆）重、尾部收尖并散成几股飞白；中心留空。
// 意象取自「譬如北辰，居其所而众星共之」与「三十辐共一毂，当其无，有车之用」：枢是轴，也是毂中的空。
// 只有一套几何：16px 的 favicon 到 512px 的图标、横排 logo 都用它，靠缩放而不是换设计。
// 运行时用的写到 packages/web/public，设计稿（反白标记、横排 logo、宽幅横幅）写到 docs/brand。
// 横排 logo 与横幅标语的字形轮廓在同目录 text.json，由 outline.py 生成，改字标或标语才需要重跑它。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const PUBLIC = join(root, "packages/web/public");
const BRAND = join(root, "docs/brand");
const TXT = JSON.parse(readFileSync(join(here, "text.json"), "utf8"));

// 与 ui/tokens.css 的 --ink 同值；SVG 文件里引不了 CSS 变量
const INK = "#18181b";
const PAPER = "#f9f9fa";

const rad = (d) => (d * Math.PI) / 180;
const sm = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* ---------- 几何 ---------- */

const area = (p) => {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
};
// 统一绕向，nonzero 填充时重叠处才是并集
const upright = (p) => (area(p) < 0 ? p.slice().reverse() : p);

const blob = (cx, cy, r, ph = 0.6, wob = 0.02, n = 48) => {
  const p = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const k =
      1 + wob * (Math.sin(2 * a + ph) + 0.6 * Math.sin(3 * a + ph * 1.7));
    p.push([cx + r * k * Math.cos(a), cy + r * k * Math.sin(a)]);
  }
  return p;
};

// 倾斜的椭圆轨道（半轴 a、b，倾角 rot）：缺口中心在参数角 gc、宽 gw；
// 笔头是半径 w/2 的圆，之后宽度收到 wt，最后 uf 之后散成 lanes 股飞白丝（有最小宽度 HAIR，再细就看不见了）
function orbit({
  a,
  b,
  w,
  wt,
  rot,
  gc,
  gw,
  taper = 0.5,
  lanes = 3,
  uf = 0.58,
  ends = [1, 0.9, 0.96],
  gapMax = 2.6,
  HAIR = 2.4,
}) {
  const N = 240;
  const S = 360 - gw;
  const st = gc + gw / 2;
  const R = rad(rot);
  const rotp = (x, y) => [
    x * Math.cos(R) - y * Math.sin(R),
    x * Math.sin(R) + y * Math.cos(R),
  ];
  const ww = (t) => wt + (w - wt) * (1 - sm(taper, 1, t));
  const at = (t) => {
    const ph = rad(st + S * t);
    const c = rotp(a * Math.cos(ph), b * Math.sin(ph));
    const d = rotp(-a * Math.sin(ph), b * Math.cos(ph));
    const m = Math.hypot(d[0], d[1]);
    return { c, n: [d[1] / m, -d[0] / m] };
  };
  const band = (i0, i1, lo, hi, gap) => {
    const A = [];
    const B = [];
    for (let i = i0; i <= i1; i++) {
      const t = i / N;
      const { c, n } = at(t);
      const h = ww(t) / 2;
      const g = gap ? gap(t) / 2 : 0;
      let sl = lo * h + (lo > -1 ? g : 0);
      let sh = hi * h - (hi < 1 ? g : 0);
      if (gap && sh - sl < HAIR) {
        const m = (sl + sh) / 2;
        sl = m - HAIR / 2;
        sh = m + HAIR / 2;
      }
      A.push([c[0] + n[0] * sh, c[1] + n[1] * sh]);
      B.push([c[0] + n[0] * sl, c[1] + n[1] * sl]);
    }
    return [...A, ...B.reverse()];
  };
  const iu = Math.round(uf * N);
  const polys = [band(0, iu, -1, 1)];
  const gap = (t) => gapMax * sm(uf, uf + 0.2, t);
  for (let j = 0; j < lanes; j++) {
    polys.push(
      band(
        Math.max(0, iu - 4),
        Math.round((ends[j] ?? 1) * N),
        -1 + (2 * j) / lanes,
        -1 + (2 * (j + 1)) / lanes,
        gap,
      ),
    );
  }
  const h = at(0).c;
  polys.push(blob(h[0], h[1], w / 2));
  return polys.map(upright);
}

// 唯一的标记几何：笔头重、尾部散成三股飞白
const MARK = orbit({
  a: 130,
  b: 90,
  w: 42,
  wt: 4,
  rot: -28,
  gc: -35,
  gw: 62,
});

/* ---------- 定位与输出 ---------- */

// 按「有墨处」量范围：极细的飞白笔尾肉眼不可见，不能拿多边形顶点算包围盒
function inkCells(polys) {
  const cells = [];
  for (const p of polys) {
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1e9;
    let y1 = -1e9;
    for (const [x, y] of p) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    for (let x = Math.ceil(x0); x <= x1; x++) {
      for (let y = Math.ceil(y0); y <= y1; y++) {
        let inside = false;
        for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
          if (
            p[i][1] > y !== p[j][1] > y &&
            x <
              ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) +
                p[i][0]
          ) {
            inside = !inside;
          }
        }
        if (inside) cells.push([x, y]);
      }
    }
  }
  return cells;
}

const inkCache = new WeakMap();
function bbox(polys) {
  let cells = inkCache.get(polys);
  if (!cells) {
    cells = inkCells(polys);
    inkCache.set(polys, cells);
  }
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = -1e9;
  let y1 = -1e9;
  for (const [x, y] of cells) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return {
    w: x1 - x0,
    h: y1 - y0,
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    cells,
  };
}

// 把墨迹的外接框中心放到 (cx, cy)，长边缩放到 size
const fitBox = (polys, cx, cy, size) => {
  const b = bbox(polys);
  const s = size / Math.max(b.w, b.h);
  return (q) => [cx + (q[0] - b.cx) * s, cy + (q[1] - b.cy) * s];
};
// 墨迹中心放到 (cx, cy)，最远一点落在半径 rMax 内（maskable 的安全圆）
const fitSafe = (polys, cx, cy, rMax) => {
  const b = bbox(polys);
  let D = 0;
  for (const q of b.cells)
    D = Math.max(D, Math.hypot(q[0] - b.cx, q[1] - b.cy));
  const s = rMax / D;
  return (q) => [cx + (q[0] - b.cx) * s, cy + (q[1] - b.cy) * s];
};

const num = (v) => String(Math.round(v * 10) / 10);
const pathD = (polys, T) =>
  polys
    .map(
      (p) =>
        `M${p
          .map((q) => {
            const t = T(q);
            return `${num(t[0])} ${num(t[1])}`;
          })
          .join("L")}Z`,
    )
    .join("");
const svg = (viewBox, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><title>元枢</title>${body}</svg>\n`;
const write = (dir, name, s) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), s);
  console.log(`${dir.replace(`${root}/`, "")}/${name}`);
};

// 标记在自己的画布里居中；名称左侧不再做光学上移——实测上移后反而像浮在文字上方，
// 斜弧的墨偏左下，与外接框居中的中文基线读起来是同一条水平线。
const mark = (fill) =>
  svg(
    "0 0 256 256",
    `<path fill="${fill}" d="${pathD(MARK, fitBox(MARK, 128, 128, 240))}"/>`,
  );
const tile = (rx) =>
  `<rect width="512" height="512"${rx ? ` rx="${rx}"` : ""} fill="${INK}"/>`;

// 横排：标记 + 宋体「元枢」+ 英文小字
function lockup(reverse) {
  const ink = reverse ? PAPER : INK;
  const sub = reverse ? "#a1a1aa" : "#52525b";
  const cn = TXT.cn;
  const en = TXT.en;
  const cnS = 0.92;
  const enS = 0.135;
  const gap = 16;
  const cy = 100;
  const m = 168;
  const tx = 206;
  const cnH = (cn.bbox[3] - cn.bbox[1]) * cnS;
  const enH = (en.bbox[3] - en.bbox[1]) * enS;
  const top = cy - (cnH + gap + enH) / 2;
  const cnX = tx - cn.bbox[0] * cnS;
  const cnY = top - cn.bbox[1] * cnS;
  const enX = tx - en.bbox[0] * enS;
  const enY = top + cnH + gap - en.bbox[1] * enS;
  const w = Math.ceil(
    Math.max(cnX + cn.bbox[2] * cnS, enX + en.bbox[2] * enS) + 22,
  );
  const body =
    `<path fill="${ink}" d="${pathD(MARK, fitBox(MARK, 96, cy, m))}"/>` +
    `<path fill="${ink}" transform="translate(${num(cnX)} ${num(cnY)}) scale(${cnS})" d="${cn.d}"/>` +
    `<path fill="${sub}" transform="translate(${num(enX)} ${num(enY)}) scale(${enS})" d="${en.d}"/>`;
  return svg(`0 0 ${w} 200`, body);
}

// 宽幅横幅（README 头部）：标记 + 字标 | 两行标语；右侧一枚放大并被画布裁切的标记作底纹。
// 画布自带底色，所以在明暗两种页面背景上都成立；明暗各一版，README 用 <picture> 按主题切换。
function banner(reverse) {
  const ink = reverse ? PAPER : INK;
  const bg = reverse ? INK : PAPER;
  const sub = reverse ? "#a1a1aa" : "#52525b";
  const { cn, en, tag_cn: tagCn, tag_en: tagEn } = TXT;
  const H = 280;
  const cy = H / 2;
  const at = (t, s, x, top) =>
    `translate(${num(x - t.bbox[0] * s)} ${num(top - t.bbox[1] * s)}) scale(${s})`;
  const h = (t, s) => (t.bbox[3] - t.bbox[1]) * s;
  const w = (t, s) => (t.bbox[2] - t.bbox[0]) * s;

  const lockX = 244;
  const cnS = 1.15;
  const enS = 0.1645;
  const lockH = h(cn, cnS) + 20 + h(en, enS);
  const lockTop = cy - lockH / 2;
  const divX = lockX + w(cn, cnS) + 56;
  const tagX = divX + 56;
  const tcS = 0.46;
  const teS = 0.18;
  const tagH = h(tagCn, tcS) + 24 + h(tagEn, teS);
  const tagTop = cy - tagH / 2;

  const body =
    `<rect width="1280" height="${H}" rx="20" fill="${bg}"/>` +
    `<path fill="${ink}" fill-opacity="0.06" d="${pathD(MARK, fitBox(MARK, 1120, cy, 470))}"/>` +
    `<path fill="${ink}" d="${pathD(MARK, fitBox(MARK, 134, cy, 156))}"/>` +
    `<path fill="${ink}" transform="${at(cn, cnS, lockX, lockTop)}" d="${cn.d}"/>` +
    `<path fill="${sub}" transform="${at(en, enS, lockX, lockTop + h(cn, cnS) + 20)}" d="${en.d}"/>` +
    `<path stroke="${sub}" stroke-opacity="0.45" stroke-width="1.5" d="M${num(divX)} ${num(cy - 70)}V${num(cy + 70)}"/>` +
    `<path fill="${ink}" transform="${at(tagCn, tcS, tagX, tagTop)}" d="${tagCn.d}"/>` +
    `<path fill="${sub}" transform="${at(tagEn, teS, tagX, tagTop + h(tagCn, tcS) + 24)}" d="${tagEn.d}"/>`;
  return svg(`0 0 1280 ${H}`, body);
}

// 运行时：名称左侧的标记、PWA 图标（any / maskable）、浏览器标签的 favicon（标记铺满瓷砖）
write(PUBLIC, "mark.svg", mark(INK));
write(
  PUBLIC,
  "icon.svg",
  svg(
    "0 0 512 512",
    `${tile(112)}<path fill="${PAPER}" d="${pathD(MARK, fitBox(MARK, 256, 256, 360))}"/>`,
  ),
);
write(
  PUBLIC,
  "icon-maskable.svg",
  svg(
    "0 0 512 512",
    `${tile(0)}<path fill="${PAPER}" d="${pathD(MARK, fitSafe(MARK, 256, 256, 188))}"/>`,
  ),
);
write(
  PUBLIC,
  "favicon.svg",
  svg(
    "0 0 512 512",
    `${tile(100)}<path fill="${PAPER}" d="${pathD(MARK, fitBox(MARK, 256, 256, 450))}"/>`,
  ),
);

// 设计稿：反白标记、横排 logo、宽幅横幅（深底用反白版）
write(BRAND, "mark-reverse.svg", mark(PAPER));
write(BRAND, "logo.svg", lockup(false));
write(BRAND, "logo-reverse.svg", lockup(true));
write(BRAND, "banner.svg", banner(false));
write(BRAND, "banner-reverse.svg", banner(true));
