// 对应原型 tests/audit.smoke.cjs 的「单次调用的完整上下文」断言：结构视图、组成条、JSON 同形、复制、payload 容错。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { CallRecord } from "../../../api/calls";
import { api } from "./fakeapi";
import {
  clickRow,
  installStore,
  latest,
  loaded,
  mount,
  row,
  sections,
  setupEnv,
} from "./harness";
import { exportJson } from "./payload";
import { makeCall, sample } from "./testkit";

vi.mock("../../../api/calls", async () => (await import("./fakeapi")).api);

setupEnv();

// ── 单次调用的详情 ──

test("详情只拉选中的一条，切回已看过的不再请求", async () => {
  mount();
  await loaded();
  expect(api.getCall).toHaveBeenCalledTimes(1);
  expect(api.getCall).toHaveBeenLastCalledWith(null, "s1", "s1-c11");
  clickRow(row(5));
  await screen.findByText("调用 05");
  await waitFor(() => expect(api.getCall).toHaveBeenCalledTimes(2));
  clickRow(row(11));
  await screen.findByText("调用 11");
  expect(api.getCall).toHaveBeenCalledTimes(2);
});

test("点选另一条调用：请求段换成那一条的请求；越靠后的调用带着越多此前的消息", async () => {
  // 请求累积：第 n 次调用带 2n-1 条消息（1 / 3 / 5）
  const msgs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `第 ${i + 1} 条`,
    }));
  installStore({
    s1: [1, 2, 3].map((seq) =>
      makeCall("s1", {
        seq,
        turn: 1,
        trigger: "user",
        request: { system: "x", messages: msgs(seq * 2 - 1) },
      }),
    ),
  });
  mount();
  const msgNote = () => sections()[2]?.querySelector(".au-sec-n")?.textContent;
  await screen.findByText("调用 03");
  await waitFor(() => expect(msgNote()).toMatch(/^5 条/));
  clickRow(row(1));
  await screen.findByText("调用 01");
  await waitFor(() => expect(msgNote()).toMatch(/^1 条/));
  clickRow(row(2));
  await screen.findByText("调用 02");
  await waitFor(() => expect(msgNote()).toMatch(/^3 条/));
  expect(sections()[2]?.textContent).toContain("第 3 条");
  expect(sections()[2]?.textContent).not.toContain("第 4 条");
  // JSON 视图里的请求也是这一条的
  fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
  expect(JSON.parse(jsonText()).request.messages).toHaveLength(3);
});

