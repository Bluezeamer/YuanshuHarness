// 窗格头「+」的主机路由，整页 DOM 层：主机选择菜单的排序与提示、选别的主机 → 右侧新建窗格并按主机上色。
// 迁移自 l1.smoke 的「主机选择菜单列出会话主机并标注本窗格」与「宿主窗格加异主机标签 → 右侧新建窗格」。
// 同主机留在本窗格已由 workspace.test 覆盖；model 层的路由在 l2.test 的 addTab。

import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { endDrag } from "./drag";
import { mount, paneByHost, panesIn, tabsIn } from "./harness";

afterEach(() => {
  act(() => endDrag());
  cleanup();
});

const click = (el: Element) => act(async () => void fireEvent.click(el));
const hostsOf = () => panesIn().map((p) => p.dataset.host);
const toneOf = (p: HTMLElement) => p.style.getPropertyValue("--tone");

/** 在 pane 的「+」里选一个类型，进入选主机这一步 */
async function pickType(pane: HTMLElement, name: RegExp) {
  await click(within(pane).getByRole("button", { name: "新建标签页" }));
  const menu = await screen.findByRole("menu", { name: "新建标签页" });
  await click(within(menu).getByRole("menuitem", { name }));
  return screen.findByRole("menuitem", { name: /返回类型/ });
}

test("主机选择菜单：本窗格的主机排第一并标「本窗格」，其余主机跟在后面，底部写明一窗格一主机", async () => {
  await mount();
  await pickType(paneByHost("gpu"), /文件/);
  const names = screen
    .getAllByRole("menuitem")
    .filter((i) => i.textContent !== "返回类型")
    .map((i) => i.textContent);
  expect(names).toEqual(["GPU 机本窗格", "Server"]);
  expect(screen.getByText(/一个窗格只装一台主机/)).toBeTruthy();
  // 选择前还没有新标签
  expect(tabsIn(paneByHost("gpu"))).toHaveLength(2);
});

test("宿主窗格加异主机标签：右侧新建该主机的窗格，原窗格不变，同主机同色、异主机异色", async () => {
  await mount();
  const gpu = paneByHost("gpu");
  const gpuTabs = tabsIn(gpu).length;
  expect(hostsOf()).toEqual(["", "server", "gpu"]);

  await pickType(gpu, /终端/);
  await click(screen.getByRole("menuitem", { name: "Server" }));

  // 新窗格紧挨在 gpu 窗格右边，属 server，只装这一个新标签
  expect(hostsOf()).toEqual(["", "server", "gpu", "server"]);
  const panes = panesIn();
  expect(tabsIn(panes[2] as HTMLElement)).toHaveLength(gpuTabs);
  expect(panes[2]?.dataset.host).toBe("gpu");
  expect(tabsIn(panes[3] as HTMLElement).map((t) => t.dataset.type)).toEqual([
    "term",
  ]);

  const [srv1, gpu1, srv2] = [panes[1], panes[2], panes[3]].map((p) =>
    toneOf(p as HTMLElement),
  );
  expect(srv2).toBe(srv1); // 同一台主机的两个窗格同色
  expect(srv1).not.toBe(gpu1); // 不同主机色不同
  expect(new Set([srv1, gpu1]).size).toBe(2);
});

test("画布不问主机：在 gpu 窗格里选画布，直接跟着工作区主目录（Server 的 /w）走；画布不参与窗格隔离，就留在 gpu 窗格里", async () => {
  await mount();
  await click(
    within(paneByHost("gpu")).getByRole("button", { name: "新建标签页" }),
  );
  const menu = await screen.findByRole("menu", { name: "新建标签页" });
  await click(within(menu).getByRole("menuitem", { name: /画布/ }));
  // 没有「选择主机」这一步
  expect(screen.queryByRole("menuitem", { name: /返回类型/ })).toBeNull();
  const canvases = panesIn().flatMap((p) =>
    tabsIn(p)
      .filter((t) => t.dataset.type === "canvas")
      .map(() => p.dataset.host),
  );
  expect(canvases).toEqual(["gpu"]);
});
