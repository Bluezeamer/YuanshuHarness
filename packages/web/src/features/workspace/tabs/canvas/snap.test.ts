import { expect, test } from "vitest";
import {
  type Rect,
  SNAP_PX,
  snapBox,
  snapResize,
  snapToCards,
  unionRect,
} from "./snap";

const r = (x: number, y: number, w = 100, h = 60): Rect => ({ x, y, w, h });

test("贴齐别的卡片的边：左边差 4 画布单位（缩放 1，阈值 6）→ 挪过去；参考线在那条边上，范围罩住两张卡", () => {
  const out = snapToCards(r(204, 300), [r(200, 0)], 1);
  expect(out.dx).toBe(-4);
  expect(out.dy).toBe(0);
  expect(out.guides).toEqual([{ axis: "x", at: 200, from: 0, to: 360 }]);
});

test("中线与右边也算：被拖的中线贴别人的中线、被拖的右边贴别人的左边；横竖两个方向各自吸，可以同时", () => {
  // 被拖 x 中线 = 254、别人中线 = 250 → dx -4；被拖 y 底边 = 176、别人顶边 = 180 → dy +4
  const out = snapToCards(r(204, 116), [r(200, 180)], 1);
  expect(out.dx).toBe(-4);
  expect(out.dy).toBe(4);
  expect(out.guides.map((g) => g.axis).sort()).toEqual(["x", "y"]);
  // 右边贴左边
  expect(snapToCards(r(97, 0), [r(200, 300)], 1).dx).toBe(3);
});

test("阈值是屏幕像素：缩放 0.5 时 6 像素 = 12 画布单位；缩放 2 时 = 3 画布单位", () => {
  expect(snapToCards(r(210, 300), [r(200, 0)], 0.5).dx).toBe(-10);
  expect(snapToCards(r(210, 300), [r(200, 0)], 1).dx).toBe(0);
  expect(snapToCards(r(203, 300), [r(200, 0)], 2).dx).toBe(-3);
  expect(snapToCards(r(204, 300), [r(200, 0)], 2).dx).toBe(0);
  expect(SNAP_PX).toBe(6);
});

test("没有够近的就不动（dx、dy 为 0、没有参考线），这时位置留给网格；多张里取最近的一条线", () => {
  const far = snapToCards(r(500, 500), [r(0, 0)], 1);
  expect(far).toEqual({ dx: 0, dy: 0, guides: [] });
  // 两条候选：差 5 与差 2，取差 2
  expect(snapToCards(r(202, 300), [r(197, 0), r(200, 400)], 1).dx).toBe(-2);
  // 没有别的卡片
  expect(snapToCards(r(1, 1), [], 1)).toEqual({ dx: 0, dy: 0, guides: [] });
});

test("参考线只连上与这条线对齐的卡片：另一张不在这条线上的不进范围", () => {
  const out = snapToCards(r(203, 500), [r(200, 0), r(600, 200)], 1);
  expect(out.guides).toEqual([{ axis: "x", at: 200, from: 0, to: 560 }]);
});

test("unionRect：多张一起拖时的外框", () => {
  expect(unionRect([r(0, 0), r(150, 100)])).toEqual({
    x: 0,
    y: 0,
    w: 250,
    h: 160,
  });
});

test("snapBox：贴上卡片的方向用卡片线，没贴上的方向落到 8 单位网格；Alt 之外的流程里网格也由这里负责（库的 snapToGrid 关了）", () => {
  // 横向贴上别人的左边（差 5），纵向离得远 → y 落到网格（203 → 200）
  const a = snapBox(r(195, 203), [r(200, 600)], 1);
  expect(a.dx).toBe(5);
  expect(a.dy).toBe(-3);
  expect(a.guides.map((g) => g.axis)).toEqual(["x"]);
  // 都没贴上：两个方向都落网格
  const b = snapBox(r(1003, 1005), [r(0, 0)], 1);
  expect([b.dx, b.dy]).toEqual([-3, 3]);
  expect(b.guides).toEqual([]);
  // 已经在网格上：不动
  expect(snapBox(r(800, 400), [], 1)).toEqual({ dx: 0, dy: 0, guides: [] });
});

// ── 缩放 ──
const OPTS = { minW: 160, minH: 72, keepAspect: false };
/** 缩放开始时的矩形：x 0..200、y 0..120 */
const START = r(0, 0, 200, 120);

test("缩放·右边：拖到离别人的左边 4 单位内 → 贴上（宽度跟着变、左边不动）；参考线在那条边上", () => {
  const next = r(0, 0, 296, 120);
  const out = snapResize(START, next, [r(300, 400)], 1, OPTS);
  expect(out.rect).toEqual({ x: 0, y: 0, w: 300, h: 120 });
  // 别人 y 在 400..460：线的范围罩住这张（0..120）和它
  expect(out.guides).toEqual([{ axis: "x", at: 300, from: 0, to: 460 }]);
});