test("详情头：序号 / 类型徽标 / 模型 / 时间 / 结构↔JSON / 复制", async () => {
  mount();
  await loaded();
  clickRow(row(3));
  await screen.findByText("调用 03");
  const head = document.querySelector(".au-dhead") as HTMLElement;
  expect(head.textContent).toContain("工具返回 · edit_file");
  expect(head.textContent).toContain("claude-x");
  expect(head.querySelector(".au-dtime")?.textContent).toMatch(
    /^\d\d-\d\d \d\d:\d\d:\d\d$/,
  );
  expect(
    within(head)
      .getByRole("radio", { name: "结构" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(within(head).getByRole("radio", { name: "JSON" })).toBeTruthy();
  expect(
    within(head).getByRole("button", { name: "复制请求与响应" }),
  ).toBeTruthy();
});

test("结构视图四段齐全；请求里的消息条数对得上", async () => {
  mount();
  await loaded();
  expect(
    [...document.querySelectorAll(".au-sec-t")].map((x) => x.textContent),
  ).toEqual(["系统提示词", "工具定义", "消息", "响应"]);
  expect(sections()[2]?.querySelector(".au-sec-n")?.textContent).toMatch(
    /^3 条/,
  );
});

test("系统提示词按块展示；cache 标记只出现在原始块带 cache_control 的那一块", async () => {
  mount();
  await loaded();
  // 系统提示词默认折叠：点开才看得到块
  fireEvent.click(screen.getByRole("button", { name: /系统提示词/ }));
  const sys = sections()[0] as HTMLElement;
  expect(sys.querySelectorAll(".au-blk")).toHaveLength(3);
  const marks = [...sys.querySelectorAll(".au-cache")].map(
    (x) => x.textContent,
  );
  expect(marks).toEqual(["cache ephemeral"]);
  expect(
    sys.querySelectorAll(".au-blk")[2]?.querySelector(".au-cache"),
  ).toBeTruthy();
});

test("没有 cache_control 的 payload 不出现 cache 标记（不伪造）", async () => {
  installStore({
    s1: [
      makeCall("s1", {
        seq: 1,
        turn: 1,
        trigger: "user",
        request: { system: "x", messages: [{ role: "user", content: "hi" }] },
      }),
    ],
  });
  mount();
  await screen.findByText("调用 01");
  await waitFor(() => expect(document.querySelector(".au-sec")).toBeTruthy());
  expect(document.querySelector(".au-cache")).toBeNull();
  // 服务端没有 core / session / agentsmd 拆分：这类标签也不展示
  expect(document.querySelector(".au-dbody")?.textContent).not.toMatch(
    /agentsmd|session\b/,
  );
});

test("系统提示词与工具定义默认折叠，展开后列出内容，折叠状态写进 afx.fold", async () => {
  mount();
  await loaded();
  expect(document.querySelectorAll(".au-toolrow")).toHaveLength(0);
  expect(
    document.querySelectorAll(".au-sec")[0]?.querySelector(".au-blk"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /工具定义/ }));
  const names = [...document.querySelectorAll(".au-toolrow .au-toolname")].map(
    (x) => x.textContent,
  );
  expect(names).toEqual(["read_file", "edit_file"]);
  expect(latest.afx?.fold).toEqual({ tools: false });
  fireEvent.click(screen.getByRole("button", { name: /系统提示词/ }));
  expect(
    document.querySelectorAll(".au-sec")[0]?.querySelectorAll(".au-blk"),
  ).toHaveLength(3);
  expect(latest.afx?.fold).toEqual({ tools: false, system: false });
  fireEvent.click(screen.getByRole("button", { name: /系统提示词/ }));
  expect(latest.afx?.fold).toEqual({ tools: false, system: true });
});

test("全部展开 / 全部收起：展开每一段与历史里的每一行，收起回到默认", async () => {
  installStore({
    s1: [
      makeCall("s1", {
        seq: 1,
        turn: 1,
        trigger: "user",
        range: { from: 2, to: 3 },
        request: {
          system: "x",
          messages: [
            { role: "user", content: "第一问" },
            { role: "assistant", content: "第一答" },
            { role: "user", content: "第二问" },
          ],
        },
      }),
    ],
  });
  mount();
  await screen.findByText("调用 01");
  await waitFor(() => expect(document.querySelector(".au-sec")).toBeTruthy());
  // 默认：历史折叠，本轮新增与响应展开
  const open = () =>
    sections().map((x) =>
      x.querySelector(".u-lrow-main")?.getAttribute("aria-expanded"),
    );
  expect(open()).toEqual(["false", "false", "false", "true", "true"]);
  fireEvent.click(screen.getByRole("button", { name: "全部展开" }));
  expect(open()).toEqual(["true", "true", "true", "true", "true"]);
  // 历史里的每一行也点开了全文
  expect(document.querySelectorAll(".au-msg-b")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "全部收起" }));
  expect(open()).toEqual(["false", "false", "false", "true", "true"]);
  expect(latest.afx?.fold).toEqual({});
});

test("历史按轮次分组，每条一行摘要，点开看全文；本轮新增直接展开", async () => {
  installStore({
    s1: [
      makeCall("s1", {
        seq: 1,
        turn: 2,
        trigger: "user",
        range: { from: 4, to: 5 },
        request: {
          system: "x",
          messages: [
            { role: "user", content: "第一问" },
            { role: "assistant", content: "第一答" },
            { role: "user", content: "第二问" },
            { role: "assistant", content: "第二答" },
            { role: "user", content: "第三问（本轮）" },
          ],
        },
      }),
    ],
  });
  mount();
  await screen.findByText("调用 01");
  await waitFor(() => expect(document.querySelector(".au-sec")).toBeTruthy());
  const hist = sections()[2] as HTMLElement;
  expect(hist.querySelector(".au-sec-t")?.textContent).toBe("历史");
  expect(hist.querySelector(".au-sec-n")?.textContent).toBe("2 轮 · 4 块");
  expect(hist.querySelector(".au-sec-b")).toBeNull();
  fireEvent.click(hist.querySelector(".u-lrow-main") as HTMLElement);
  expect(
    [...hist.querySelectorAll(".au-hround")].map((x) => x.textContent),
  ).toEqual(["第 1 轮", "第 2 轮"]);
  const rows = [...hist.querySelectorAll(".au-msg")];
  expect(rows).toHaveLength(4);
  expect(rows[0]?.textContent).toContain("user · text");
  expect(rows[0]?.textContent).toContain("第一问");
  // 全文默认不出现，点那一行才出现
  expect(hist.querySelector(".au-msg-b")).toBeNull();
  fireEvent.click(rows[1]?.querySelector(".u-lrow-main") as HTMLElement);
  expect(hist.querySelector(".au-msg-b")?.textContent).toBe("第一答");
  // 本轮新增默认展开，里面是完整块
  const cur = sections()[3] as HTMLElement;
  expect(cur.querySelector(".au-sec-t")?.textContent).toBe("本轮新增");
  expect(cur.querySelector(".au-blk-b")?.textContent).toBe("第三问（本轮）");
});

