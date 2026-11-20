import { act, fireEvent, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { mount } from "./testkit";

const bar = () => document.querySelector(".ch-queue") as HTMLElement | null;
const rows = () => bar()?.querySelectorAll(".ch-q") ?? [];

test("单条排队：靠右的虚线气泡，带送达提示，输入框上方才有，不在对话流里", () => {
  mount({
    running: true,
    messages: [{ role: "assistant", text: "在跑" }],
    queue: ["下一步改 b.ts"],
  });
  const el = bar();
  expect(el).toBeTruthy();
  expect(rows()).toHaveLength(1);
  expect(el?.textContent).toContain("下一步改 b.ts");
  expect(el?.textContent).toContain("排队 1 条 · 当前步骤结束后送达");
  // 同一个提示只有排队区里这一处
  expect(screen.getAllByText(/当前步骤结束后送达/)).toHaveLength(1);
  expect(
    screen.getByRole("log", { name: "对话记录" }).textContent,
  ).not.toContain("下一步改 b.ts");
});

test("多条排队：每条一个气泡，不折叠", () => {
  mount({ running: true, queue: ["第一条", "第二条"] });
  const el = bar() as HTMLElement;
  expect(rows()).toHaveLength(2);
  expect(el.textContent).toContain("排队 2 条");
  expect(rows()[0]?.textContent).toContain("第一条");
  expect(rows()[1]?.textContent).toContain("第二条");
});

test("编辑保存：把新文本交给服务端，退出编辑态", async () => {
  const h = mount({ running: true, queue: ["第一条"] });
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  const ta = (await screen.findByRole("textbox", {
    name: "编辑第 1 条排队消息",
  })) as HTMLTextAreaElement;
  expect(ta.value).toBe("第一条");

  fireEvent.change(ta, { target: { value: "改后的第一条" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(h.box.actions.editQueue).toHaveBeenCalledWith(0, "改后的第一条", []);
  expect(screen.queryByRole("textbox", { name: /编辑第 1 条/ })).toBeNull();
  expect(bar()?.textContent).toContain("第一条");
});

test("编辑取消：不发命令，恢复预览", async () => {
  const h = mount({ running: true, queue: ["第一条"] });
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: "编辑第 1 条排队消息" }),
    { target: { value: "改到一半" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(h.box.actions.editQueue).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox", { name: /编辑第/ })).toBeNull();
  expect(bar()?.textContent).toContain("第一条");
});

test("删除：按当前顺序的 index 交给服务端", () => {
  const h = mount({ running: true, queue: ["第一条", "第二条"] });
  fireEvent.click(screen.getByRole("button", { name: "删除第 2 条排队消息" }));
  expect(h.box.actions.removeQueue).toHaveBeenCalledWith(1);
});

test("队列变化刷新：条目变少时，指向已消失条目的编辑态自动退出", async () => {
  const h = mount({ running: true, queue: ["第一条", "第二条"] });
  fireEvent.click(
    screen.getAllByRole("button", { name: "编辑" })[1] as HTMLElement,
  );
  expect(
    await screen.findByRole("textbox", { name: "编辑第 2 条排队消息" }),
  ).toBeTruthy();

  act(() => h.box.set({ queue: ["第二条"] }));
  expect(screen.queryByRole("textbox", { name: /编辑第/ })).toBeNull();
  expect(bar()?.textContent).toContain("第二条");
});

test("队列清空后排队区整个消失", () => {
  const h = mount({ running: true, queue: ["第一条"] });
  expect(bar()).toBeTruthy();
  act(() => h.box.set({ queue: [] }));
  expect(bar()).toBeNull();
});

test("编辑起点用服务端返回的全文，不用事件里截断的预览", async () => {
  const h = mount({ running: true, queue: ["短预览"] });
  const full = `${"长".repeat(600)}TAIL`;
  h.box.actions.queueTexts.mockResolvedValueOnce([
    { text: full, attachments: [] },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  const ta = (await screen.findByRole("textbox", {
    name: "编辑第 1 条排队消息",
  })) as HTMLTextAreaElement;
  expect(ta.value).toBe(full);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(h.box.actions.editQueue).toHaveBeenCalledWith(0, full, []);
});

test("取全文失败：提示并保持只读", async () => {
  const h = mount({ running: true, queue: ["短预览"] });
  h.box.actions.queueTexts.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect(await screen.findByText("读取完整排队内容失败，请重试")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: /编辑第/ })).toBeNull();
  expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
});

test("取全文期间队列已变化：提示重试，保持只读", async () => {
  const h = mount({ running: true, queue: ["短预览"] });
  h.box.actions.queueTexts.mockResolvedValueOnce([
    { text: "一", attachments: [] },
    { text: "二", attachments: [] },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect(await screen.findByText("排队消息已变化，请重试")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: /编辑第/ })).toBeNull();
});

// ---- 排队消息的附件：编辑时可以增删，保存连同文字整体替换 ----

const REF = {
  name: "a.png",
  mime: "image/png",
  sizeText: "1 KB",
  path: "a.png",
};

test("编辑带附件的排队消息：附件条里有原附件，移除后保存带空数组", async () => {
  const h = mount({ running: true, queue: ["看图"] });
  h.box.actions.queueTexts.mockResolvedValueOnce([
    { text: "看图", attachments: [REF] },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  await screen.findByLabelText("附件");
  expect(screen.getByRole("button", { name: "查看大图 a.png" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /移除/ }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(h.box.actions.editQueue).toHaveBeenCalledWith(0, "看图", []);
});

test("编辑时保留原附件：保存带原路径", async () => {
  const h = mount({ running: true, queue: ["看图"] });
  h.box.actions.queueTexts.mockResolvedValueOnce([
    { text: "看图", attachments: [REF] },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  await screen.findByLabelText("附件");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(h.box.actions.editQueue).toHaveBeenCalledWith(0, "看图", [
    { path: "a.png" },
  ]);
});

test("只有附件的排队消息：预览写「附件消息」；清空文字但留附件仍可保存", async () => {
  const h = mount({
    running: true,
    queue: ["[attach_file] attachment:/a.png (image/png, 1 KB)"],
  });
  expect(bar()?.textContent).toContain("（附件消息）");
  h.box.actions.queueTexts.mockResolvedValueOnce([
    { text: "", attachments: [REF] },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  await screen.findByLabelText("附件");
  expect(
    (screen.getByRole("button", { name: "保存" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(h.box.actions.editQueue).toHaveBeenCalledWith(0, "", [
    { path: "a.png" },
  ]);
});
