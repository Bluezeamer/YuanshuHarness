// 技能页的弹窗：安装（粘贴来源）、文件查看、卸载确认。
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { choose } from "../../../../test/select";
import { clearToasts } from "../../../../ui";
import { mountSkills, skill } from "./testkit";

afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
});

const rail = () => screen.getByRole("complementary", { name: "技能" });
const names = () =>
  [...rail().querySelectorAll(".u-lrow-label")].map((e) => e.textContent);
const choosen = (n: string) => fireEvent.click(within(rail()).getByText(n));
const openInstall = () =>
  fireEvent.click(screen.getByRole("button", { name: "安装技能" }));
const kind = (label: string) =>
  fireEvent.click(screen.getByRole("radio", { name: label }));
const typeSpec = (v: string) =>
  fireEvent.change(document.querySelector("input.u-inp") as HTMLElement, {
    target: { value: v },
  });
const submit = () =>
  screen.getByRole("button", {
    name: /^(装进库|装这一个)$/,
  }) as HTMLButtonElement;
const pv = (k: "source" | "version") =>
  screen.getByTestId(`pv-${k}`).textContent;
const openRemove = () => {
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "卸载" }));
};

test("安装弹窗：来源一项，没有名称、描述、作用域输入，也不写安装路径", async () => {
  await mountSkills();
  openInstall();
  const dlg = await screen.findByRole("dialog", { name: "安装技能" });
  expect(dlg.querySelectorAll("input.u-inp")).toHaveLength(1);
  const t = dlg.textContent ?? "";
  expect(t).not.toContain("作用域");
  expect(t).not.toContain(".agents/skills");
  expect(within(dlg).queryByLabelText(/名称/)).toBeNull();
  expect(
    within(dlg)
      .getAllByRole("radio")
      .map((r) => r.textContent),
  ).toEqual(["仓库 / 包 / 目录", "从环境纳入"]);
  expect(pv("source")).toBe("—");
  expect(submit().disabled).toBe(true);
});

test("粘贴仓库网址、owner/repo、npm 包名、本地路径：预览识别出来源与版本；识别不了给出支持的写法", async () => {
  await mountSkills();
  openInstall();
  typeSpec("https://github.com/cloudflare/security-audit-skill");
  expect(pv("source")).toBe("git · github.com/cloudflare/security-audit-skill");
  expect(pv("version")).toBe("默认分支，装好后记提交号");
  expect(submit().disabled).toBe(false);
  typeSpec(
    "https://github.com/upstash/context7/tree/master/packages/pi/skills/context7-docs",
  );
  expect(pv("source")).toBe(
    "git · github.com/upstash/context7@master · packages/pi/skills/context7-docs",
  );
  expect(pv("version")).toBe("master");
  typeSpec("unclebob/ub-mode");
  expect(pv("source")).toBe("git · github.com/unclebob/ub-mode");
  typeSpec("unclebob/ub-mode@v1.2");
  expect(pv("source")).toBe("git · github.com/unclebob/ub-mode@v1.2");
  expect(pv("version")).toBe("v1.2");
  typeSpec("git@github.com:acme/kit.git");
  expect(pv("source")).toBe("git · github.com/acme/kit");
  typeSpec("@acme/brand-kit@2.1.0");
  expect(pv("source")).toBe("npm · @acme/brand-kit");
  expect(pv("version")).toBe("2.1.0");
  typeSpec("brand-kit");
  expect(pv("version")).toBe("最新版");
  typeSpec("./skills/My Skill");
  expect(pv("source")).toBe("本地目录 · ./skills/My Skill");
  expect(pv("version")).toBe("不跟踪版本");
  typeSpec("not a source!!");
  expect(screen.getByText(/识别不了这个来源。支持：owner\/repo/)).toBeTruthy();
  expect(submit().disabled).toBe(true);
});

test("从环境纳入：选环境 + 目录，原地登记；详情的来源写环境名，不写路径", async () => {
  const { fake } = await mountSkills();
  openInstall();
  kind("从环境纳入");
  expect(screen.getByText("原地登记，不复制；原件留在环境里")).toBeTruthy();
  const select = screen.getByRole("combobox", { name: "环境" });
  choose(select, "gpu");
  typeSpec("/opt/skills/gpu-tuner");
  expect(pv("source")).toBe("环境里的目录 · /opt/skills/gpu-tuner");
  fireEvent.click(submit());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fake.called("POST", /\/skills\/install$/)[0]?.body).toEqual({
    source: { kind: "observed", hostId: "gpu", path: "/opt/skills/gpu-tuner" },
  });
  const d = await screen.findByRole("article", { name: "gpu-tuner 详情" });
  expect(d.textContent).toContain("GPU 训练机");
  expect(d.textContent).not.toContain("/opt/skills");
});

test("装完选中新技能、排在最前，只发一次安装请求，不自动分发", async () => {
  const { fake } = await mountSkills();
  openInstall();
  typeSpec("@acme/brand-kit@2.1.0");
  fireEvent.click(submit());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(names()[0]).toBe("brand-kit");
  const d = await screen.findByRole("article", { name: "brand-kit 详情" });
  expect(within(d).getByRole("button", { name: "补齐 2 个环境" })).toBeTruthy();
  expect(fake.called("POST", /\/skills\/install$/)[0]?.body).toEqual({
    source: { kind: "auto", spec: "@acme/brand-kit@2.1.0" },
  });
  expect(fake.called("POST", /\/(distribute|sync)$/)).toHaveLength(0);
  expect(await screen.findByText("brand-kit 已装进库")).toBeTruthy();
  expect(d.textContent).not.toContain(".agents/skills");
});

