// 目录结构审计：整页的 DOM 自洽。迁移自 win.audit.cjs
// （重复 id / 重复标签面板 / 无名按钮 / 运行时错误 / 窗格·标签计数 / 主机色）。
// mock 里的 data-od-id 属原型的设计稿标注，真实栈没有，改查真实的 id 与 data-pid / data-tid。

import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { panesOf } from "../model/l2";
import { endDrag } from "./drag";
import { mount, panesIn, qa } from "./harness";

const errors = vi.spyOn(console, "error");

beforeEach(() => errors.mockClear());
afterEach(() => {
  act(() => endDrag());
  cleanup();
});

const dups = (xs: (string | undefined)[]) => {
  const n = new Map<string, number>();
  for (const x of xs) if (x) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].filter(([, c]) => c > 1).map(([k]) => k);
};

/** 多开一个窗口，让整页尽量复杂 */
async function busyPage() {
  const m = await mount();
  await act(async () => void m.store.addWindow());
  return m;
}

test("多窗口的整页：没有重复 id、重复窗格、重复标签，也没有无名按钮", async () => {
  await busyPage();
  expect(dups(qa("[id]").map((e) => e.id))).toEqual([]);
  expect(dups(panesIn().map((p) => p.dataset.pid))).toEqual([]);
  expect(dups(qa(".ws-pn-tab").map((t) => t.dataset.tid))).toEqual([]);
  // 标签面板一个窗格只渲染当前标签，所以每个窗格恰好一个，且 id 不重复
  const panels = qa('[role="tabpanel"]');
  expect(panels).toHaveLength(panesIn().length);
  expect(dups(panels.map((p) => p.dataset.tid))).toEqual([]);

  const unnamed = qa("button").filter(
    (b) =>
      !(b.textContent ?? "").trim() &&
      !b.getAttribute("aria-label") &&
      !b.getAttribute("title"),
  );
  expect(unnamed.map((b) => b.outerHTML.slice(0, 80))).toEqual([]);
});

test("整页文本里没有 undefined / NaN；渲染过程没有 console.error", async () => {
  await busyPage();
  const text = document.body.textContent ?? "";
  expect(text).not.toMatch(/undefined|NaN/);
  expect(errors).not.toHaveBeenCalled();
});

test("窗格、标签的数量与文档一致；有主机的窗格带主机色，对话窗格不带", async () => {
  const { store } = await busyPage();
  const st = store.getState().doc.windows;
  const win = st.list[st.active];
  if (!win) throw new Error("没有当前窗口");
  const shown = panesOf(win);
  expect(panesIn()).toHaveLength(shown.length);
  expect(qa(".ws-pn-tab")).toHaveLength(
    shown.reduce((n, p) => n + p.tabs.length, 0),
  );

  for (const p of panesIn()) {
    const tone = p.style.getPropertyValue("--tone");
    if (p.dataset.host) expect(tone).toMatch(/^var\(--h[1-6]\)$/);
    else expect(tone).toBe("");
  }
});
