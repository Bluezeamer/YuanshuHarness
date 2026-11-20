// L2 拖放的 DOM 接线：标签/窗格落点、主机冲突、拖到窗口条。
// 迁移自 l1.smoke 的 L2 / 主机隔离部分；当前工作区的默认窗口 = 对话窗格 + server 窗格 + gpu 窗格。

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { beginDrag, endDrag, getDrag } from "./drag";
import {
  dragStart,
  drop,
  mount,
  over,
  paneByHost,
  panesIn,
  q,
  qa,
  rect,
  tabsIn,
} from "./harness";

afterEach(() => {
  act(() => endDrag());
  cleanup();
});

const hostsOf = (root: ParentNode = document) =>
  panesIn(root).map((p) => p.dataset.host);
const zone = (pane: HTMLElement, z: string) =>
  q(`.u-dz[data-z="${z}"]`, pane) as HTMLElement;
const types = (pane: HTMLElement) => tabsIn(pane).map((t) => t.dataset.type);
const head = (pane: HTMLElement) => q(".ws-pn-head", pane) as HTMLElement;

test("默认窗口：对话窗格不绑主机，两台主机各占一个窗格且色不同", async () => {
  await mount();
  expect(hostsOf()).toEqual(["", "server", "gpu"]);
  const tones = [paneByHost("server"), paneByHost("gpu")].map((p) =>
    p.style.getPropertyValue("--tone"),
  );
  expect(tones.every((t) => /^var\(--h[1-6]\)$/.test(t))).toBe(true);
  expect(tones[0]).not.toBe(tones[1]);
  expect(panesIn()[0]?.style.getPropertyValue("--tone")).toBe("");
});

test("跨主机拖标签到边缘 → 贴靠拆分：新窗格属来源主机，目标窗格不变", async () => {
  await mount();
  const [src, dst] = [paneByHost("server"), paneByHost("gpu")];
  const dstTabs = tabsIn(dst).length;
  const tab = tabsIn(src)[1] as HTMLElement; // 终端
  dragStart(tab);
  expect(over(dst, 20, 350)).toBe(true);
  expect(dst.dataset.dz).toBe("left");
  drop(dst, 20, 350);
  expect(panesIn()).toHaveLength(4);
  const moved = panesIn().find((p) => q(`[data-tid="${tab.dataset.tid}"]`, p));
  expect(moved?.dataset.host).toBe("server");
  expect(moved).not.toBe(src);
  expect(paneByHost("gpu").dataset.host).toBe("gpu");
  expect(tabsIn(paneByHost("gpu"))).toHaveLength(dstTabs);
});

test("跨主机落点预览：并格 / 并标签禁用，四向拆分照常", async () => {
  await mount();
  const dst = paneByHost("gpu");
  dragStart(tabsIn(paneByHost("server"))[0] as HTMLElement);
  expect(over(dst, 500, 350)).toBe(true); // 仍接受 drop，由 store 提示
  expect(dst.dataset.dz).toBe("center");
  expect(zone(dst, "center").dataset.off).toBe("true");
  expect(zone(dst, "strip").dataset.off).toBe("true");
  expect(zone(dst, "center").textContent).toContain("不可并入");
  expect(zone(dst, "left").dataset.off).toBeUndefined();
  over(dst, 500, 10);
  expect(dst.dataset.dz).toBe("strip");
});

test("跨主机拖标签到中部 → 拒绝：标签留在原窗格，toast 点名两台主机", async () => {
  const { notes } = await mount();
  const [src, dst] = [paneByHost("server"), paneByHost("gpu")];
  const tab = tabsIn(src)[0] as HTMLElement;
  const srcTabs = tabsIn(src).length;
  const dstTabs = tabsIn(dst).length;
  dragStart(tab);
  over(dst, 500, 350);
  drop(dst, 500, 350);
  expect(tabsIn(paneByHost("server"))).toHaveLength(srcTabs);
  expect(tabsIn(paneByHost("gpu"))).toHaveLength(dstTabs);
  const last = notes.at(-1)?.[0] ?? "";
  expect(last).toContain("GPU 机");
  expect(last).toContain("拖到窗格边缘可贴靠拆分");
});

test("无主机的对话标签可以并入任意窗格", async () => {
  await mount();
  const chat = panesIn()[0] as HTMLElement;
  const dst = paneByHost("server");
  const chatTab = tabsIn(chat)[0] as HTMLElement;
  dragStart(chatTab);
  over(dst, 500, 350);
  expect(zone(dst, "center").dataset.off).toBeUndefined();
  drop(dst, 500, 350);
  expect(types(paneByHost("server"))).toContain("chat");
  expect(paneByHost("server").dataset.host).toBe("server");
});