test("缩放·左边：贴上之后右边不动、宽度变（x 变、x + w 不变）；上边同理", () => {
  const next = r(96, 0, 104, 120);
  const out = snapResize(START, next, [r(100, 400)], 1, OPTS);
  // 左边从 96 贴到 100：右边仍是 200，宽度 100 小于最小宽度 160，所以不吸，留给库给的
  expect(out.rect).toEqual(next);
  const wide = snapResize(
    r(0, 0, 400, 120),
    r(96, 0, 304, 120),
    [r(100, 400)],
    1,
    OPTS,
  );
  expect(wide.rect).toEqual({ x: 100, y: 0, w: 300, h: 120 });
  const top = snapResize(
    r(0, 0, 200, 300),
    r(0, 96, 200, 204),
    [r(500, 100)],
    1,
    OPTS,
  );
  expect(top.rect).toEqual({ x: 0, y: 100, w: 200, h: 200 });
});

test("缩放·中线也算：右边贴别人的中线；被拖的是边，不是中线", () => {
  // 别人 x 200..300，中线 250；右边从 247 贴到 250
  const out = snapResize(
    START,
    r(0, 0, 247, 120),
    [r(200, 400, 100, 60)],
    1,
    OPTS,
  );
  expect(out.rect.w).toBe(250);
});

test("缩放·角：横竖两个方向各吸各的，可以同时；各出一条参考线", () => {
  const out = snapResize(
    START,
    r(0, 0, 297, 176),
    [r(300, 180, 100, 60)],
    1,
    OPTS,
  );
  expect(out.rect).toEqual({ x: 0, y: 0, w: 300, h: 180 });
  expect(out.guides.map((g) => g.axis).sort()).toEqual(["x", "y"]);
});

test("缩放·没贴上卡片的那条边落到 8 单位网格；没动的方向保持原样（不会被拉到网格上）", () => {
  const out = snapResize(
    r(3, 5, 200, 120),
    r(3, 5, 237, 120),
    [r(900, 900)],
    1,
    OPTS,
  );
  // 右边 240 在网格上；y 方向没动，h 与 y 原样（5、120 都不是网格点，也不动）
  expect(out.rect).toEqual({ x: 3, y: 5, w: 237, h: 120 });
  const off = snapResize(START, r(0, 0, 237, 120), [r(900, 900)], 1, OPTS);
  expect(off.rect.w).toBe(240);
  expect(off.guides).toEqual([]);
});

test("缩放·阈值是屏幕像素：缩放 2 时 6 像素 = 3 单位", () => {
  expect(
    snapResize(START, r(0, 0, 296, 120), [r(300, 400)], 2, OPTS).guides,
  ).toEqual([]);
  expect(
    snapResize(START, r(0, 0, 298, 120), [r(300, 400)], 2, OPTS).rect.w,
  ).toBe(300);
});

test("缩放·吸完会比最小尺寸还小就不吸（宽度 160、高度 72）：既不贴卡片，也不落网格", () => {
  // 右边在 162，别人的左边在 156（差 6）：贴上去宽度 156 < 160，所以什么都不吸
  const out = snapResize(
    r(0, 0, 160, 120),
    r(0, 0, 162, 120),
    [r(156, 400)],
    1,
    OPTS,
  );
  expect(out.rect.w).toBe(162);
  expect(out.guides).toEqual([]);
});

test("缩放·什么边都没动：原样返回", () => {
  expect(snapResize(START, START, [r(300, 0)], 1, OPTS)).toEqual({
    rect: START,
    guides: [],
  });
});

test("缩放·比例锁定：右边贴上卡片，高度按比例跟（上边不动）；贴不上卡片就不动，也不吸网格", () => {
  const lock = { ...OPTS, keepAspect: true };
  // 比例 2:1；右边 296 贴到 300 → 宽 300、高 150
  const out = snapResize(
    r(0, 0, 200, 100),
    r(0, 0, 296, 148),
    [r(300, 600)],
    1,
    lock,
  );
  expect(out.rect).toEqual({ x: 0, y: 0, w: 300, h: 300 / (296 / 148) });
  expect(out.guides).toHaveLength(1);
  const far = snapResize(
    r(0, 0, 200, 100),
    r(0, 0, 237, 118.5),
    [r(900, 900)],
    1,
    lock,
  );
  expect(far).toEqual({ rect: r(0, 0, 237, 118.5), guides: [] });
});

test("缩放·比例锁定：左上角拖动时对侧（右下）不动；下边贴上卡片，宽度按比例跟", () => {
  const lock = { ...OPTS, keepAspect: true };
  // 开始 100..300 × 100..200（2:1），左上角拖到 (96, 98)：w = 204、h = 102
  const out = snapResize(
    r(100, 100, 200, 100),
    r(96, 98, 204, 102),
    [r(900, 96)],
    1,
    lock,
  );
  // 顶边 98 与别人顶边 96 差 2：贴上 → 高 104、宽 208，右下角仍是 (300, 200)
  expect(out.rect).toEqual({ x: 92, y: 96, w: 208, h: 104 });
});
