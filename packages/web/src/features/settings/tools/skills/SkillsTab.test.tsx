import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { clearToasts } from "../../../../ui";
import { mountSkills, skill } from "./testkit";

afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
});

const rail = () => screen.getByRole("complementary", { name: "技能" });
const rowOf = (n: string) =>
  within(rail()).getByText(n).closest(".u-lrow") as HTMLElement;
const names = () =>
  [...rail().querySelectorAll(".u-lrow-label")].map((e) => e.textContent);
const choose = (n: string) => fireEvent.click(within(rail()).getByText(n));
const detail = (n: string) =>
  screen.getByRole("article", { name: `${n} 详情` });
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const menuItem = (name: string | RegExp) => {
  fireEvent.click(button("更多操作"));
  fireEvent.click(screen.getByRole("menuitem", { name }));
};
const status = (n: string) =>
  within(rowOf(n)).getByRole("img").getAttribute("aria-label");
const envs = () =>
  [...document.querySelectorAll(".tp-env")].map((e) =>
    e.textContent?.replace(/\s+/g, " "),
  );

test("左列表：每行 来源 · 版本、分发一致数与状态点；新装的排在前，不写安装位置", async () => {
  await mountSkills();
  expect(names()).toEqual([
    "code-review",
    "k8s-ops",
    "pdf-tools",
    "data-viz",
    "local-notes",
    "release-notes",
  ]);
  expect(rowOf("code-review").textContent).toContain("npm · 1.4.2");
  expect(rowOf("code-review").textContent).toContain("2/2");
  expect(status("code-review")).toBe("可更新");
  expect(status("k8s-ops")).toBe("落后 1");
  expect(status("pdf-tools")).toBe("一致");
  expect(rowOf("local-notes").textContent).toContain("本地 · 不跟踪版本");
  expect(status("release-notes")).toBe("待分发");
  expect(rail().textContent).not.toContain(".agents/skills");
});

test("默认选中第一个；详情：来源、版本、各环境分发、内容文件", async () => {
  await mountSkills();
  const d = detail("code-review");
  expect(d.textContent).toContain("code-review 的描述");
  expect(d.textContent).toContain("@acme/code-review");
  expect(d.textContent).toContain("1.4.2");
  expect(d.textContent).toContain("最新 1.5.0");
  expect(envs()).toEqual([
    expect.stringContaining("本机"),
    expect.stringContaining("GPU 训练机"),
  ]);
  expect(envs().every((e) => e?.includes("一致"))).toBe(true);
  await waitFor(() => expect(d.textContent).toContain("3 个文件"));
  expect(d.textContent).toContain("references/severity.md");
  expect(d.textContent).not.toContain("安装位置");
});

test("全局开关进草稿：项目级默认关；打开后点保存才 PATCH，列表行副标题标「全局」，分发区随之出现", async () => {
  const { fake } = await mountSkills([
    skill("code-review", { scope: "project", copies: {} }),
  ]);
  const sw = screen.getByRole("switch", { name: "code-review 全局" });
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(rowOf("code-review").textContent).not.toContain("全局");
  expect(envs()).toEqual([]);
  fireEvent.click(sw);
  expect(fake.called("PATCH", /\/skills\/code-review$/)).toHaveLength(0);
  const bar = screen.getByRole("region", { name: "保存" });
  fireEvent.click(within(bar).getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(fake.called("PATCH", /\/skills\/code-review$/)[0]?.body).toEqual({
      scope: "global",
    }),
  );
  await waitFor(() =>
    expect(rowOf("code-review").textContent).toContain("全局"),
  );
  await waitFor(() => expect(envs().length).toBe(2));
});

test("项目级技能不按环境分发：不显示待分发与补齐，分发区只写同步规则", async () => {
  await mountSkills([skill("code-review", { scope: "project", copies: {} })]);
  expect(status("code-review")).toBe("就绪");
  const d = detail("code-review");
  expect(d.textContent).toContain("项目级技能不按环境分发");
  expect(envs()).toEqual([]);
  expect(within(d).queryByRole("button", { name: /补齐|分发/ })).toBeNull();
  expect(rowOf("code-review").textContent).not.toMatch(/\d+\/\d+/);
});

test("可更新：主按钮「更新到 X」，更新只改库；环境副本落后后给「补齐」", async () => {
  const { fake } = await mountSkills();
  fireEvent.click(button("更新到 1.5.0"));
  await waitFor(() =>
    expect(fake.called("POST", /\/skills\/code-review\/update$/)).toHaveLength(
      1,
    ),
  );
  expect(await screen.findByText("已更新到 1.5.0")).toBeTruthy();
  expect(
    await screen.findByRole("button", { name: "补齐 2 个环境" }),
  ).toBeTruthy();
  expect(envs().every((e) => e?.includes("落后（库里是 1.5.0）"))).toBe(true);
  expect(status("code-review")).toBe("落后 2");
});

test("环境落后：补齐只补落后的环境，补到库里现有版本，不联网换版本", async () => {
  const { fake } = await mountSkills();
  choose("k8s-ops");
  fireEvent.click(await screen.findByRole("button", { name: "补齐 1 个环境" }));
  await waitFor(() =>
    expect(fake.called("POST", /\/skills\/k8s-ops\/sync$/)).toHaveLength(1),
  );
  expect(fake.called("POST", /\/skills\/k8s-ops\/sync$/)[0]?.body).toEqual({
    hostIds: ["gpu"],
  });
  expect(fake.called("GET", /\/versions$/)).toHaveLength(0);
  await waitFor(() => expect(status("k8s-ops")).toBe("一致"));
  expect(screen.queryByRole("button", { name: /补齐/ })).toBeNull();
});

