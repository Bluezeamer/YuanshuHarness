// AuditPane 组件测试的共用装置（只被 *.test.tsx 引用，不进产物）：
// 假 ResizeObserver、持有 afx 的宿主（行为同 store.patchAfx：浅合并，undefined 删键）、api 假实现的接线。
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { CallCompaction, CallRecord } from "../../../api/calls";
import { clearToasts } from "../../../ui";
import type { TabAfx } from "../../workspace/model/types";
import { AuditPane } from "./AuditPane";
import { api } from "./fakeapi";
import { fakeServer, ok, sample } from "./testkit";

// ── ResizeObserver：observe 时立刻汇报当前宽度，resizeTo 模拟容器变宽 / 变窄 ──
type Cb = (entries: { contentRect: { width: number } }[]) => void;
let boxW = 900;
let observers: Cb[] = [];

class FakeRO {
  constructor(private cb: Cb) {}
  observe() {
    observers.push(this.cb);
    this.cb([{ contentRect: { width: boxW } }]);
  }
  disconnect() {
    observers = observers.filter((o) => o !== this.cb);
  }
}

export function installBox(width: number) {
  boxW = width;
  observers = [];
  vi.stubGlobal("ResizeObserver", FakeRO);
}

export function resizeTo(width: number) {
  boxW = width;
  act(() => {
    for (const o of observers) o([{ contentRect: { width } }]);
  });
}

// ── 数据 ──
export function installStore(
  store: Record<string, CallRecord[]>,
  compactions: CallCompaction[] = [],
) {
  const fake = fakeServer(() => store);
  api.listCalls.mockImplementation(fake.list);
  api.listSubagentCalls.mockImplementation(fake.listSubs);
  api.getCall.mockImplementation(fake.get);
  api.getCompactions.mockResolvedValue(ok(compactions));
}

// ── 宿主 ──
export const latest: { afx: TabAfx | undefined } = { afx: undefined };

function merge(base: TabAfx | undefined, patch: Partial<TabAfx>): TabAfx {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as TabAfx;
}

function Host({ sid, init }: { sid: string; init?: TabAfx | undefined }) {
  const [afx, setAfx] = useState<TabAfx | undefined>(init);
  latest.afx = afx;
  return (
    <AuditPane
      sessionId={sid}
      afx={afx}
      patchAfx={(patch) => setAfx((a) => merge(a, patch))}
    />
  );
}

export function mount(sid = "s1", init?: TabAfx) {
  latest.afx = init;
  const r = render(<Host sid={sid} init={init} />);
  return {
    ...r,
    switchTo: (next: string) => r.rerender(<Host sid={next} init={init} />),
  };
}

export const rows = (root: ParentNode = document) => [
  ...root.querySelectorAll<HTMLElement>("[data-call]"),
];
export const seqs = () =>
  rows().map((r) => r.dataset.call?.replace("s1-c", ""));

// ── 每个测试文件顶层调用一次：默认 900px 宽、s1 是 11 条的样例会话 ──
export function setupEnv() {
  beforeEach(() => {
    sessionStorage.clear();
    installBox(900);
    installStore({ s1: sample("s1") });
  });
  afterEach(() => {
    cleanup();
    clearToasts();
    vi.unstubAllGlobals();
    for (const f of Object.values(api)) f.mockReset();
    Reflect.deleteProperty(navigator, "clipboard");
  });
}

// 类型下拉：打开、读各档位的数字、选一档
const typeSelect = () =>
  screen.getByRole("combobox", { name: "按调用类型筛选" });
/** 当前档位名（触发器上显示的字） */
export const filterShown = () => typeSelect().textContent ?? "";
/** 各档位的数字：{全部: 11, 用户: 2, …}；读完关掉下拉 */
export function filterCounts(): Record<string, number> {
  fireEvent.click(typeSelect());
  const out: Record<string, number> = {};
  for (const o of screen.getAllByRole("option")) {
    const n = o.querySelector(".u-option-hint")?.textContent ?? "";
    const label = o.querySelector(".u-option-t")?.textContent ?? "";
    out[label] = Number(n);
  }
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  return out;
}
/** 选一档：label 是档位名，如「子代理」 */
export function pickFilter(label: string) {
  fireEvent.click(typeSelect());
  const hit = screen
    .getAllByRole("option")
    .find((o) => o.querySelector(".u-option-t")?.textContent === label);
  if (!hit) throw new Error(`没有「${label}」这一档`);
  fireEvent.click(hit);
}
export const row = (seq: number) =>
  document.querySelector<HTMLElement>(
    `[data-call="s1-c${seq}"]`,
  ) as HTMLElement;
/** 行是不是当前选中的那条（aria-current 在行里的主按钮上） */
export const isCurrent = (r: HTMLElement) =>
  r.querySelector(".u-lrow-main")?.getAttribute("aria-current") === "true";
/** 点一行：点击要落在行里的主按钮上 */
export const clickRow = (r: HTMLElement) =>
  fireEvent.click(r.querySelector(".u-lrow-main") as HTMLElement);
/** 行的第二行灰字（触发 · 入 · 耗时） */
export const subOf = (r: HTMLElement) =>
  r.querySelector(".u-lrow-sub")?.textContent ?? "";
export const labelOf = (r: HTMLElement) =>
  r.querySelector(".u-lrow-label")?.textContent ?? "";
/** 按标题取结构视图里的一张卡片 */
export const sec = (title: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(".au-sec")].find(
    (x) => x.querySelector(".au-sec-t")?.textContent === title,
  );
export const sections = () => [
  ...document.querySelectorAll<HTMLElement>(".au-sec"),
];
// 选中的最新一条（调用 11）的详情已载入
export const loaded = async () => {
  await screen.findByText("调用 11");
  await waitFor(() => expect(document.querySelector(".au-sec")).toBeTruthy());
};
export const search = (v: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "搜索调用记录" }), {
    target: { value: v },
  });