test("一个仓库里有多个技能：弹出候选，选一个后带着子目录再提交，只装这一个", async () => {
  const { fake } = await mountSkills();
  openInstall();
  typeSpec("github.com/acme/multi-skills");
  fireEvent.click(submit());
  const alpha = await screen.findByText("第一个");
  expect(screen.getByText(/这个仓库里有 2 个技能，选一个装/)).toBeTruthy();
  // 没选之前不能提交
  expect(submit().disabled).toBe(true);
  expect(submit().textContent).toBe("装这一个");
  fireEvent.click(alpha);
  expect(submit().disabled).toBe(false);
  fireEvent.click(submit());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const calls = fake.called("POST", /\/skills\/install$/);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.body).toEqual({
    source: {
      kind: "auto",
      spec: "github.com/acme/multi-skills",
      subdir: "skills/alpha",
    },
  });
  expect(names()[0]).toBe("alpha");
});

test("改了来源地址，之前的候选作废", async () => {
  await mountSkills();
  openInstall();
  typeSpec("github.com/acme/multi-skills");
  fireEvent.click(submit());
  await screen.findByText("第一个");
  typeSpec("github.com/acme/other");
  expect(screen.queryByText("第一个")).toBeNull();
  expect(submit().textContent).toBe("装进库");
  expect(submit().disabled).toBe(false);
});

test("提交号版本在列表里只显示前 7 位", async () => {
  await mountSkills();
  openInstall();
  typeSpec("github.com/acme/kit");
  fireEvent.click(submit());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const d = await screen.findByRole("article", { name: "kit 详情" });
  expect(d.textContent).toContain("0123456");
  expect(d.textContent).not.toContain("0123456789abcdef");
});

test("同名技能被服务端拒绝：原因留在弹窗里，弹窗不关", async () => {
  await mountSkills();
  openInstall();
  typeSpec("@acme/code-review@2.0.0");
  fireEvent.click(submit());
  expect((await screen.findByRole("alert")).textContent).toBe(
    "库中已有同名技能：code-review",
  );
  expect(screen.getByRole("dialog", { name: "安装技能" })).toBeTruthy();
});

test("查看文件：左文件树 + 右只读预览，默认 SKILL.md，切文件不关弹窗", async () => {
  await mountSkills();
  fireEvent.click(await screen.findByRole("button", { name: "查看文件" }));
  const dlg = await screen.findByRole("dialog", { name: "code-review" });
  expect(dlg.getAttribute("data-size")).toBe("xl");
  await waitFor(() =>
    expect(screen.getByTestId("sk-file").textContent).toContain(
      "name: code-review",
    ),
  );
  expect(dlg.querySelectorAll(".st-tl-tree-f")).toHaveLength(3);
  expect(screen.getByTestId("sk-path").textContent).toBe("SKILL.md");
  expect(dlg.textContent).not.toContain("安装位置");
  fireEvent.click(
    dlg.querySelector('[data-path="references/severity.md"]') as HTMLElement,
  );
  await waitFor(() =>
    expect(screen.getByTestId("sk-file").textContent).toContain("P0 阻断"),
  );
  expect(screen.getByRole("dialog", { name: "code-review" })).toBeTruthy();
  fireEvent.click(within(dlg).getByRole("button", { name: "关闭" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("查看文件：二进制文件不预览，只提示", async () => {
  const { fake } = await mountSkills();
  fake.override((m, p) =>
    m === "GET" &&
    /\/skills\/code-review\/file\?path=scripts%2Fcheck\.py$/.test(p)
      ? new Response(JSON.stringify({ error: "binary_file" }), { status: 415 })
      : undefined,
  );
  fireEvent.click(await screen.findByRole("button", { name: "查看文件" }));
  const dlg = await screen.findByRole("dialog");
  fireEvent.click(
    await waitFor(
      () => dlg.querySelector('[data-path="scripts/check.py"]') as HTMLElement,
    ),
  );
  expect((await within(dlg).findByRole("alert")).textContent).toBe(
    "二进制文件，不提供预览",
  );
});

test("卸载二次确认并写明范围：库分发的副本会清理，确认后条目消失", async () => {
  const { fake } = await mountSkills();
  choosen("pdf-tools");
  openRemove();
  const dlg = await screen.findByRole("dialog", { name: "卸载 pdf-tools" });
  expect(dlg.textContent).toContain("会清理 2 个环境的副本");
  expect(fake.called("POST", /\/skills\/batch$/)).toHaveLength(0);
  fireEvent.click(within(dlg).getByRole("button", { name: "卸载" }));
  await waitFor(() => expect(names()).not.toContain("pdf-tools"));
  expect(fake.called("POST", /\/skills\/batch$/)[0]?.body).toEqual({
    names: ["pdf-tools"],
    action: "uninstall",
  });
  // 选中的被卸掉后详情落到第一个，不留空白
  expect(
    screen.getByRole("article", { name: "code-review 详情" }),
  ).toBeTruthy();
});

test("卸载 observed：写「原地文件保留」，不写清理副本", async () => {
  await mountSkills([
    skill("env-skill", {
      origin: { kind: "observed", hostId: "gpu", path: "/opt/s" },
      version: null,
      latestVersion: null,
      copies: { local: null, gpu: "—" },
    }),
  ]);
  openRemove();
  const dlg = await screen.findByRole("dialog", { name: "卸载 env-skill" });
  expect(dlg.textContent).toContain("原地文件保留");
  expect(dlg.textContent).not.toContain("会清理");
});

test("取消卸载不发请求", async () => {
  const { fake } = await mountSkills();
  openRemove();
  const dlg = await screen.findByRole("dialog");
  fireEvent.click(within(dlg).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fake.writes()).toHaveLength(0);
});
