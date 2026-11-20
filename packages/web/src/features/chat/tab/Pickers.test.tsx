import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { mount } from "./testkit";
import {
  baseConfig,
  installWorld,
  PROVIDERS,
  provider,
  spec,
  type World,
} from "./testkit.world";

vi.mock("../audit", () => ({ AuditPane: () => null }));

const meta = { title: "t", agentName: "编码实现", status: "running" as const };
const q = (sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as HTMLElement;
const qa = (sel: string, root: ParentNode = document) => [
  ...root.querySelectorAll<HTMLElement>(sel),
];

async function ready(over: Partial<World> = {}) {
  const w = installWorld(over);
  const h = mount({}, { meta });
  await waitFor(() =>
    expect(q("[data-modelname]").textContent).not.toBe("默认模型"),
  );
  return { w, h };
}
const modelName = () => q("[data-modelname]").textContent;
const effortName = () => q("[data-effortname]").textContent;
const lastPatch = (w: World) => w.patches.at(-1)?.patch;
const modelOf = (w: World) =>
  (lastPatch(w)?.model ?? {}) as { model?: string; reasoning?: string };
const openModels = () => fireEvent.click(q("[data-modelpick]"));
const search = () => q("[data-modelq]") as HTMLInputElement;
// ListRow 的点击在行里的主按钮上，行本身（带 data-*）只是容器
const press = (row: HTMLElement) =>
  fireEvent.click(row.querySelector("button") as HTMLElement);
const modelPop = () => screen.getByRole("dialog", { name: "选择模型" });
const levels = () =>
  within(modelPop())
    .getAllByRole("radio")
    .map((r) => r.textContent);

test("工具行自左向右：附件 · 审批 …… 模型与档位 · 发送；没有 MCP 与 / 按钮，档位并进模型按钮", async () => {
  await ready();
  const row = q(".ch-toolrow");
  const order = [...row.children].map((el) => {
    const d = (el as HTMLElement).dataset;
    return "modelpick" in d
      ? "model"
      : "permpick" in d
        ? "perm"
        : "plus" in d
          ? "plus"
          : el.classList.contains("ch-sp")
            ? "sp"
            : el.getAttribute("aria-label") === "发送"
              ? "send"
              : "?";
  });
  expect(order).toEqual(["plus", "perm", "sp", "model", "send"]);
  expect(q("[data-mcppick]")).toBeNull();
  expect(q("[data-slash]")).toBeNull();
  expect(q("[data-effortpick]")).toBeNull();
});

test("跟随默认：模型与档位取自全局默认（Claude Sonnet 5 · 中）", async () => {
  await ready();
  expect(modelName()).toBe("Claude Sonnet 5");
  expect(effortName()).toBe("中");
});

test("模型选单：搜索吸附顶部并聚焦，按供应商分组，组头写认证方式，每行右侧给窗口，当前打勾", async () => {
  await ready();
  openModels();
  expect(document.activeElement).toBe(search());
  expect(qa(".ch-mdl-g")).toHaveLength(5);
  expect(qa("[data-pick-model]")).toHaveLength(10);
  expect(qa(".ch-mdl-gh .t-mono").map((e) => e.textContent)).toEqual([
    "订阅",
    "API Key",
    "API Key",
    "环境变量",
    "API Key",
  ]);
  const sonnet = q('[data-pick-model="claude-sonnet-5"]');
  expect(sonnet.querySelector(".ch-mdl-trail .t-mono")?.textContent).toBe(
    "200K",
  );
  expect(
    q('[data-pick-model="deepseek-v4"] .ch-mdl-trail .t-mono').textContent,
  ).toBe("1M");
  expect(qa("[data-pick-model][data-current]")).toEqual([sonnet]);
  expect(sonnet.querySelector("svg")).toBeTruthy();
  // 未连接的供应商不出现
  expect(q('[data-pick-model="gemini-3"]')).toBeNull();
  // 搜索框在列表之前（吸附顶部）
  expect(
    q(".ch-mdl-q").compareDocumentPosition(q(".ch-mdl-list")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("搜索匹配名称 / id / 供应商 / 认证方式，只保留命中的分组", async () => {
  await ready();
  openModels();
  fireEvent.change(search(), { target: { value: "deepseek" } });
  expect(qa("[data-pick-model]")).toHaveLength(2);
  expect(qa(".ch-mdl-g")).toHaveLength(1);
  fireEvent.change(search(), { target: { value: "sonnet" } });
  expect(qa("[data-pick-model]")).toHaveLength(2);
  expect(qa(".ch-mdl-g")).toHaveLength(2);
  fireEvent.change(search(), { target: { value: "openrouter" } });
  expect(qa("[data-pick-model]")).toHaveLength(1);
  fireEvent.change(search(), { target: { value: "订阅" } });
  expect(qa("[data-pick-model]")).toHaveLength(3);
  fireEvent.change(search(), { target: { value: "gpt-5-nano" } });
  expect(qa("[data-pick-model]")).toHaveLength(1);
});

test("筛选只重绘列表，搜索框不丢焦点；空结果给空态，清空后恢复", async () => {
  await ready();
  openModels();
  const input = search();
  fireEvent.change(input, { target: { value: "gpt" } });
  expect(document.activeElement).toBe(input);
  expect(search()).toBe(input);
  fireEvent.change(input, { target: { value: "zzz" } });
  expect(qa("[data-pick-model]")).toHaveLength(0);
  expect(q("[data-mmdlempty]").textContent).toContain("没有匹配");
  fireEvent.change(input, { target: { value: "" } });
  expect(qa("[data-pick-model]")).toHaveLength(10);
  expect(q("[data-mmdlempty]")).toBeNull();
});

test("↑↓ 移光标、Enter 选中：写回会话配置（只发 model 分区）", async () => {
  const { w } = await ready();
  openModels();
  // 光标起点是当前模型（第 1 行），↓ 到第 2 行 Claude Opus 4.8
  fireEvent.keyDown(search(), { key: "ArrowDown" });
  expect(qa("[data-pick-model]")[1]?.hasAttribute("data-cursor")).toBe(true);
  fireEvent.keyDown(search(), { key: "Enter" });
  expect(screen.queryByRole("dialog", { name: "选择模型" })).toBeNull();
  await waitFor(() => expect(modelName()).toBe("Claude Opus 4.8"));
  expect(w.patches).toHaveLength(1);
  expect(w.patches[0]?.baseRev).toBe(3);
  expect(lastPatch(w)).toEqual({
    model: {
      mode: "explicit",
      provider: "anthropic",
      model: "claude-opus-4-8",
      reasoning: "medium",
    },
  });
});

test("搜索后 Enter 取第一条；↑ 在列表内循环回到末项；Esc 关闭", async () => {
  const { w } = await ready();
  openModels();
  fireEvent.change(search(), { target: { value: "haiku" } });
  fireEvent.keyDown(search(), { key: "Enter" });
  await waitFor(() => expect(modelName()).toBe("Claude Haiku 5.5"));
  expect(w.patches).toHaveLength(1);

  openModels();
  fireEvent.keyDown(search(), { key: "ArrowUp" });
  // 从当前（Haiku，第 3 行）往上 → 第 2 行；连按到顶再回绕到末项
  fireEvent.change(search(), { target: { value: "" } });
  const rows = qa("[data-pick-model]");
  fireEvent.keyDown(search(), { key: "ArrowUp" });
  for (let i = 0; i < rows.length; i++)
    fireEvent.keyDown(search(), { key: "ArrowUp" });
  expect(qa("[data-pick-model][data-cursor]")).toHaveLength(1);
  // 回绕后光标总在列表内，不溢出
  fireEvent.keyDown(search(), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "选择模型" })).toBeNull();
  expect(w.patches).toHaveLength(1);
});

test("↑ 从首项循环到末项", async () => {
  const { w } = await ready();
  openModels();
  fireEvent.keyDown(search(), { key: "ArrowUp" });
  const rows = qa("[data-pick-model]");
  expect(rows.at(-1)?.hasAttribute("data-cursor")).toBe(true);
  fireEvent.keyDown(search(), { key: "Enter" });
  await waitFor(() => expect(w.patches).toHaveLength(1));
  expect(modelOf(w).model).toBe("or-sonnet");
});

test("换模型保留思考档位意图：新模型不支持 medium → 落到最近一档 low（同距取低）", async () => {
  const { w } = await ready();
  openModels();
  fireEvent.change(search(), { target: { value: "qwen" } });
  press(qa("[data-pick-model]")[0] as HTMLElement);
  await waitFor(() => expect(modelName()).toBe("Qwen3.8 27B"));
  expect(effortName()).toBe("低");
  expect(lastPatch(w)).toEqual({
    model: {
      mode: "explicit",
      provider: "qwen",
      model: "qwen3-8-27b",
      reasoning: "low",
    },
  });
});

test("换到声明了默认档位的模型：落在它的默认档位，而不是按当前档位凑最近的", async () => {
  const providers = PROVIDERS.map((p) =>
    p.id === "qwen"
      ? {
          ...p,
          models: p.models.map((m) => ({
            ...m,
            defaultLevel: "high" as const,
          })),
        }
      : p,
  );
  const { w } = await ready({ providers });
  expect(effortName()).toBe("中");
  openModels();
  fireEvent.change(search(), { target: { value: "qwen" } });
  press(qa("[data-pick-model]")[0] as HTMLElement);
  await waitFor(() => expect(modelName()).toBe("Qwen3.8 27B"));
  expect(modelOf(w).reasoning).toBe("high");
});

test("新模型支持当前档位就沿用；档位绝不使用未声明的级别", async () => {
  const { w } = await ready({
    config: baseConfig({
      model: {
        mode: "explicit",
        provider: "anthropic",
        model: "claude-sonnet-5",
        reasoning: "max",
      },
    }),
  });
  expect(effortName()).toBe("最高");
  openModels();
  fireEvent.change(search(), { target: { value: "opus" } });
  press(qa("[data-pick-model]")[0] as HTMLElement);
  await waitFor(() => expect(modelName()).toBe("Claude Opus 4.8"));
  expect(modelOf(w).reasoning).toBe("max");

  // 再切到只声明 off/low/high 的模型：max 不在声明里，最近一档是 high
  openModels();
  fireEvent.change(search(), { target: { value: "qwen" } });
  press(qa("[data-pick-model]")[0] as HTMLElement);
  await waitFor(() => expect(modelName()).toBe("Qwen3.8 27B"));
  expect(modelOf(w).reasoning).toBe("high");
});

test("推理强度在模型选单底部：只列该模型声明的级别，当前档选中", async () => {
  await ready();
  openModels();
  expect(levels()).toEqual(["关闭", "低", "中", "高", "极高", "最高"]);
  expect(
    within(modelPop())
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("aria-checked") === "true")
      .map((r) => r.textContent),
  ).toEqual(["中"]);
});

test("改档若此前是跟随 agent 则落成显式指定（带当前供应商与模型）", async () => {
  const { w } = await ready();
  openModels();
  fireEvent.click(within(modelPop()).getByRole("radio", { name: "高" }));
  await waitFor(() => expect(effortName()).toBe("高"));
  expect(lastPatch(w)).toEqual({
    model: {
      mode: "explicit",
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoning: "high",
    },
  });
});

test("不支持超档的模型只给三档，带映射的写 high → xhigh", async () => {
  const { w } = await ready({
    config: baseConfig({
      model: {
        mode: "explicit",
        provider: "qwen",
        model: "qwen3-8-27b",
        reasoning: "low",
      },
    }),
  });
  openModels();
  expect(levels()).toEqual(["关闭", "低", "高"]);
  expect(modelPop().textContent).not.toContain("→");
  fireEvent.click(within(modelPop()).getByRole("radio", { name: "高" }));
  await waitFor(() => expect(effortName()).toBe("高"));
  expect(modelOf(w).reasoning).toBe("high");
  openModels();
  expect(modelPop().textContent).toContain("high → xhigh");
});

test("配置保存失败：给出原因，界面保持原值", async () => {
  const { w } = await ready();
  w.fail = { status: 400, body: { error: "unknown_model" } };
  openModels();
  fireEvent.change(search(), { target: { value: "gpt-5-nano" } });
  fireEvent.keyDown(search(), { key: "Enter" });
  await waitFor(() => expect(w.patches).toHaveLength(1));
  await act(async () => {});
  expect(modelName()).toBe("Claude Sonnet 5");
});

test("审批按钮显示本会话生效的档位；点开可切四项（含跟随全局，写明当前全局值），即时 PATCH", async () => {
  const w = installWorld({ config: baseConfig({ permissionTier: null }) });
  mount({}, { meta });
  await waitFor(() => expect(q("[data-permname]").textContent).toBe("规则"));
  expect(q("[data-permpick]").hasAttribute("data-override")).toBe(false);
  fireEvent.click(q("[data-permpick]"));
  const pop = screen.getByRole("dialog", { name: "审批档位" });
  const tiers = qa("[data-perm-tier]", pop);
  expect(tiers.map((t) => t.dataset.permTier)).toEqual([
    "null",
    "rules",
    "auto",
    "full",
  ]);
  expect(tiers[0]?.textContent).toContain("跟随全局 · 规则");
  expect(tiers[0]?.hasAttribute("data-current")).toBe(true);
  // 没配审批模型：「模型」档置灰并写明去哪配
  const auto = q('[data-perm-tier="auto"]', pop);
  expect(auto.getAttribute("aria-disabled")).toBe("true");
  expect(auto.textContent).toContain("审批模型");
  press(auto);
  expect(lastPatch(w)).toBeUndefined();
  press(q('[data-perm-tier="full"]', pop));
  await waitFor(() => expect(q("[data-permname]").textContent).toBe("通过"));
  expect(q("[data-permpick]").hasAttribute("data-override")).toBe(true);
  expect(lastPatch(w)).toEqual({ permissionTier: "full" });
});

test("跟随全局：全局默认改过，再打开时跟随项与按钮都写现值；选「跟随」清掉覆盖", async () => {
  const w = installWorld({
    config: baseConfig({ permissionTier: "full" }),
    defaults: {
      permissionTier: "rules",
      reviewModel: { provider: "anthropic", model: "x", thinking: null },
    },
  });
  mount({}, { meta });
  await waitFor(() => expect(q("[data-permname]").textContent).toBe("通过"));
  // 别处把全局默认改成了「模型」
  w.defaults = { ...w.defaults, permissionTier: "auto" };
  fireEvent.click(q("[data-permpick]"));
  const pop = screen.getByRole("dialog", { name: "审批档位" });
  await waitFor(() =>
    expect(q('[data-perm-tier="null"]', pop).textContent).toContain(
      "跟随全局 · 模型",
    ),
  );
  // 配了审批模型，「模型」档可选
  expect(q('[data-perm-tier="auto"]', pop).hasAttribute("aria-disabled")).toBe(
    false,
  );
  press(q('[data-perm-tier="null"]', pop));
  await waitFor(() => expect(q("[data-permname]").textContent).toBe("模型"));
  expect(lastPatch(w)).toEqual({ permissionTier: null });
  expect(q("[data-permpick]").hasAttribute("data-override")).toBe(false);
});

test("没测过的自定义端点也能选，只有最近一次测试失败的才被排除", async () => {
  const model = (id: string) => ({
    ...spec(id, id),
    source: "manual" as const,
  });
  const untested = {
    ...provider("local-a", "本地 A", "key", [model("a-1")], "warn"),
    custom: true,
  };
  const failed = {
    ...provider("local-b", "本地 B", "key", [model("b-1")], "warn"),
    custom: true,
    lastTest: {
      at: "2026-10-25T06:00:00.000Z",
      ok: false,
      ttft: 0,
      total: 30,
      stage: "models" as const,
      errorCode: "unauthorized",
    },
  };
  await ready({ providers: [...PROVIDERS, untested, failed] });
  openModels();
  // 没测过：待核验（warn）但没有失败记录，可选
  expect(q('[data-pick-model="a-1"]')).toBeTruthy();
  // 测过且失败：确认连不上，不列
  expect(q('[data-pick-model="b-1"]')).toBeNull();
  // 未配置凭据（off）仍不列
  expect(q('[data-pick-model="gemini-3"]')).toBeNull();
});

test("供应商都取不到时：模型选单给空态，不挡发送", async () => {
  installWorld({ providers: [] });
  mount({}, { meta, draft: { text: "hi" } });
  await act(async () => {});
  openModels();
  expect(q("[data-mmdlempty]").textContent).toContain("没有可选的供应商");
  expect(
    (screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("没有可切换的模式时不显示模式按钮", async () => {
  await ready();
  expect(q("[data-modepick]")).toBeNull();
});

test("模式按钮：显示当前模式，点开可切换并可退出", async () => {
  const { w } = await ready({
    modes: {
      modes: [
        { id: "m-plan", name: "plan" },
        { id: "m-review", name: "review" },
      ],
      activeModeId: null,
    },
  });
  await waitFor(() => expect(q("[data-modename]").textContent).toBe("无模式"));
  fireEvent.click(q("[data-modepick]"));
  press(q('[data-mode-id="m-plan"]'));
  await waitFor(() => expect(q("[data-modename]").textContent).toBe("plan"));
  expect(w.modes.activeModeId).toBe("m-plan");
  fireEvent.click(q("[data-modepick]"));
  press(q('[data-mode-id="null"]'));
  await waitFor(() => expect(q("[data-modename]").textContent).toBe("无模式"));
  expect(w.modes.activeModeId).toBeNull();
});

test("审批菜单里点当前已生效的那一项：只收起，不重复发请求", async () => {
  const w = installWorld({ config: baseConfig({ permissionTier: null }) });
  mount({}, { meta });
  await waitFor(() => expect(q("[data-permname]").textContent).toBe("规则"));
  fireEvent.click(q("[data-permpick]"));
  const pop = screen.getByRole("dialog", { name: "审批档位" });
  press(q('[data-perm-tier="null"]', pop));
  expect(screen.queryByRole("dialog", { name: "审批档位" })).toBeNull();
  await act(async () => {});
  expect(w.patches).toHaveLength(0);
});