test("同窗格内拖标签：标签条重排，中部不接受", async () => {
  await mount();
  const pane = paneByHost("gpu");
  rect(pane, 1000, 700);
  tabsIn(pane).forEach((t, i) => {
    t.getBoundingClientRect = () =>
      ({
        left: i * 100,
        right: i * 100 + 100,
        top: 0,
        bottom: 24,
        width: 100,
        height: 24,
      }) as DOMRect;
  });
  const before = types(pane);
  expect(before).toHaveLength(2);
  dragStart(tabsIn(pane)[1] as HTMLElement);
  expect(over(pane, 500, 350)).toBe(false); // 中部：并入自己无意义
  expect(over(pane, 10, 10)).toBe(true); // 标签条
  expect(pane.dataset.dz).toBe("strip");
  drop(pane, 10, 10);
  expect(types(paneByHost("gpu"))).toEqual([before[1], before[0]]);
});

// 同窗格四边：标签拖到自己的边缘 → 拆出新窗格；源窗格保留其余标签，新窗格聚焦且激活被拖标签。
test.each([
  ["left", 20, 350],
  ["right", 980, 350],
  ["top", 500, 60],
  ["bottom", 500, 640],
] as const)(
  "同窗格拖标签到 %s → 拆出新窗格，源窗格保留其余标签",
  async (z, x, y) => {
    const { notes, store } = await mount();
    // 默认窗口的主机窗格只有文件、终端两个标签；再开一个预览凑成三个，拖走一个后源窗格还剩两个
    const hostPid = paneByHost("server").dataset.pid as string;
    await act(async () => {
      store.addTab(hostPid, "preview", { host: "server", path: "/x" });
    });
    const first = tabsIn(paneByHost("server"))[0]?.dataset.tid as string;
    await act(async () => {
      store.activateTab(hostPid, first);
    });
    const src = paneByHost("server");
    const srcPid = src.dataset.pid;
    const tabs = tabsIn(src);
    const movedTab = tabs[1] as HTMLElement;
    const tid = movedTab.dataset.tid;
    const activeTid = tabs[0]?.dataset.tid;

    dragStart(movedTab);
    expect(over(src, x, y)).toBe(true);
    expect(src.dataset.dz).toBe(z);
    drop(src, x, y);

    expect(panesIn()).toHaveLength(4);
    expect(notes).toHaveLength(0); // 不再提示不支持

    // 原窗格：还在，只少了被拖走的标签，选中态不被抢走
    const from = q(`.ws-pane[data-pid="${srcPid}"]`) as HTMLElement;
    expect(tabsIn(from)).toHaveLength(2);
    expect(tabsIn(from).map((t) => t.dataset.tid)).not.toContain(tid);
    expect(q('.ws-pn-tab[data-active="true"]', from)?.dataset.tid).toBe(
      activeTid,
    );

    // 新窗格：只装被拖的标签，聚焦、选中它，内容也换成了它
    const to = panesIn().find((p) =>
      tabsIn(p).some((t) => t.dataset.tid === tid),
    ) as HTMLElement;
    expect(to).toBeDefined();
    expect(to).not.toBe(from);
    expect(tabsIn(to)).toHaveLength(1);
    expect(to.dataset.host).toBe("server");
    expect(to.dataset.focus).toBe("true");
    expect(q('.ws-pn-tab[data-active="true"]', to)?.dataset.tid).toBe(tid);
    expect(q(`.ws-tabbody[data-tid="${tid}"]`, to)).not.toBeNull();

    // 插在目标窗格的对应一侧
    const pids = panesIn().map((p) => p.dataset.pid);
    const at = pids.indexOf(to.dataset.pid);
    expect(at).toBe(
      pids.indexOf(from.dataset.pid) + (z === "left" || z === "top" ? -1 : 1),
    );
  },
);

test("同窗格拖唯一标签到边缘：落点可高亮，松手被模型拒绝并明确提示", async () => {
  const { notes } = await mount();
  const chat = panesIn()[0] as HTMLElement; // 对话窗格只有一个标签
  const paneCountBefore = panesIn().length;
  expect(tabsIn(chat)).toHaveLength(1);
  dragStart(tabsIn(chat)[0] as HTMLElement);
  expect(over(chat, 20, 350)).toBe(true);
  expect(chat.dataset.dz).toBe("left");
  drop(chat, 20, 350);
  expect(panesIn()).toHaveLength(paneCountBefore);
  expect(notes.at(-1)?.[0]).toBe("窗格只有这一个标签，无法拆出");
});

