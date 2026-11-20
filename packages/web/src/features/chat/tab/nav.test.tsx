// 左缘导航（每条用户指令一格横线）的交互测试。
// jsdom 没有布局：这里装一套假几何——流区视口高 400px，每条用户消息占 100px 行高——
// 滚动位置由 scrollTop 决定，组件用 getBoundingClientRect 量出来的相对位置就随 scrollTop 变化。
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ getUserMessages: vi.fn() }));
vi.mock("../../../api/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/sessions")>()),
  getUserMessages: api.getUserMessages,
}));
vi.mock("../audit", () => ({ AuditPane: () => null }));

import type { Known } from "../../../api";
import { saveToken } from "../../../api/http";
import type { ChatEntry } from "../../../api/sessions";
import { mapRenderedToNodes } from "./conversationNav";
import { mount } from "./testkit";

const ROW = 100; // 用户消息之间的行距
const ROW_H = 80; // 气泡自己占的高度：行距 - 20 就是留白
const VIEW_H = 400; // 流区视口高

const rect = (top: number, height: number): DOMRect =>
  ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as unknown as DOMRect;

const originalRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  api.getUserMessages.mockReset();
  // 假几何：流区从视口顶边开始；用户消息从内容顶部按 100px 行距排，位置随 scrollTop 上移。
  Element.prototype.getBoundingClientRect = function fakeRect(
    this: Element,
  ): DOMRect {
    const stream = document.querySelector<HTMLElement>("[data-chat-stream]");
    if (!stream) return rect(0, 0);
    if (this === stream) return rect(0, VIEW_H);
    if (this.classList.contains("ch-you")) {
      const users = [...stream.querySelectorAll(".ch-you")];
      return rect(users.indexOf(this) * ROW - stream.scrollTop, ROW_H);
    }
    return rect(0, 0);
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  cleanup();
  sessionStorage.clear();
});

const say = (text: string): Known => ({ role: "user", text });
const reply = (text: string): Known => ({ role: "assistant", text });

const stream = () => screen.getByRole("log", { name: "对话记录" });

/** 把流区滚到 scrollTop 并触发 scroll 事件（组件据此重新测量） */
const scrollTo = (top: number): HTMLElement => {
  const el = stream();
  el.scrollTop = top;
  fireEvent.scroll(el);
  return el;
};

const nav = () =>
  document.querySelector<HTMLElement>("[data-chat-nav]") as HTMLElement | null;
const ticks = () => [
  ...document.querySelectorAll<HTMLElement>("[data-chat-nav] [data-nav]"),
];
const tick = (i: number) =>
  document.querySelector<HTMLElement>(`[data-chat-nav] [data-nav="${i}"]`);
const current = () =>
  ticks()
    .filter((t) => t.getAttribute("aria-current") === "true")
    .map((t) => t.dataset.nav);

const remote = (texts: string[]) =>
  texts.map((text, i) => ({
    entryId: `e${i}`,
    text,
    timestamp: new Date().toISOString(),
  }));

// ── 节点与当前位置 ──

test("进来就取全量节点，每条指令一格线（本地只渲染了一部分也不缺）", async () => {
  saveToken("tok");
  api.getUserMessages.mockResolvedValue({
    ok: true,
    data: remote(["最早指令", "第二条指令", "第三条指令", "第四条指令"]),
  });
  // 本地只渲染了最后两条指令（更早的历史还没加载）
  mount({
    messages: [say("第三条指令"), reply("x"), say("第四条指令"), reply("y")],
  });
  await waitFor(() => expect(ticks()).toHaveLength(4));
  expect(api.getUserMessages).toHaveBeenCalledTimes(1);
  expect(api.getUserMessages).toHaveBeenCalledWith("s1", "tok");
  expect(ticks()[0]?.getAttribute("aria-label")).toContain("最早指令");
});

test("只有一条指令：不画导航", async () => {
  api.getUserMessages.mockResolvedValue({
    ok: true,
    data: remote(["唯一的指令"]),
  });
  mount({ messages: [say("唯一的指令"), reply("好")] });
  await waitFor(() => expect(api.getUserMessages).toHaveBeenCalled());
  expect(nav()).toBeNull();
});

test("没有用户消息时不渲染导航", () => {
  api.getUserMessages.mockResolvedValue({ ok: true, data: [] });
  mount({ messages: [reply("还没有指令")] });
  expect(nav()).toBeNull();
});

