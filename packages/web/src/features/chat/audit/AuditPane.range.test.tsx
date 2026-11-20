// 审计 v2 的「事件范围」：结构视图把范围内的消息块标淡蓝底（起点带分割线、响应块也标），
// JSON 视图按 range 切成前 / 范围内 / 后三段并给范围内段加蓝底；range 为 null 时整段展示。
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { CallRecord } from "../../../api/calls";
import { clickRow, installStore, mount, row, sec, setupEnv } from "./harness";
import { exportJson } from "./payload";
import { makeCall, sample } from "./testkit";

vi.mock("../../../api/calls", async () => (await import("./fakeapi")).api);

setupEnv();

// 服务端契约：段内每次调用的详情都返回会话最新一次 request，range 是这次事件在其中的消息项区间。
// 三次调用的 msgCount 分别是 1 / 3 / 5，最新 request 有 5 条消息，范围依次是 [1,3) [3,5) [5,5)。
const msgs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `第 ${i + 1} 条`,
  }));

function rangeStore() {
  const request = { system: "x", messages: msgs(5) };
  return {
    s1: [
      makeCall("s1", {
        seq: 1,
        turn: 1,
        trigger: "user",
        request,
        msgCount: 1,
        range: { from: 1, to: 3 },
      }),
      makeCall("s1", {
        seq: 2,
        turn: 1,
        trigger: "user",
        request,
        msgCount: 3,
        range: { from: 3, to: 5 },
      }),
      makeCall("s1", {
        seq: 3,
        turn: 1,
        trigger: "user",
        request,
        msgCount: 5,
        range: { from: 5, to: 5 },
      }),
    ],
  };
}

const blocks = (section: HTMLElement | undefined) =>
  [...(section?.querySelectorAll(".au-blk-b") ?? [])].map((b) => b.textContent);

async function openCall(seq: number) {
  clickRow(row(seq));
  await screen.findByText(`调用 0${seq}`);
  // 等这一条的详情正文渲染完成：响应里带着这条调用自己的回复
  await waitFor(() =>
    expect(sec("响应")?.textContent).toContain(`回复 ${seq}`),
  );
}

// ── 结构视图 ──

test("结构视图：范围之前是「历史」，范围内是「本轮新增」，之后的消息单列；本轮新增与响应默认展开", async () => {
  installStore(rangeStore());
  mount();
  await screen.findByText("调用 03");
  await openCall(1);
  // 消息 5 块，范围 [1,3)：历史 1 块、本轮新增 2 块、之后 2 块
  expect(sec("历史")?.querySelector(".au-sec-n")?.textContent).toBe(
    "1 轮 · 1 块",
  );
  expect(sec("历史")?.querySelector(".au-sec-b")).toBeNull();
  const scope = sec("本轮新增") as HTMLElement;
  expect(scope.hasAttribute("data-scope")).toBe(true);
  expect(blocks(scope)).toEqual(["第 2 条", "第 3 条"]);
  const later = sec("之后的消息") as HTMLElement;
  expect(later.querySelector(".au-sec-n")?.textContent).toBe(
    "2 块 · 不属于这次请求",
  );
  expect(later.querySelector(".au-sec-b")).toBeNull();
  expect(blocks(sec("响应"))).toEqual(["回复 1"]);
  // 范围为空（新增内容只在响应里）：本轮新增只有一句说明，没有「之后的消息」
  await openCall(3);
  expect(blocks(sec("本轮新增"))).toEqual([]);
  expect(
    sec("本轮新增")?.querySelector(".au-range-empty")?.textContent,
  ).toContain("新增内容都在响应里");
  expect(sec("历史")?.querySelector(".au-sec-n")?.textContent).toBe(
    "3 轮 · 5 块",
  );
  expect(sec("之后的消息")).toBeUndefined();
});

test("range 为 null：结构视图只有一张「消息」卡，不分历史与本轮", async () => {
  installStore({ s1: sample("s1") });
  mount();
  await screen.findByText("调用 11");
  await waitFor(() => expect(document.querySelector(".au-sec")).toBeTruthy());
  expect(document.querySelector("[data-scope]")).toBeNull();
  expect(sec("历史")).toBeUndefined();
  expect(sec("本轮新增")).toBeUndefined();
  expect(sec("消息")).toBeTruthy();
});

// ── JSON 视图 ──

const jsonPres = () => [
  ...(document.querySelector("[data-ajson]")?.querySelectorAll("pre") ?? []),
];
const jsonText = () =>
  jsonPres()
    .map((p) => p.textContent ?? "")
    .join("");
const rec = (seq: number) =>
  rangeStore().s1.find((c) => c.seq === seq) as CallRecord;

async function openJson(seq: number) {
  await openCall(seq);
  fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
  await waitFor(() =>
    expect(document.querySelector("[data-ajson]")).toBeTruthy(),
  );
}

test("JSON 视图：按 range 切三段，范围内那段是蓝底而不是分割线", async () => {
  installStore(rangeStore());
  mount();
  await screen.findByText("调用 03");
  await openJson(1);
  const pres = jsonPres();
  expect(pres).toHaveLength(3);
  const mid = pres[1] as HTMLElement;
  expect(mid.classList.contains("au-range")).toBe(true);
  expect(mid.classList.contains("is-range")).toBe(true);
  expect(mid.textContent).toContain("第 2 条");
  expect(mid.textContent).toContain("第 3 条");
  // 三段拼回去仍是完整 JSON，且可解析
  const call = rec(1);
  const full = exportJson({ request: call.request, response: call.response });
  expect(jsonText()).toBe(full);
  expect(JSON.parse(jsonText())).toEqual({
    request: call.request,
    response: call.response,
  });
});

test("JSON 视图：范围为空时三段变两段 + 一句说明，拼回仍是完整 JSON", async () => {
  installStore(rangeStore());
  mount();
  await screen.findByText("调用 03");
  await openJson(3);
  expect(jsonPres()).toHaveLength(2);
  expect(document.querySelector(".au-range")).toBeNull();
  expect(document.querySelector(".au-range-note")?.textContent).toContain(
    "新增内容都在响应里",
  );
  const call = rec(3);
  expect(jsonText()).toBe(
    exportJson({ request: call.request, response: call.response }),
  );
  expect(JSON.parse(jsonText())).toEqual({
    request: call.request,
    response: call.response,
  });
});
