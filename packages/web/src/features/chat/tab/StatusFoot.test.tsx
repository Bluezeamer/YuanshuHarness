import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { LAST_CALL, mount, USAGE } from "./testkit";
import { installWorld } from "./testkit.world";

vi.mock("../audit", () => ({
  AuditPane: () => <div data-testid="audit">审计</div>,
}));

const meta = (status: "running" | "archived" = "running") => ({
  title: "t",
  agentName: "编码实现",
  status,
});
const foot = () => document.querySelector("[data-chatstats]") as HTMLElement;
const flat = (el: Element) =>
  (el.textContent ?? "").replace(/\s+/g, " ").trim();
const usage = { usage: USAGE, lastCall: LAST_CALL };
// 悬停卡片有 450ms 的出现延迟
const hover = async (what: "speed" | "context" | "cache") => {
  const item = foot().querySelector(`[data-foot="${what}"]`) as HTMLElement;
  fireEvent.pointerEnter(item.closest(".u-hc") as HTMLElement);
  return waitFor(() => screen.getByRole("tooltip"), { timeout: 2000 });
};

test("页脚在输入卡下面、不在输入卡里：输入卡之后的最后一段", () => {
  installWorld();
  mount(usage, { meta: meta() });
  const main = document.querySelector(".ch-main") as HTMLElement;
  expect(main.lastElementChild).toBe(foot());
  expect(
    (document.querySelector(".ch-box") as HTMLElement).contains(foot()),
  ).toBe(false);
});

test("居中一行：tok/s ｜ 读条 + 38% 76k/200k ｜ 缓存 94.2%", () => {
  installWorld();
  mount(usage, { meta: meta() });
  const t = flat(foot());
  expect(t).toContain("64.2 tok/s");
  expect(t).toContain("38% 76k/200k");
  expect(t).toContain("缓存 94.2%");
  const meter = within(foot()).getByRole("meter", { name: "上下文占用" });
  expect(meter.getAttribute("aria-valuenow")).toBe("76000");
  expect(meter.getAttribute("aria-valuemax")).toBe("200000");
});

test("三项各有一张只读小卡，字段取自真实指标；小卡不可点", async () => {
  installWorld();
  mount(usage, { meta: meta() });
  let tip = await hover("speed");
  expect(flat(tip)).toContain("速度与耗时");
  expect(flat(tip)).toContain("生成速度64.2 tok/s");
  expect(flat(tip)).toContain("模型用时51.7 秒");
  expect(within(tip).queryAllByRole("button")).toHaveLength(0);
  fireEvent.pointerLeave(
    foot()
      .querySelector('[data-foot="speed"]')
      ?.closest(".u-hc") as HTMLElement,
  );

  tip = await hover("context");
  expect(flat(tip)).toContain("上下文");
  expect(flat(tip)).toContain("占用38%");
  expect(flat(tip)).toContain("已用76k / 200k");
  expect(flat(tip)).toContain("还剩124k");
  fireEvent.pointerLeave(
    foot()
      .querySelector('[data-foot="context"]')
      ?.closest(".u-hc") as HTMLElement,
  );

  tip = await hover("cache");
  expect(flat(tip)).toContain("缓存命中94.2%");
  expect(flat(tip)).toContain("累计1.2M tok");
});

test("不输出任何成本（页脚与三张小卡）", async () => {
  installWorld();
  mount(usage, { meta: meta() });
  const texts = [flat(foot())];
  for (const k of ["speed", "context", "cache"] as const) {
    const tip = await hover(k);
    texts.push(flat(tip));
    fireEvent.pointerLeave(
      foot()
        .querySelector(`[data-foot="${k}"]`)
        ?.closest(".u-hc") as HTMLElement,
    );
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  }
  for (const t of texts)
    expect(t).not.toMatch(/[$￥¥]|成本|费用|花费|cost|price/i);
});

test("没有用量数据：整行只说「暂无用量数据」，没有可悬停的项", () => {
  installWorld();
  mount({}, { meta: meta() });
  expect(flat(foot())).toBe("暂无用量数据");
  expect(foot().querySelector(".u-hc")).toBeNull();
});