test("滚动时当前位置跟着变：已加载的节点序位按全局序位映射", async () => {
  api.getUserMessages.mockResolvedValue({
    ok: true,
    data: remote(["最早指令", "第二条指令", "第三条指令", "第四条指令"]),
  });
  mount({
    messages: [say("第三条指令"), reply("x"), say("第四条指令"), reply("y")],
  });
  await waitFor(() => expect(ticks()).toHaveLength(4));
  scrollTo(0); // 第一条本地指令（全局第 3 条）在视口顶边
  expect(current()).toEqual(["2"]);
  scrollTo(150); // 本地第 2 条已滚过顶边 → 全局第 4 条
  expect(current()).toEqual(["3"]);
});

test("发了新指令、列表落后时再取一次；列表已是最新就不重复请求", async () => {
  api.getUserMessages.mockResolvedValue({
    ok: true,
    data: remote(["第一条", "第二条"]),
  });
  const h = mount({ messages: [say("第一条"), reply("x"), say("第二条")] });
  await waitFor(() => expect(ticks()).toHaveLength(2));
  expect(api.getUserMessages).toHaveBeenCalledTimes(1);
  api.getUserMessages.mockResolvedValue({
    ok: true,
    data: remote(["第一条", "第二条", "第三条"]),
  });
  act(() =>
    h.box.set({
      messages: [
        say("第一条"),
        reply("x"),
        say("第二条"),
        reply("y"),
        say("第三条"),
      ],
    }),
  );
  await waitFor(() => expect(ticks()).toHaveLength(3));
  expect(api.getUserMessages).toHaveBeenCalledTimes(2);
});

// ── 展开：整块区域，离开才收 ──

test("鼠标移上去整块展开，只有整块离开才收起", async () => {
  api.getUserMessages.mockResolvedValue({
    ok: true,
    data: remote(["第一条", "第二条", "第三条"]),
  });
  mount({ messages: [say("第一条"), say("第二条"), say("第三条")] });
  await waitFor(() => expect(ticks()).toHaveLength(3));
  const box = document.querySelector(".ch-nav") as HTMLElement;
  expect(box.hasAttribute("data-expanded")).toBe(false);
  fireEvent.pointerEnter(box);
  expect(box.hasAttribute("data-expanded")).toBe(true);
  // 在区域里从一条移到另一条：不收
  fireEvent.pointerEnter(tick(0) as HTMLElement);
  fireEvent.pointerEnter(tick(2) as HTMLElement);
  expect(box.hasAttribute("data-expanded")).toBe(true);
  fireEvent.pointerLeave(box);
  expect(box.hasAttribute("data-expanded")).toBe(false);
});

test("展开后线长按正态分布：鼠标所在那条最长，远处的文字变淡", async () => {
  const texts = ["一", "二", "三", "四", "五", "六"];
  api.getUserMessages.mockResolvedValue({ ok: true, data: remote(texts) });
  mount({ messages: texts.flatMap((t) => [say(t), reply("x")]) });
  await waitFor(() => expect(ticks()).toHaveLength(6));
  const part = (i: number, sel: string) =>
    (tick(i) as HTMLElement).querySelector(sel) as HTMLElement;
  const mark = (i: number) =>
    Number.parseFloat(part(i, ".ch-tick-mark").style.width);
  const fade = (i: number) =>
    Number.parseFloat(part(i, ".ch-nav-row").style.opacity);
  fireEvent.pointerEnter(document.querySelector(".ch-nav") as HTMLElement);
  fireEvent.pointerEnter(tick(2) as HTMLElement);
  expect(mark(2)).toBe(28);
  expect(mark(3)).toBeLessThan(mark(2));
  expect(mark(5)).toBeLessThan(mark(3));
  expect(fade(5)).toBeLessThan(fade(3));
});

// ── 点击定位 ──

test("点击已渲染的节点：按 scrollTop 定位并短暂高亮", async () => {
  api.getUserMessages.mockResolvedValue({
    ok: true,
    data: remote(["最早指令", "第二条指令", "第三条指令", "第四条指令"]),
  });
  mount({
    messages: [say("第三条指令"), reply("x"), say("第四条指令"), reply("y")],
  });
  await waitFor(() => expect(ticks()).toHaveLength(4));
  const el = scrollTo(150);
  fireEvent.click(tick(3) as HTMLElement); // 全局第 4 条 = 本地第 2 条（DOM 序位 1）
  expect(el.scrollTop).toBe(100); // 目标消息对齐视口顶边
  expect(document.querySelectorAll(".ch-you.is-jump")).toHaveLength(1);
  expect(api.getUserMessages).toHaveBeenCalledTimes(1);
});