test("消息按部件拆块：tool_use 与 tool_result 各自成块，结果标来源 id", async () => {
  mount();
  await loaded();
  const body = sections()[2]?.textContent ?? "";
  expect(body).toContain("tool_use · read_file");
  expect(body).toContain("tool_result · toolu_1");
});

test("响应段给出 stop_reason 与正文，发起的工具成块", async () => {
  mount();
  await loaded();
  clickRow(row(3));
  await screen.findByText("调用 03");
  await waitFor(() => expect(sections()[3]?.textContent).toContain("回复 3"));
  const res = sections()[3] as HTMLElement;
  expect(res.querySelector(".au-sec-n")?.textContent).toMatch(/toolUse/);
  expect(res.textContent).toContain("tool_use · run_tests");
});

// ── 组成条 ──

test("组成条：四段宽度合计 100，读屏文字里的精确值之和等于入账", async () => {
  installStore({
    s1: [
      makeCall("s1", {
        seq: 1,
        turn: 1,
        trigger: "user",
        tokens: { system: 1234, tools: 567, history: 8910, current: 111 },
      }),
    ],
  });
  mount();
  await screen.findByText("调用 01");
  const bar = screen.getByRole("img", { name: /^请求的组成/ });
  const label = bar.getAttribute("aria-label") ?? "";
  expect(label).toBe(
    "请求的组成：系统 1,234 · 工具定义 567 · 历史 8,910 · 本轮 111",
  );
  const sum = [...label.matchAll(/([0-9,]+)(?: ·|$)/g)].reduce(
    (a, m) => a + Number((m[1] ?? "").replace(/,/g, "")),
    0,
  );
  const facts = document.querySelector(".au-facts")?.textContent ?? "";
  expect(sum).toBe(Number(facts.match(/入 ([0-9,]+)/)?.[1]?.replace(/,/g, "")));
  expect(sum).toBe(10822);
  const pct = [...bar.querySelectorAll("rect")].reduce(
    (a, r) => a + Number(r.getAttribute("data-pct")),
    0,
  );
  expect(pct).toBeCloseTo(100, 5);
  // 段与段之间有缝，相邻两段不贴在一起
  const rects = [...bar.querySelectorAll("rect")].map((r) => ({
    x: Number(r.getAttribute("x")),
    w: Number(r.getAttribute("width")),
  }));
  for (let i = 1; i < rects.length; i += 1) {
    const prev = rects[i - 1] as { x: number; w: number };
    expect((rects[i] as { x: number }).x - (prev.x + prev.w)).toBeGreaterThan(
      0,
    );
  }
  // 总宽不超出画布（viewBox 宽 1000）
  const end = rects.at(-1) as { x: number; w: number };
  expect(end.x + end.w).toBeLessThanOrEqual(1000.001);
});

test("facts：入 / 出 / 延迟 / stop_reason / 缓存读写", async () => {
  installStore({
    s1: [
      makeCall("s1", {
        seq: 1,
        turn: 1,
        trigger: "user",
        durationMs: 2340,
        tokens: { cacheRead: 1500, cacheWrite: 200 },
      }),
    ],
  });
  mount();
  await screen.findByText("调用 01");
  const facts = document.querySelector(".au-facts")?.textContent ?? "";
  expect(facts).toContain(
    "入 380 · 出 40 · 延迟 2.34s · stop_reason stop · 缓存 读 1.5k 写 200",
  );
});

test("estimated 才标「估算」，列表汇总与行入量加 ~；否则不标", async () => {
  installStore({
    s1: [
      makeCall("s1", {
        seq: 2,
        turn: 1,
        trigger: "user",
        tokens: { estimated: true },
      }),
      makeCall("s1", { seq: 1, turn: 1, trigger: "user" }),
    ],
  });
  mount();
  await screen.findByText("调用 02");
  expect(screen.getByText("估算")).toBeTruthy();
  expect(document.querySelector("[data-asum]")?.textContent).toContain("~");
  expect(row(2).querySelector(".u-lrow-sub")?.textContent).toContain("~380 入");
  expect(row(1).querySelector(".u-lrow-sub")?.textContent).not.toContain("~");
  clickRow(row(1));
  await screen.findByText("调用 01");
  expect(screen.queryByText("估算")).toBeNull();
});

