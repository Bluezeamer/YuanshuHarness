// 审计 v2 左栏底部的「压缩历史」区：默认折叠、按段列出；展开某段看这一段的调用事件序列，
// 点嵌套调用选中后在右栏显示压缩前快照 + 范围标蓝。
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { api } from "./fakeapi";
import {
  clickRow,
  installStore,
  mount,
  search,
  sec,
  setupEnv,
} from "./harness";
import { compaction, makeCall } from "./testkit";

vi.mock("../../../api/calls", async () => (await import("./fakeapi")).api);

setupEnv();

// 第 1、2 次调用属于第 1 段压缩历史，第 3、4 次属于第 2 段，第 5 次是当前段。
const historyCalls = () => [
  makeCall("s1", {
    seq: 1,
    turn: 1,
    trigger: "user",
    segment: 1,
    msgCount: 1,
    range: { from: 1, to: 2 },
    request: {
      system: "你是助手",
      messages: [
        { role: "user", content: "旧一" },
        { role: "assistant", content: "旧回复" },
        { role: "user", content: "旧二" },
      ],
    },
  }),
  makeCall("s1", {
    seq: 2,
    turn: 1,
    trigger: "tool_result",
    segment: 1,
    msgCount: 2,
    range: { from: 2, to: 3 },
    request: {
      system: "你是助手",
      messages: [
        { role: "user", content: "旧一" },
        { role: "assistant", content: "旧回复" },
        { role: "user", content: "旧二" },
      ],
    },
  }),
  makeCall("s1", {
    seq: 3,
    turn: 2,
    trigger: "user",
    segment: 2,
    msgCount: 1,
    range: { from: 1, to: 2 },
    request: {
      system: "你是助手",
      messages: [{ role: "user", content: "第二段" }],
    },
  }),
  makeCall("s1", {
    seq: 4,
    turn: 2,
    trigger: "tool_result",
    segment: 2,
    msgCount: 2,
    range: { from: 2, to: 2 },
    request: {
      system: "你是助手",
      messages: [{ role: "user", content: "第二段" }],
    },
  }),
  makeCall("s1", { seq: 5, turn: 3, trigger: "user" }),
];

const historyCompactions = () => [
  compaction(1, {
    createdAt: "2026-10-25T09:01:00.000Z",
    callSeqFrom: 1,
    callSeqTo: 2,
    messageCount: 3,
    tokensBefore: 8000,
  }),
  compaction(2, {
    createdAt: "2026-10-25T09:02:00.000Z",
    callSeqFrom: 3,
    callSeqTo: 4,
    messageCount: 3,
    tokensBefore: 9000,
  }),
];

function installHistory() {
  installStore({ s1: historyCalls() }, historyCompactions());
}

async function expandHistory() {
  fireEvent.click(
    await screen.findByRole("button", { name: /^压缩历史\s*\d+$/ }),
  );
}

function toggleSegment(seq: number) {
  const row = document.querySelector<HTMLElement>(`[data-comp="${seq}"]`);
  if (!row) throw new Error(`没有找到压缩历史 ${seq}`);
  clickRow(row);
}

test("左栏底部有默认折叠的「压缩历史」区；展开后按段列出", async () => {
  installHistory();
  mount();
  await screen.findByText("调用 05");
  const header = await screen.findByRole("button", {
    name: /^压缩历史\s*\d+$/,
  });
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector(".au-comp-body")).toBeNull();
  fireEvent.click(header);
  expect(header.getAttribute("aria-expanded")).toBe("true");
  const rows = [...document.querySelectorAll("[data-comp]")];
  expect(
    rows.map((r) => r.querySelector(".u-lrow-label")?.textContent),
  ).toEqual(["压缩历史 1", "压缩历史 2"]);
  expect(rows[0]?.textContent).toContain("3 条");
  expect(rows[0]?.textContent).toContain("压缩前 8.0k tok");
  expect(rows[0]?.textContent).toMatch(/\d\d-\d\d \d\d:\d\d/);
});