test("点击还没加载的节点：先加载更早历史，目标出现后自动定位", async () => {
  api.getUserMessages.mockResolvedValue({
    ok: true,
    data: remote(["最早指令", "第二条指令", "第三条指令", "第四条指令"]),
  });
  const h = mount({
    messages: [say("第三条指令"), reply("x"), say("第四条指令"), reply("y")],
    loaded: {
      older: [],
      nextBefore: "c",
      compactions: [],
      notices: [],
    },
  });
  await waitFor(() => expect(ticks()).toHaveLength(4));
  const el = scrollTo(150);
  fireEvent.click(tick(0) as HTMLElement); // 全局第 1 条：还没渲染
  expect(h.box.actions.loadEarlier).toHaveBeenCalledTimes(1);
  expect(el.scrollTop).toBe(150); // 还没定位

  // 服务端返回更早的一页：两条更早的用户消息进入流里
  const older: ChatEntry[] = [
    { index: 0, role: "user", text: "最早指令" },
    { index: 1, role: "user", text: "第二条指令" },
  ];
  act(() =>
    h.box.set({
      loaded: { older, nextBefore: null, compactions: [], notices: [] },
    }),
  );
  await waitFor(() => expect(el.scrollTop).toBe(0)); // 第 1 条对齐视口顶边
  const users = document.querySelectorAll<HTMLElement>(".ch-you");
  expect(users[0]?.textContent).toContain("最早指令");
  expect(users[0]?.classList.contains("is-jump")).toBe(true);
});

test("接口失败时退回本地已渲染的指令，点击定位照常", async () => {
  api.getUserMessages.mockResolvedValue({ ok: false, kind: "network" });
  mount({ messages: [say("第三条指令"), reply("x"), say("第四条指令")] });
  await waitFor(() => expect(ticks()).toHaveLength(2));
  const el = scrollTo(0);
  fireEvent.click(tick(1) as HTMLElement);
  expect(el.scrollTop).toBe(100);
});

test("附件消息：标签剥掉 [attach_file] 标记，纯附件消息给占位文案且能定位", async () => {
  api.getUserMessages.mockResolvedValue({
    ok: true,
    data: [
      {
        entryId: "e0",
        text: "看看这个\n\n[attach_file] ./x/a.png image/png 12 KB",
        timestamp: null,
      },
      {
        entryId: "e1",
        text: "[attach_file] ./x/b.pdf application/pdf 2 MB",
        timestamp: null,
      },
      { entryId: "e2", text: "收尾", timestamp: null },
    ],
  });
  mount({
    messages: [
      say("看看这个"),
      reply("x"),
      say(""), // 纯附件消息：流里只有附件卡
      reply("y"),
      say("收尾"),
      reply("z"),
    ],
  });
  await waitFor(() => expect(ticks()).toHaveLength(3));
  const labels = ticks().map((t) => t.getAttribute("aria-label") ?? "");
  expect(labels.join("|")).not.toContain("[attach_file]");
  expect(labels[0]).toContain("看看这个");
  expect(labels[1]).toContain("（附件消息）");

  const el = scrollTo(150);
  fireEvent.click(tick(0) as HTMLElement);
  expect(el.scrollTop).toBe(0);
  expect(
    document.querySelector(".ch-you.is-jump")?.textContent ?? "",
  ).toContain("看看这个");
});

test("悬停某一条：第二张卡给完整内容、时间与第几条", async () => {
  const long = `${"很长的指令".repeat(20)}末尾`;
  api.getUserMessages.mockResolvedValue({
    ok: true,
    data: [
      { entryId: "e0", text: "短指令", timestamp: "2026-11-07T07:12:00.000Z" },
      { entryId: "e1", text: long, timestamp: "2026-11-07T08:00:00.000Z" },
    ],
  });
  mount({ messages: [say("短指令"), reply("x"), say(long)] });
  await waitFor(() => expect(ticks()).toHaveLength(2));
  fireEvent.pointerEnter(tick(1)?.closest(".u-hc") as HTMLElement);
  const tip = await waitFor(() => screen.getByRole("tooltip"), {
    timeout: 2000,
  });
  expect(tip.textContent).toContain("末尾");
  expect(tip.textContent).toContain("第 2 条，共 2 条");
  expect(tip.textContent).toMatch(/2026-11-07 \d\d:\d\d/);
});

// ── 序位映射（附件消息等不在接口列表里的用户消息会被跳过）──

test("已渲染序位 → 全量节点序位：从尾部按文本对齐，跳过错位的消息", () => {
  const map = mapRenderedToNodes(
    ["最早指令", "", "第三条指令", "第四条指令"],
    [
      { text: "最早指令", timestamp: null },
      { text: "第三条指令", timestamp: null },
      { text: "第四条指令", timestamp: null },
    ],
  );
  expect(map).toEqual([0, -1, 1, 2]);
});
