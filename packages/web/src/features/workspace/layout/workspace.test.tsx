import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Tab } from "../model/types";
import { endDrag } from "./drag";
import { mount, paneByHost, panesIn, qa } from "./harness";

afterEach(() => {
  act(() => endDrag());
  cleanup();
});

const panes = () => document.querySelectorAll<HTMLElement>(".ws-pane");

test("首次载入按工作区目录生成默认窗口：每台主机一个窗格", async () => {
  await mount();
  const hosts = Array.from(panes()).map((p) => p.dataset.host);
  expect(hosts).toContain("server");
  expect(hosts).toContain("gpu");
  expect(screen.getByRole("tablist", { name: "窗口" })).toBeTruthy();
});

test("窗格头显示主机展示名，窗格 aria-label 带主机名", async () => {
  await mount();
  expect(screen.getByRole("region", { name: "窗格 · GPU 机" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "窗格 · Server" })).toBeTruthy();
});

const selectedIndex = (pane: HTMLElement) =>
  within(pane)
    .getAllByRole("tab")
    .findIndex((t) => t.getAttribute("aria-selected") === "true");

test("标签条：方向键切换并激活相邻标签", async () => {
  await mount();
  const pane = screen.getByRole("region", { name: "窗格 · GPU 机" });
  // 先补一个终端标签，保证窗格里至少有两个标签
  await act(async () => {
    fireEvent.click(within(pane).getByRole("button", { name: "新建标签页" }));
  });
  const menu = await screen.findByRole("menu", { name: "新建标签页" });
  await act(async () => {
    fireEvent.click(within(menu).getByRole("menuitem", { name: /终端/ }));
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole("menuitem", { name: /GPU 机/ }));
  });
  const tabs = within(pane).getAllByRole("tab");
  expect(tabs.length).toBeGreaterThan(1);

  const before = selectedIndex(pane);
  await act(async () => {
    fireEvent.keyDown(within(pane).getByRole("tablist"), { key: "ArrowRight" });
  });
  expect(selectedIndex(pane)).toBe((before + 1) % tabs.length);
});

test("「+」菜单新建标签：多主机工作区先选类型再选主机", async () => {
  await mount();
  const pane = screen.getByRole("region", { name: "窗格 · GPU 机" });
  const n0 = within(pane).getAllByRole("tab").length;
  await act(async () => {
    fireEvent.click(within(pane).getByRole("button", { name: "新建标签页" }));
  });
  const menu = await screen.findByRole("menu", { name: "新建标签页" });
  await act(async () => {
    fireEvent.click(within(menu).getByRole("menuitem", { name: /终端/ }));
  });
  // 工作区有两台主机：第二步选主机，此时还没有新标签
  expect(within(pane).getAllByRole("tab")).toHaveLength(n0);
  await act(async () => {
    fireEvent.click(await screen.findByRole("menuitem", { name: /GPU 机/ }));
  });
  expect(within(pane).getAllByRole("tab")).toHaveLength(n0 + 1);
});

test("「+」菜单只有能凭空建出内容的类型：没有「对话」与「预览」", async () => {
  await mount();
  const pane = paneByHost("server");
  await act(async () => {
    fireEvent.click(within(pane).getByRole("button", { name: "新建标签页" }));
  });
  const menu = await screen.findByRole("menu", { name: "新建标签页" });
  const names = within(menu)
    .getAllByRole("menuitem")
    .map((m) => m.textContent ?? "");
  for (const label of ["终端", "文件", "浏览器", "画布"])
    expect(names.some((n) => n.includes(label))).toBe(true);
  for (const label of ["对话", "预览"])
    expect(names.some((n) => n.includes(label))).toBe(false);
});

test("新建窗口 → 窗口条多一项，切回后窗格仍在", async () => {
  await mount();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "新建窗口" }));
  });
  const wins = within(
    screen.getByRole("tablist", { name: "窗口" }),
  ).getAllByRole("tab");
  expect(wins).toHaveLength(2);
  await act(async () => {
    fireEvent.click(wins[0] as HTMLElement);
  });
  expect(panesIn().length).toBeGreaterThan(0);
});

// ── 对话标签的标题与临时标签 ──
const doc = (tabs: Tab[]) => ({
  revision: 1,
  document: {
    version: 4,
    windows: {
      list: [
        {
          id: "w1",
          focus: "p1",
          root: { pid: "p1", host: null, active: "t1", tabs },
        },
      ],
      active: 0,
    },
  },
});
const titles = new Map([
  ["a", "重构提示词送达"],
  ["b", "权限矩阵讨论"],
]);

test("对话标签的标题是它绑的会话的标题；空对话标签与标题表里没有的会话回落到「对话」", async () => {
  await mount(
    doc([
      { id: "t1", type: "chat", ctab: "chat", sid: "a" },
      { id: "t2", type: "chat", ctab: "chat", sid: "b" },
      { id: "t3", type: "chat", ctab: "chat" },
      { id: "t4", type: "chat", ctab: "chat", sid: "c" },
    ]),
    titles,
  );
  const names = qa(".ws-pn-tab-name").map((n) => n.textContent);
  expect(names).toEqual(["重构提示词送达", "权限矩阵讨论", "对话", "对话"]);
});

test("临时标签带 data-temp（标题斜体），固定的没有", async () => {
  await mount(
    doc([
      { id: "t1", type: "chat", ctab: "chat", sid: "a", temp: true },
      { id: "t2", type: "chat", ctab: "chat", sid: "b" },
    ]),
    titles,
  );
  const tabs = qa(".ws-pn-tab");
  expect(tabs[0]?.getAttribute("data-temp")).toBe("true");
  expect(tabs[1]?.hasAttribute("data-temp")).toBe(false);
});
