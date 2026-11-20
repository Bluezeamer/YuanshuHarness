// 组件测试夹具：挂载内存 API 的布局 store + L2View，以及拖放事件的小工具。
// 只被 *.test.tsx 引用；jsdom 没有布局，落点判定靠给元素桩一个 getBoundingClientRect。

import { act, createEvent, fireEvent, render } from "@testing-library/react";
import { LayoutProvider, type RunState } from "../layoutContext";
import type { Directory } from "../model/l2";
import type { LayoutDoc } from "../model/layoutDoc";
import { createLayoutStore, type SessionBrief } from "../store/layoutStore";
import { TerminalGuardProvider } from "../tabs/terminal/wiring";
import { L2View } from "./L2View";

export const HOSTS = [
  { id: "server", name: "Server" },
  { id: "gpu", name: "GPU 机" },
];

export const SESSIONS: SessionBrief[] = [
  { id: "a", updatedAt: "2026-01-04T00:00:00.000Z", archived: false },
  { id: "b", updatedAt: "2026-01-03T00:00:00.000Z", archived: false },
  { id: "c", updatedAt: "2026-01-02T00:00:00.000Z", archived: false },
  { id: "d", updatedAt: "2026-01-01T00:00:00.000Z", archived: false },
];

/** 工作区 a 的两台主机：server 的 /w，与 gpu 的 /g */
export const DIRS: Directory[] = [
  { host: "server", path: "/w" },
  { host: "gpu", path: "/g" },
];

/** 与 DIRS 同序的目录 id 与名称（「放进哪个目录」的选项） */
export const DIR_CHOICES = [
  { id: "d-server", name: "w" },
  { id: "d-gpu", name: "g" },
];

export interface Mounted {
  store: ReturnType<typeof createLayoutStore>;
  notes: [string, string][];
}

/**
 * 载入布局并渲染当前工作区的 L2。
 * 不传 initial：空文档，由 store 按目录与会话列表补默认窗口。
 * 传了 initial：原样还原（模拟刷新）。
 */
export async function mount(
  initial?: {
    revision: number;
    document: LayoutDoc;
  },
  titles?: ReadonlyMap<string, string>,
  runStates?: ReadonlyMap<string, RunState>,
): Promise<Mounted> {
  const notes: [string, string][] = [];
  const store = createLayoutStore({
    api: {
      get: async () => ({
        ok: true,
        data: initial ?? { revision: 0, document: null },
      }),
      put: async (_id, rev) => ({ ok: true, revision: rev + 1 }),
    },
    debounceMs: 10_000,
    hostName: (id) => HOSTS.find((h) => h.id === id)?.name ?? id,
    notify: (m, t) => notes.push([m, t]),
  });
  render(
    <LayoutProvider
      store={store}
      workspaceId="ws1"
      directories={DIRS}
      directoryChoices={DIR_CHOICES}
      sessions={SESSIONS}
      hosts={HOSTS}
      {...(titles ? { titles } : {})}
      {...(runStates ? { runStates } : {})}
    >
      <TerminalGuardProvider>
        <L2View />
      </TerminalGuardProvider>
    </LayoutProvider>,
  );
  await act(async () => {
    await store.setWorkspace("ws1");
  });
  return { store, notes };
}

export const q = <T extends HTMLElement = HTMLElement>(
  sel: string,
  root: ParentNode = document,
) => root.querySelector<T>(sel);
export const qa = <T extends HTMLElement = HTMLElement>(
  sel: string,
  root: ParentNode = document,
) => Array.from(root.querySelectorAll<T>(sel));

export const panesIn = (root: ParentNode = document) => qa(".ws-pane", root);
export const paneByHost = (host: string, root: ParentNode = document) =>
  q(`.ws-pane[data-host="${host}"]`, root) as HTMLElement;
export const tabsIn = (pane: HTMLElement) => qa(".ws-pn-tab", pane);

/** 给元素桩一个固定盒子（左上角在原点） */
export function rect<T extends HTMLElement>(
  el: T,
  width = 1000,
  height = 700,
): T {
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
  return el;
}

const dt = () => ({ setData() {}, dropEffect: "", effectAllowed: "" });

type DragType = "dragStart" | "dragEnd" | "dragOver" | "drop";

/**
 * jsdom 没有 DragEvent：testing-library 退回普通 Event，init 里的 clientX/clientY 会丢，
 * 所以坐标要手动挂到事件对象上（React 的合成事件从原生事件读它们）。返回值 = 事件未被取消。
 */
function fireDrag(type: DragType, el: Element, x = 0, y = 0): boolean {
  const ev = createEvent[type](el, { dataTransfer: dt() });
  Object.defineProperty(ev, "clientX", { value: x });
  Object.defineProperty(ev, "clientY", { value: y });
  return fireEvent(el, ev);
}

export const dragStart = (el: Element) => fireDrag("dragStart", el);
export const dragEnd = (el: Element) => fireDrag("dragEnd", el);
export const drop = (el: Element, x: number, y: number) =>
  fireDrag("drop", el, x, y);

/** dragover 并返回「落点是否接受」（组件对接受的 dragover 会 preventDefault） */
export function over(
  el: HTMLElement,
  x: number,
  y: number,
  size?: [number, number],
): boolean {
  rect(el, ...(size ?? [1000, 700]));
  return !fireDrag("dragOver", el, x, y);
}