// ── JSON 视图与复制 ──

const jsonPre = () => document.querySelector("[data-ajson]") as HTMLElement;
// JSON 视图可能被蓝色分割线切成两段 pre，拼回去才是完整 JSON。
const jsonText = () =>
  [...jsonPre().querySelectorAll("pre")]
    .map((p) => p.textContent ?? "")
    .join("");

test("JSON 视图是与 API 同形的 {request, response}，不含展示字段", async () => {
  mount();
  await loaded();
  fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
  expect(latest.afx?.mode).toBe("json");
  const rec = sample("s1").find((c) => c.seq === 11) as CallRecord;
  const parsed = JSON.parse(jsonText());
  expect(parsed).toEqual({ request: rec.request, response: rec.response });
  expect(Object.keys(parsed)).toEqual(["request", "response"]);
  expect(parsed.request.system).toHaveLength(3);
  expect(parsed.request.messages).toHaveLength(3);
  expect(parsed.request.tools).toHaveLength(2);
  expect(parsed.response.stopReason).toBe("stop");
  // 展示字段不进 JSON；原始块自带的 cache_control 保留
  expect(parsed.request.system[0]).not.toHaveProperty("label");
  expect(parsed.request.system[2]).not.toHaveProperty("cache");
  expect(parsed.request.system[2].cache_control).toEqual({ type: "ephemeral" });
  expect(jsonPre().textContent).not.toContain("cache ephemeral");
  // 切回结构视图
  fireEvent.click(screen.getByRole("radio", { name: "结构" }));
  expect(latest.afx?.mode).toBe("struct");
  expect(jsonPre()).toBeNull();
});

test("复制：写入剪贴板的就是 JSON 视图里的那一份，内容干净", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  mount();
  await loaded();
  const btn = screen.getByRole("button", { name: "复制请求与响应" });
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(btn);
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  const rec = sample("s1").find((c) => c.seq === 11) as CallRecord;
  const text = writeText.mock.calls[0]?.[0] as string;
  expect(text).toBe(exportJson(rec));
  expect(JSON.parse(text)).toEqual({
    request: rec.request,
    response: rec.response,
  });
  expect(text).not.toContain("cache ephemeral");
});

test("详情没载入前复制按钮不可用", async () => {
  api.getCall.mockImplementation(() => new Promise(() => {}));
  mount();
  await screen.findByText("调用 11");
  expect(
    (
      screen.getByRole("button", {
        name: "复制请求与响应",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText("载入中…")).toBeTruthy();
});

// ── payload 形状容错（组件层） ──

test("OpenAI chat 风格：system/developer、tool_calls、tool 消息、tools.function", async () => {
  installStore({
    s1: [
      makeCall("s1", {
        seq: 1,
        turn: 1,
        trigger: "user",
        request: {
          model: "gpt-x",
          messages: [
            { role: "system", content: "系统提示" },
            { role: "user", content: "你好" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "ls", arguments: "{}" },
                },
              ],
            },
            { role: "tool", tool_call_id: "c1", content: "a b" },
          ],
          tools: [
            {
              type: "function",
              function: { name: "ls", description: "列目录" },
            },
          ],
        },
      }),
    ],
  });
  mount();
  await screen.findByText("调用 01");
  await waitFor(() => expect(document.querySelector(".au-sec")).toBeTruthy());
  expect(sections()[0]?.textContent).toContain("系统提示");
  expect(sections()[2]?.textContent).toContain("tool_use · ls");
  expect(sections()[2]?.textContent).toContain("tool_result · c1");
  fireEvent.click(screen.getByRole("button", { name: /工具定义/ }));
  expect(document.querySelector(".au-toolrow")?.textContent).toContain(
    "列目录",
  );
});

test("Anthropic 风格是默认夹具；未知形状：提示去看 JSON，JSON 视图仍是完整原文", async () => {
  const request = { foo: "bar", nested: { a: [1, 2] } };
  installStore({
    s1: [makeCall("s1", { seq: 1, turn: 1, trigger: "user", request })],
  });
  mount();
  await screen.findByText("调用 01");
  await screen.findByText(/形状无法识别/);
  expect(document.querySelectorAll(".au-blk").length).toBeGreaterThan(0); // 响应仍可展示
  fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
  expect(JSON.parse(jsonPre().textContent ?? "").request).toEqual(request);
});