test("窗格头拖到另一窗格边缘：窗格改位置；不能放到自己身上", async () => {
  await mount();
  const gpu = paneByHost("gpu");
  dragStart(head(gpu));
  expect(getDrag()).toMatchObject({ kind: "pane", host: "gpu" });
  expect(over(gpu, 500, 350)).toBe(false);
  const srv = paneByHost("server");
  expect(over(srv, 20, 350)).toBe(true);
  expect(srv.dataset.dz).toBe("left");
  drop(srv, 20, 350);
  expect(hostsOf()).toEqual(["", "gpu", "server"]);
});

test("窗格拖到本工作区另一个窗口的窗口标签", async () => {
  await mount();
  const wins = () => within(q(".u-wbar") as HTMLElement);
  await act(async () => {
    fireEvent.click(wins().getByRole("button", { name: "新建窗口" }));
  });
  await act(async () => {
    fireEvent.click(wins().getAllByRole("tab")[0] as HTMLElement); // 回到窗口 1
  });
  const gpu = paneByHost("gpu");
  dragStart(head(gpu));
  const chip2 = qa(".u-wbar-tab")[1] as HTMLElement;
  expect(over(chip2, 5, 5)).toBe(true);
  expect(chip2.hasAttribute("data-drop")).toBe(true);
  drop(chip2, 5, 5);
  expect(wins().getAllByRole("tab")[1]?.getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(hostsOf()).toContain("gpu");
});

// 会话行拖进窗格：落点处放它的固定对话标签。
const chatSids = () =>
  qa(".ws-pn-tab")
    .filter((t) => t.dataset.type === "chat")
    .map((t) => t.querySelector(".ws-pn-tab-name")?.textContent);

test("会话行拖到窗格右缘：新开一个窗格装它的对话标签", async () => {
  const { store } = await mount();
  const before = panesIn().length;
  act(() => beginDrag({ dataTransfer: null }, { kind: "session", sid: "b" }));
  const dst = paneByHost("server");
  expect(over(dst, 980, 350)).toBe(true);
  expect(dst.dataset.dz).toBe("right");
  drop(dst, 980, 350);
  expect(panesIn()).toHaveLength(before + 1);
  expect(store.viewing()).toContain("b");
});

test("会话行拖到窗格中部：并入该窗格；拖的是已在窗口里的会话则是移动，不重复开", async () => {
  const { notes } = await mount();
  act(() => beginDrag({ dataTransfer: null }, { kind: "session", sid: "c" }));
  const dst = paneByHost("server");
  expect(over(dst, 500, 350)).toBe(true);
  drop(dst, 500, 350);
  expect(notes).toHaveLength(0);
  expect(
    tabsIn(paneByHost("server")).filter((t) => t.dataset.type === "chat"),
  ).toHaveLength(1);
  const showing = chatSids().length;

  // 再拖同一个会话：窗口里已经有它，只移动
  act(() => beginDrag({ dataTransfer: null }, { kind: "session", sid: "c" }));
  const again = paneByHost("server");
  over(again, 500, 350);
  drop(again, 500, 350);
  expect(chatSids()).toHaveLength(showing);
});

test("会话拖拽物 Esc 取消后，落下去不生效", async () => {
  const { store } = await mount();
  const before = JSON.stringify(store.getState().doc.windows);
  act(() => beginDrag({ dataTransfer: null }, { kind: "session", sid: "d" }));
  act(() => endDrag());
  const dst = paneByHost("server");
  drop(dst, 980, 350);
  expect(JSON.stringify(store.getState().doc.windows)).toBe(before);
});

test("别的工作区的会话拖进来：窗格不接受，松手也不生效", async () => {
  const { store } = await mount();
  const before = JSON.stringify(store.getState().doc.windows);
  act(() => beginDrag({ dataTransfer: null }, { kind: "session", sid: "x" }));
  const dst = paneByHost("server");
  expect(over(dst, 980, 350)).toBe(false);
  expect(dst.dataset.dz).toBeUndefined();
  drop(dst, 980, 350);
  expect(JSON.stringify(store.getState().doc.windows)).toBe(before);
});