test("展开某段：列出这一段的调用事件序列（嵌套行，按事件顺序）", async () => {
  installHistory();
  mount();
  await screen.findByText("调用 05");
  await expandHistory();
  toggleSegment(1);
  await waitFor(() =>
    expect(document.querySelectorAll("[data-seg-call]")).toHaveLength(2),
  );
  const seqs = [...document.querySelectorAll("[data-seg-call] .au-seq")].map(
    (x) => x.textContent,
  );
  expect(seqs).toEqual(["01", "02"]);
  // 另一段没展开，不会混进来
  expect(document.querySelector('[data-seg-call="s1-c3"]')).toBeNull();
});

test("点嵌套调用选中它：右栏显示压缩前快照，范围在结构视图里标蓝", async () => {
  installHistory();
  mount();
  await screen.findByText("调用 05");
  await expandHistory();
  toggleSegment(1);
  await waitFor(() =>
    expect(document.querySelectorAll("[data-seg-call]")).toHaveLength(2),
  );
  clickRow(document.querySelector('[data-seg-call="s1-c2"]') as HTMLElement);
  await screen.findByText("调用 02");
  expect(api.getCall).toHaveBeenLastCalledWith(null, "s1", "s1-c2");
  expect(screen.getByText(/压缩前快照 · 第 1 段/)).toBeTruthy();
  await waitFor(() => expect(sec("响应")?.textContent).toContain("回复 2"));
  // 这一调用的范围是请求里的第 3 项：之前两条算历史，范围内的「旧二」是本轮新增
  expect(sec("历史")?.querySelector(".au-sec-n")?.textContent).toBe(
    "1 轮 · 2 块",
  );
  const scope = sec("本轮新增") as HTMLElement;
  expect(scope.hasAttribute("data-scope")).toBe(true);
  expect(scope.querySelector(".au-blk-b")?.textContent).toBe("旧二");
});

test("从压缩历史里点选可以绕开筛选：主列表被筛空也能看详情", async () => {
  installHistory();
  mount();
  await screen.findByText("调用 05");
  await expandHistory();
  toggleSegment(1);
  await waitFor(() =>
    expect(document.querySelectorAll("[data-seg-call]")).toHaveLength(2),
  );
  search("zzzz-not-exist");
  expect(screen.getByText(/没有符合条件的调用/)).toBeTruthy();
  expect(screen.getByText(/没有可展开的调用/)).toBeTruthy();
  clickRow(document.querySelector('[data-seg-call="s1-c1"]') as HTMLElement);
  await screen.findByText("调用 01");
  expect(screen.getByText(/压缩前快照 · 第 1 段/)).toBeTruthy();
});

test("这一段的调用还没载入时，展开会按游标往回补", async () => {
  // 第一页只载入最近 100 条（seq 150..51），第 1 段的调用在最前面
  const calls = Array.from({ length: 150 }, (_, i) =>
    makeCall("s1", {
      seq: i + 1,
      turn: 1,
      trigger: "tool_result",
      segment: i < 5 ? 1 : 0,
    }),
  );
  installStore({ s1: calls }, [
    compaction(1, { callSeqFrom: 1, callSeqTo: 5 }),
  ]);
  mount();
  await screen.findByText("调用 150");
  await expandHistory();
  toggleSegment(1);
  await waitFor(() =>
    expect(document.querySelectorAll("[data-seg-call]")).toHaveLength(5),
  );
  expect(api.listCalls).toHaveBeenLastCalledWith(null, "s1", {
    limit: 200,
    before: 51,
  });
});

test("刷新会重取压缩历史", async () => {
  installHistory();
  mount();
  await screen.findByText("调用 05");
  await waitFor(() => expect(api.getCompactions).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(api.getCompactions).toHaveBeenCalledTimes(2));
});