test("单个环境的「补齐」「分发」只带该环境", async () => {
  const { fake } = await mountSkills();
  choose("k8s-ops");
  const row = within(detail("k8s-ops"))
    .getByText("GPU 训练机")
    .closest(".tp-env") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "补齐" }));
  await waitFor(() =>
    expect(fake.called("POST", /\/k8s-ops\/sync$/)[0]?.body).toEqual({
      hostIds: ["gpu"],
    }),
  );

  choose("release-notes");
  const local = within(detail("release-notes"))
    .getByText("本机")
    .closest(".tp-env") as HTMLElement;
  fireEvent.click(within(local).getByRole("button", { name: "分发" }));
  await waitFor(() =>
    expect(
      fake.called("POST", /\/release-notes\/distribute$/)[0]?.body,
    ).toEqual({
      hostIds: ["local"],
    }),
  );
});

test("未分发：主按钮把所有缺副本的环境分发出去", async () => {
  const { fake } = await mountSkills();
  choose("release-notes");
  fireEvent.click(await screen.findByRole("button", { name: "补齐 2 个环境" }));
  await waitFor(() =>
    expect(fake.called("POST", /\/release-notes\/distribute$/)).toHaveLength(1),
  );
  expect(fake.called("POST", /\/release-notes\/distribute$/)[0]?.body).toEqual({
    hostIds: ["local", "gpu"],
  });
  await waitFor(() => expect(status("release-notes")).toBe("一致"));
});

test("原件所在的环境不推，也不给按钮", async () => {
  await mountSkills([
    skill("env-skill", {
      origin: { kind: "observed", hostId: "gpu", path: "/opt/s" },
      version: null,
      latestVersion: null,
      copies: { local: null, gpu: "—" },
    }),
  ]);
  const gpu = [...document.querySelectorAll<HTMLElement>(".tp-env")].find((e) =>
    e.textContent?.includes("GPU 训练机"),
  ) as HTMLElement;
  expect(gpu.textContent).toContain("原件所在");
  expect(within(gpu).queryByRole("button")).toBeNull();
  expect(screen.getByRole("button", { name: "补齐 1 个环境" })).toBeTruthy();
});

test("选择版本=锁定：锁定后不催更新，补齐只补到锁定版；解除锁定回到可更新", async () => {
  const { fake } = await mountSkills();
  menuItem("选择版本");
  const dlg = await screen.findByRole("dialog", { name: /选择版本/ });
  const opts = await within(dlg).findAllByRole("radio");
  expect(opts).toHaveLength(4);
  const apply = within(dlg).getByRole("button", { name: "锁到此版本" });
  expect((apply as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(dlg.querySelector('[data-v="1.4.0"]') as HTMLElement);
  fireEvent.click(apply);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fake.called("POST", /\/code-review\/lock$/)[0]?.body).toEqual({
    version: "1.4.0",
  });
  expect(detail("code-review").textContent).toContain("已锁定");
  expect(screen.queryByRole("button", { name: /更新到/ })).toBeNull();
  // 库换了版本，环境副本还在 1.4.2：补齐补到库里现有版本，不去联网换
  fireEvent.click(await screen.findByRole("button", { name: "补齐 2 个环境" }));
  await waitFor(() => expect(status("code-review")).toBe("锁定"));
  expect(fake.called("GET", /\/code-review\/versions$/)).toHaveLength(1); // 只有打开弹窗那一次

  menuItem("解除锁定");
  await waitFor(() => expect(status("code-review")).toBe("可更新"));
});

test("禁用：状态已禁用，不再给更新与补齐；菜单变成启用", async () => {
  const { fake } = await mountSkills();
  choose("k8s-ops");
  menuItem("禁用");
  await waitFor(() => expect(status("k8s-ops")).toBe("已禁用"));
  expect(fake.called("POST", /\/skills\/batch$/)[0]?.body).toEqual({
    names: ["k8s-ops"],
    action: "disable",
  });
  expect(screen.queryByRole("button", { name: /补齐/ })).toBeNull();
  fireEvent.click(button("更多操作"));
  expect(screen.getByRole("menuitem", { name: "启用" })).toBeTruthy();
});

test("左列表行的菜单：更新、禁用、卸载不用先选中", async () => {
  const { fake } = await mountSkills();
  fireEvent.click(
    within(rowOf("data-viz")).getByRole("button", { name: "data-viz 的操作" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "更新到 v1.1.0" }));
  await waitFor(() =>
    expect(fake.called("POST", /\/data-viz\/update$/)).toHaveLength(1),
  );
});

test("检查更新（列表头菜单）：向每个跟踪版本的来源问一遍，汇总来源数", async () => {
  const { fake } = await mountSkills();
  fireEvent.click(screen.getByRole("button", { name: "技能的操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "检查更新" }));
  expect(await screen.findByText("检查完成：5 个来源")).toBeTruthy();
  expect(fake.called("GET", /\/versions$/)).toHaveLength(5);
});

test("搜索覆盖名称、描述与来源；没有命中给提示", async () => {
  await mountSkills();
  const box = screen.getByLabelText("筛选名称、描述或来源");
  fireEvent.change(box, { target: { value: "acme/k8s" } });
  expect(names()).toEqual(["k8s-ops"]);
  fireEvent.change(box, { target: { value: "没有这个" } });
  expect(screen.getByText("没有匹配的技能")).toBeTruthy();
});

test("空库：不编造数据，给安装入口", async () => {
  await mountSkills([]);
  expect(screen.getByText("技能库是空的")).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: "安装技能" }).length,
  ).toBeGreaterThan(0);
});