test("占用窗口未知：只给总占用、不画读条，小卡里窗口写「—」", async () => {
  installWorld();
  mount(
    {
      usage: {
        ...USAGE,
        context: { used: 76_000, window: null, messages: 76_000 },
      },
      lastCall: LAST_CALL,
    },
    { meta: meta() },
  );
  expect(flat(foot())).toContain("76k/—");
  expect(within(foot()).queryByRole("meter")).toBeNull();
  const tip = await hover("context");
  expect(flat(tip)).toContain("已用76k / —");
  expect(flat(tip)).not.toContain("还剩");
});

test("归档：输入栏换成只读条、不发恢复请求；页脚仍在", () => {
  const w = installWorld();
  mount(usage, { meta: meta("archived") });
  const bar = document.querySelector(".ch-archived") as HTMLElement;
  expect(bar.textContent).toContain("已归档 · 只读");
  const btn = within(bar).getByRole("button", {
    name: "只读",
  }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  fireEvent.click(btn);
  expect(w.actions).toEqual([]);
  expect(foot()).toBeTruthy();
});

test("审计页保留页脚（它跟着聊天标签走，不属于哪个视图）", () => {
  installWorld();
  mount(usage, { meta: meta(), tab: { ctab: "audit" } });
  expect(screen.getByTestId("audit")).toBeTruthy();
  expect(flat(foot())).toContain("64.2 tok/s");
});

test("缺省没有会话元信息按运行中处理：显示输入框", () => {
  installWorld();
  mount(usage);
  expect(document.querySelector("[data-composer]")).toBeTruthy();
});

test("压缩失败：原因显示在输入卡上方", () => {
  installWorld();
  mount({ compactError: "上下文太短，无需压缩" }, { meta: meta() });
  expect(screen.getByRole("alert").textContent).toContain(
    "上下文太短，无需压缩",
  );
});

test("工作位置：页脚最前面只有一枚主机色圆点，主机与目录在悬停卡片里；元信息里没有就不画", async () => {
  installWorld();
  mount(usage, {
    meta: {
      ...meta(),
      place: { host: "dev1", hostName: "开发机", path: "/srv/app" },
    },
  });
  const place = foot().querySelector('[data-foot="place"]') as HTMLElement;
  expect(place).toBeTruthy();
  // 圆点旁没有任何文字，地址太长不占页脚
  expect(flat(place)).toBe("");
  expect(place.querySelector(".ch-foot-dot")).toBeTruthy();
  expect(screen.getByRole("img", { name: "工作位置：开发机" })).toBeTruthy();
  expect(foot().firstElementChild?.contains(place)).toBe(true);
  fireEvent.pointerEnter(place.closest(".u-hc") as HTMLElement);
  const tip = await waitFor(() => screen.getByRole("tooltip"), {
    timeout: 2000,
  });
  expect(flat(tip)).toContain("开发机");
  expect(flat(tip)).toContain("/srv/app");
  cleanup();
  mount(usage, { meta: meta() });
  expect(foot().querySelector('[data-foot="place"]')).toBeNull();
});

test("没有用量数据时工作位置照样在", () => {
  installWorld();
  mount(
    {},
    {
      meta: {
        ...meta(),
        place: { host: "server", hostName: "Server", path: "/w" },
      },
    },
  );
  expect(foot().querySelector('[data-foot="place"]')).toBeTruthy();
  expect(flat(foot())).toContain("暂无用量数据");
});

test("没有缓存数据：不画缓存一项，也不留多余的分隔线", () => {
  installWorld();
  mount(
    {
      usage: {
        ...USAGE,
        tokens: { input: 0, output: 200_000, cacheRead: 0, cacheWrite: 0 },
      },
      lastCall: LAST_CALL,
    },
    { meta: meta() },
  );
  expect(flat(foot())).not.toContain("缓存");
  expect(foot().querySelectorAll(".ch-sep")).toHaveLength(1);
});
