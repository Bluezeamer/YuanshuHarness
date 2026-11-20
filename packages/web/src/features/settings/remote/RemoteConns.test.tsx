// 连接页：左列表与详情、断开确认与连带、地址 / 认证 / 策略的草稿与保存、新建校验、删除守卫。
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { choose } from "../../../test/select";
import { clearToasts } from "../../../ui";
import {
  activeCount,
  click,
  conn,
  detailName,
  isDisabled,
  key,
  menuItem,
  mount,
  rail,
  railOrder,
  reply,
  saveBar,
  saveClick,
  selectConn,
  tofu,
  trusted,
} from "./testkit";

afterEach(() => {
  cleanup();
  clearToasts();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const keys = [key("k1"), key("k2", { name: "ci-key" })];
const article = () => within(screen.getByRole("article"));
const field = (name: string) =>
  screen.getByRole("textbox", { name }) as HTMLInputElement;
const edit = (name: string, value: string) =>
  fireEvent.change(field(name), { target: { value } });
const aj = (id: string) => [{ id, label: id }];
const closeMenu = () => fireEvent.keyDown(document.body, { key: "Escape" });

// 三条已激活：bastion 是 mac 的跳板；gpu 独立且挂了目录与两个会话
const fleet = () => ({
  conns: [
    conn("bastion", { status: "active", dependants: aj("mac") }),
    conn("mac", { status: "active", jump: ["bastion"], chain: aj("bastion") }),
    conn("gpu", {
      status: "active",
      label: "gpu",
      hostKey: trusted("SHA256:g"),
    }),
  ],
  creds: keys,
  directories: [
    { id: "w1", name: "train", path: "/data/train", environmentId: "gpu" },
  ],
  sessions: [
    { id: "s1", directoryId: "w1" },
    { id: "s2", directoryId: "w1" },
  ],
});

test("左列表不分组：已激活在前，行右侧是状态点；默认选中第一项；主按钮只有「激活」", async () => {
  await mount({
    conns: [conn("b"), conn("a", { status: "active" })],
    creds: keys,
  });
  expect(railOrder()).toEqual(["a", "b"]);
  expect(screen.queryByRole("region", { name: "已激活" })).toBeNull();
  expect(within(rail()).getByRole("img", { name: "已激活" })).toBeTruthy();
  expect(within(rail()).getByRole("img", { name: "已断开" })).toBeTruthy();
  expect(detailName()).toBe("a");
  // 已激活：只有断开；没有「编辑」解锁钮，也没有蓝色主按钮
  expect(screen.getByRole("button", { name: "断开" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
  expect(document.querySelectorAll('[data-variant="primary"]')).toHaveLength(0);
  selectConn("b");
  expect(document.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
  expect(screen.getByRole("button", { name: "激活" })).toBeTruthy();
  // 冗余的汇总都不再出现
  expect(screen.queryByText(/服务端 · \d+ 已激活/)).toBeNull();
  expect(screen.queryByLabelText("连接概况")).toBeNull();
  expect(screen.queryByText("危险区")).toBeNull();
});

test("悬停详情卡片：行里没有的信息（跳板、认证、目录挂载与会话、上次激活）", async () => {
  await mount(fleet());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const row = (label: string) =>
    within(rail())
      .getByText(label, { selector: ".u-lrow-label" })
      .closest(".u-hc") as HTMLElement;
  fireEvent.pointerEnter(row("mac"));
  act(() => {
    vi.advanceTimersByTime(500);
  });
  let card = screen.getByRole("tooltip");
  expect(card.textContent).toContain("bastion");
  expect(card.textContent).toContain("私钥");
  expect(card.textContent).toContain("没有");
  fireEvent.pointerLeave(row("mac"));
  fireEvent.pointerEnter(row("gpu"));
  act(() => {
    vi.advanceTimersByTime(500);
  });
  card = screen.getByRole("tooltip");
  expect(card.textContent).toContain("直连");
  expect(card.textContent).toContain("1 个目录 · 2 个会话");
});

test("目录挂载只读引用；没有挂载时点明怎么挂", async () => {
  await mount({
    conns: [conn("gpu", { status: "active" }), conn("empty")],
    creds: keys,
    directories: [
      { id: "w1", name: "train", path: "/data/train", environmentId: "gpu" },
    ],
  });
  const list = screen.getByRole("list", { name: "挂载的目录" });
  expect(list.textContent).toContain("train");
  expect(list.textContent).toContain("/data/train");
  expect(within(list).queryByRole("button")).toBeNull(); // 不能在这里增删
  selectConn("empty");
  expect(screen.getByText(/还没有目录挂在这条连接上/)).toBeTruthy();
});

test("「⋯」菜单：复制 ssh 命令带跳板链", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  await mount(fleet());
  selectConn("mac");
  fireEvent.click(await menuItem("复制 ssh 命令"));
  expect(writeText).toHaveBeenCalledWith(
    "ssh -J ops@bastion.example -p 22 ops@mac.example",
  );
});

test("左列表每行也有同一份菜单", async () => {
  await mount(fleet());
  fireEvent.click(within(rail()).getByRole("button", { name: "gpu 的操作" }));
  const del = await screen.findByRole("menuitem", { name: /^删除连接/ });
  expect(isDisabled(del)).toBe(true);
  expect(del.textContent).toContain("先断开");
});

test("断开有会话的连接要先确认，点出会暂停的会话数；确认后才发请求", async () => {
  const { server } = await mount(fleet());
  selectConn("gpu");
  click("断开");
  const dlg = screen.getByRole("dialog", { name: "断开「gpu」" });
  expect(dlg.textContent).toContain("2 个会话会暂停");
  expect(server.writesTo(/deactivate/)).toHaveLength(0);
  fireEvent.click(within(dlg).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(server.writesTo(/deactivate/)).toHaveLength(0);
  click("断开");
  click("断开并暂停");
  await waitFor(() => expect(activeCount()).toBe(2));
  expect(server.writesTo(/gpu\/deactivate/)).toHaveLength(1);
  expect(screen.getAllByText("已断开").length).toBeGreaterThan(0);
  expect(await screen.findByText(/^已断开「gpu」/)).toBeTruthy();
});

test("没有会话也没有下游的连接，断开不用确认", async () => {
  const { server } = await mount({
    conns: [conn("solo", { status: "active" })],
    creds: keys,
  });
  click("断开");
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(server.writesTo(/deactivate/)).toHaveLength(1));
  await waitFor(() => expect(activeCount()).toBe(0));
});

test("跳板断开会点名经它跳转的连接并连带暂停，完成后用提示告知被暂停的清单", async () => {
  const { server } = await mount(fleet());
  selectConn("bastion");
  click("断开");
  const dlg = screen.getByRole("dialog", { name: "断开「bastion」" });
  expect(dlg.textContent).toContain("经它跳转的连接");
  expect(dlg.textContent).toContain("「mac」");
  expect(dlg.textContent).toContain("也会一起暂停");
  click("断开并暂停");
  const done = await screen.findByText(/连带暂停 1 条下游连接/);
  expect(done.textContent).toContain("已断开「bastion」");
  expect(done.textContent).toContain("「mac」");
  await waitFor(() => expect(activeCount()).toBe(1)); // 只剩 gpu
  expect(server.conns.find((c) => c.id === "mac")?.status).toBe("inactive");
});

test("断开再重新激活：左列表的状态点跟着变，激活步骤保留在详情里", async () => {
  await mount({
    conns: [
      tofu("gpu", { status: "active", hostKey: trusted("SHA256:gpu-host") }),
    ],
    creds: keys,
    directories: [
      { id: "w1", name: "train", path: "/data/train", environmentId: "gpu" },
    ],
    sessions: [
      { id: "s1", directoryId: "w1" },
      { id: "s2", directoryId: "w1" },
    ],
  });
  expect(activeCount()).toBe(1);
  click("断开");
  click("断开并暂停");
  await waitFor(() => expect(activeCount()).toBe(0));
  click("激活");
  await waitFor(() => expect(activeCount()).toBe(1));
  expect(screen.getByText(/^激活完成/)).toBeTruthy();
});

test("默认选中是固定的：被选中的连接状态变了（断开后排到后面），详情不会跳到另一条", async () => {
  await mount({
    conns: [conn("a", { status: "active" }), conn("b", { status: "active" })],
    creds: keys,
  });
  expect(detailName()).toBe("a");
  click("断开");
  await waitFor(() => expect(activeCount()).toBe(1));
  expect(railOrder()).toEqual(["b", "a"]);
  expect(detailName()).toBe("a");
});

// ---- 地址 / 认证 / 策略：进草稿，点保存才落 ----

test("已激活的连接也直接可改；改动先在草稿里，保存才发请求，保存后标待激活并作废主机密钥记录", async () => {
  const { server } = await mount({
    conns: [conn("a", { status: "active", hostKey: trusted("SHA256:a") })],
    creds: keys,
  });
  expect(saveBar()).toBeNull();
  edit("主机名或 IP", "10.20.4.19");
  expect(saveBar()).not.toBeNull();
  expect(server.writes()).toHaveLength(0);
  saveClick();
  await waitFor(() =>
    expect(server.writesTo(/connections\/a$/)).toHaveLength(1),
  );
  expect(server.writesTo(/connections\/a$/)[0]?.body).toEqual({
    host: "10.20.4.19",
  });
  expect(
    await screen.findByText(/改动在下一次激活时生效，当前会话仍使用旧配置/),
  ).toBeTruthy();
  expect(screen.getAllByText("未记录").length).toBeGreaterThan(0); // 旧记录作废
  await waitFor(() => expect(saveBar()).toBeNull());
  expect(await screen.findByText("已保存")).toBeTruthy();
});

test("放弃：草稿回到已保存的值，不发请求", async () => {
  const { server } = await mount({ conns: [conn("a")], creds: keys });
  edit("端口", "2222");
  saveClick("放弃");
  expect(field("端口").value).toBe("22");
  expect(saveBar()).toBeNull();
  expect(server.writes()).toHaveLength(0);
});

test("有未保存的修改时「激活」置灰并说明；放弃后恢复", async () => {
  await mount({ conns: [conn("a")], creds: keys });
  edit("端口", "2222");
  const btn = screen.getByRole("button", { name: "激活" }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(btn.title).toBe("先保存修改再激活");
  saveClick("放弃");
  expect(
    (screen.getByRole("button", { name: "激活" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("切换连接前先问：放弃修改直接切过去，保存则先发请求再切", async () => {
  const { server } = await mount({
    conns: [conn("a"), conn("b")],
    creds: keys,
  });
  edit("端口", "2222");
  selectConn("b");
  const dlg = await screen.findByRole("dialog", { name: "有未保存的修改" });
  expect(detailName()).toBe("a");
  fireEvent.click(within(dlg).getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(detailName()).toBe("b"));
  expect(server.writes()).toHaveLength(0);

  selectConn("a");
  edit("端口", "2200");
  selectConn("b");
  const dlg2 = await screen.findByRole("dialog", { name: "有未保存的修改" });
  fireEvent.click(within(dlg2).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(detailName()).toBe("b"));
  expect(server.writesTo(/connections\/a$/)[0]?.body).toEqual({ port: 2200 });
});

test("地址字段边改边校验：主机不含空格、端口 1–65535、用户必填；保存被拦下且不发请求，修正后只发改动的字段", async () => {
  const { server } = await mount({ conns: [conn("a")], creds: keys });
  edit("主机名或 IP", "a b");
  expect(article().getByRole("alert").textContent).toContain("空格");
  edit("端口", "70000");
  edit("登录用户", " ");
  expect(
    article()
      .getAllByRole("alert")
      .map((e) => e.textContent),
  ).toEqual(["主机不能包含空格", "端口必须是 1–65535 的整数；填写登录用户"]);
  saveClick();
  expect(await screen.findByText(/^保存失败：/)).toBeTruthy();
  expect(server.writes()).toHaveLength(0);
  edit("主机名或 IP", "a.example");
  edit("登录用户", "ops");
  edit("端口", "2222");
  expect(article().queryByRole("alert")).toBeNull();
  saveClick();
  await waitFor(() =>
    expect(server.writesTo(/connections\/a$/)).toHaveLength(1),
  );
  expect(server.writesTo(/connections\/a$/)[0]?.body).toEqual({ port: 2222 });
});

test("输入框失焦时收拾首尾空白：不会因为一个空格让保存条一直挂着", async () => {
  await mount({ conns: [conn("a")], creds: keys });
  edit("登录用户", "ops ");
  expect(saveBar()).not.toBeNull();
  fireEvent.blur(field("登录用户"));
  expect(field("登录用户").value).toBe("ops");
  expect(saveBar()).toBeNull();
});

test("激活期间地址类字段锁定", async () => {
  await mount({ conns: [tofu("a")], creds: keys }, { auto: false });
  click("激活");
  await screen.findByRole("list", { name: "激活步骤" });
  expect(field("主机名或 IP").disabled).toBe(true);
  expect(field("端口").disabled).toBe(true);
  expect(screen.getByText(/激活过程中地址锁定/)).toBeTruthy();
});

test("跳板选择：环路候选被禁用并说明原因，选定后保存才写入", async () => {
  const a = conn("a", { dependants: aj("b") });
  const b = conn("b", { jump: ["a"], chain: aj("a") });
  const c = conn("c");
  const { server } = await mount({ conns: [a, b, c], creds: keys });
  const sel = screen.getByRole("combobox", { name: "跳板机" });
  fireEvent.click(sel);
  const opt = (label: RegExp) =>
    screen
      .getAllByRole("option")
      .find((o) => label.test(o.textContent ?? "")) as HTMLButtonElement;
  expect(opt(/^b/).disabled).toBe(true);
  expect(opt(/^b/).textContent).toContain("环路");
  expect(opt(/^c/).disabled).toBe(false);
  fireEvent.click(sel);
  choose(sel, "c");
  expect(server.writes()).toHaveLength(0);
  saveClick();
  await waitFor(() =>
    expect(server.writesTo(/connections\/a$/)).toHaveLength(1),
  );
  expect(server.writesTo(/connections\/a$/)[0]?.body).toEqual({ jump: ["c"] });
  await waitFor(() =>
    expect(screen.getByRole("list", { name: "跳板链" }).textContent).toContain(
      "c",
    ),
  );
});

test("连接策略：只有真生效的两项；首次连接与保持连接的改动一次保存、一次 PATCH", async () => {
  const { server } = await mount({ conns: [conn("a")], creds: keys });
  fireEvent.click(screen.getByRole("radio", { name: "自动记录" }));
  fireEvent.click(screen.getByRole("switch", { name: "保持连接" }));
  expect(server.writes()).toHaveLength(0);
  saveClick();
  await waitFor(() =>
    expect(server.writesTo(/connections\/a$/)).toHaveLength(1),
  );
  expect(server.writesTo(/connections\/a$/)[0]?.body).toEqual({
    policy: { hostKey: "tofu", keepAlive: false },
  });
  expect(screen.queryByText("未生效")).toBeNull();
  expect(screen.queryByRole("switch", { name: "复用会话" })).toBeNull();
  expect(screen.queryByRole("switch", { name: "跳板失败时直连" })).toBeNull();
  expect(screen.getByText(/变更永不自动信任/)).toBeTruthy();
});

test("认证：换一把私钥写入 PATCH；换成密码会登记新密码并改指向，和别的改动一并一次提交", async () => {
  const { server } = await mount({ conns: [conn("a")], creds: keys });
  choose(screen.getByRole("combobox", { name: "私钥" }), "k2");
  saveClick();
  await waitFor(() =>
    expect(server.writesTo(/connections\/a$/)).toHaveLength(1),
  );
  expect(server.writesTo(/connections\/a$/)[0]?.body).toEqual({
    auth: { secretId: "k2", kind: "key" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "密码" }));
  fireEvent.change(screen.getByLabelText("登录密码"), {
    target: { value: "pw" },
  });
  edit("端口", "2222");
  saveClick();
  await waitFor(() =>
    expect(server.writesTo(/connections\/a$/)).toHaveLength(2),
  );
  expect(server.writes().some((c) => c.path === "/api/v1/secrets")).toBe(true);
  expect(server.writesTo(/connections\/a$/)[1]?.body).toMatchObject({
    port: 2222,
    auth: { kind: "password" },
  });
});

test("认证：换成密码但没填密码，保存被拦下", async () => {
  const { server } = await mount({ conns: [conn("a")], creds: keys });
  fireEvent.click(screen.getByRole("radio", { name: "密码" }));
  expect(article().getByRole("alert").textContent).toContain("填写密码");
  saveClick("放弃");
  expect(saveBar()).toBeNull();
  expect(server.writes()).toHaveLength(0);
});

test("没有凭据的连接不会一直标红：动了认证才校验", async () => {
  await mount({
    conns: [conn("edge", { auth: { kind: null, secretId: null } })],
    creds: [],
  });
  expect(article().queryByRole("alert")).toBeNull();
  expect(saveBar()).toBeNull();
});

// 密码凭据是为某条连接建的；换了认证方式后留着就是看不见也删不掉的孤儿
const secretIds = (server: { creds: { id: string }[] }) =>
  server.creds.map((k) => k.id);
const pwConn = () =>
  mount({
    conns: [conn("a", { auth: { kind: "password", secretId: "pw-a" } })],
    creds: [...keys, key("pw-a", { kind: "password" })],
  });
const typePassword = (value: string) =>
  fireEvent.change(screen.getByLabelText("登录密码"), { target: { value } });

test("认证：更换密码后旧密码凭据被清掉，新的留下", async () => {
  const { server } = await pwConn();
  typePassword("new-pw");
  saveClick();
  await waitFor(() => expect(secretIds(server)).not.toContain("pw-a"));
  const now = server.conns[0]?.auth.secretId;
  expect(now).not.toBe("pw-a");
  expect(secretIds(server)).toContain(now);
  expect(server.writesTo(/secrets\/pw-a$/).map((c) => c.method)).toEqual([
    "DELETE",
  ]);
  // 保存后密码框清空、保存条收起
  await waitFor(() => expect(saveBar()).toBeNull());
  expect((screen.getByLabelText("登录密码") as HTMLInputElement).value).toBe(
    "",
  );
});

test("认证：从密码切回私钥后旧密码凭据被清掉", async () => {
  const { server } = await pwConn();
  fireEvent.click(screen.getByRole("radio", { name: "私钥" }));
  choose(screen.getByRole("combobox", { name: "私钥" }), "k2");
  saveClick();
  await waitFor(() => expect(secretIds(server)).not.toContain("pw-a"));
  expect(server.conns[0]?.auth).toEqual({ kind: "key", secretId: "k2" });
  expect(secretIds(server)).toEqual(expect.arrayContaining(["k1", "k2"]));
});

test("认证：私钥换私钥不碰任何凭据", async () => {
  const { server } = await mount({ conns: [conn("a")], creds: keys });
  choose(screen.getByRole("combobox", { name: "私钥" }), "k2");
  saveClick();
  await waitFor(() =>
    expect(server.writesTo(/connections\/a$/)).toHaveLength(1),
  );
  expect(server.writesTo(/secrets\//)).toHaveLength(0);
  expect(secretIds(server)).toEqual(["k1", "k2"]);
});

test("认证：旧密码仍被别处引用（服务端 409）时留着，换密码照样成功", async () => {
  const { server } = await pwConn();
  server.on("DELETE /api/v1/secrets/pw-a", () =>
    reply(409, { error: "in_use" }),
  );
  typePassword("new-pw");
  saveClick();
  await waitFor(() =>
    expect(server.writesTo(/secrets\/pw-a$/)).toHaveLength(1),
  );
  expect(secretIds(server)).toContain("pw-a");
  expect(await screen.findByText("已保存")).toBeTruthy();
});

test("保存失败：刚建的密码被回收、旧的不动，草稿与保存条还在", async () => {
  const { server } = await pwConn();
  server.on("PATCH /api/v1/connections/a", () =>
    reply(409, { error: "activating" }),
  );
  typePassword("new-pw");
  saveClick();
  expect(await screen.findByText(/^保存失败：/)).toBeTruthy();
  await waitFor(() => expect(secretIds(server)).toEqual(["k1", "k2", "pw-a"]));
  expect(saveBar()).not.toBeNull();
  expect((screen.getByLabelText("登录密码") as HTMLInputElement).value).toBe(
    "new-pw",
  );
});

// ---- 新建 ----

const openNew = async () => {
  click("新建连接");
  return screen.findByRole("dialog", { name: "新建连接" });
};
const fill = (dlg: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(dlg).getByLabelText(label), { target: { value } });

test("新建：必填没填完，两个按钮都置灰", async () => {
  await mount({ conns: [conn("a")], creds: keys });
  const dlg = await openNew();
  expect(dlg.textContent).toContain("不是目录");
  const go = () =>
    within(dlg).getByRole("button", { name: "创建并激活" }) as HTMLElement;
  const only = () =>
    within(dlg).getByRole("button", { name: "仅创建" }) as HTMLElement;
  expect(isDisabled(go())).toBe(true);
  expect(isDisabled(only())).toBe(true);
  fill(dlg, "名称", "N");
  fill(dlg, "主机", "n.example");
  fill(dlg, "登录用户", "ops");
  expect(isDisabled(go())).toBe(true); // 还没选私钥
  choose(within(dlg).getByRole("combobox", { name: "私钥" }), "k1");
  expect(isDisabled(go())).toBe(false);
  expect(isDisabled(only())).toBe(false);
  fireEvent.click(within(dlg).getByRole("radio", { name: "密码" }));
  expect(isDisabled(go())).toBe(true); // 密码还空着
});

test("新建：主机含空格、端口越界、主机+端口+用户重复都会被拦，且不发请求", async () => {
  const { server } = await mount({
    conns: [conn("a", { host: "dup.example", user: "ops" })],
    creds: keys,
  });
  const dlg = await openNew();
  fill(dlg, "名称", "N");
  fill(dlg, "登录用户", "ops");
  choose(within(dlg).getByRole("combobox", { name: "私钥" }), "k1");
  const submit = () =>
    fireEvent.click(within(dlg).getByRole("button", { name: "创建并激活" }));
  const alerts = () =>
    within(dlg)
      .getAllByRole("alert")
      .map((e) => e.textContent ?? "");

  fill(dlg, "主机", "a b");
  submit();
  expect(alerts().join()).toContain("主机不能包含空格");
  fill(dlg, "主机", "dup.example");
  fill(dlg, "端口", "0");
  submit();
  expect(alerts().join()).toContain("端口必须是 1–65535");
  fill(dlg, "端口", "65536");
  submit();
  expect(alerts().join()).toContain("端口必须是 1–65535");
  fill(dlg, "端口", "22");
  submit();
  expect(alerts().join()).toContain("已有相同主机、端口和用户的连接「a」");
  expect(server.writes()).toHaveLength(0);
});

test("新建：「创建并激活」创建后选中新连接并接着激活；「仅创建」不激活", async () => {
  const { server } = await mount({ conns: [conn("a")], creds: keys });
  const dlg = await openNew();
  fill(dlg, "名称", "数据校验机");
  fill(dlg, "主机", "10.20.9.99");
  fill(dlg, "登录用户", "analyst");
  choose(within(dlg).getByRole("combobox", { name: "私钥" }), "k2");
  fireEvent.click(within(dlg).getByRole("button", { name: "创建并激活" }));
  await waitFor(() => expect(detailName()).toBe("数据校验机"));
  expect(server.writes()[0]).toMatchObject({
    method: "POST",
    path: "/api/v1/connections",
    body: {
      label: "数据校验机",
      host: "10.20.9.99",
      port: 22,
      user: "analyst",
      auth: { secretId: "k2", kind: "key" },
      jump: [],
    },
  });
  // 首次连接（询问）：创建后立即激活，停在核对
  await screen.findByRole("region", { name: "主机密钥核对" });
  expect(server.writes()[1]?.path).toMatch(/\/activate$/);
  expect(railOrder()).toHaveLength(2);

  const dlg2 = await openNew();
  fill(dlg2, "名称", "只建不激活");
  fill(dlg2, "主机", "10.20.9.100");
  fill(dlg2, "登录用户", "analyst");
  choose(within(dlg2).getByRole("combobox", { name: "私钥" }), "k1");
  fireEvent.click(within(dlg2).getByRole("button", { name: "仅创建" }));
  await waitFor(() => expect(detailName()).toBe("只建不激活"));
  expect(server.writesTo(/\/activate$/)).toHaveLength(1); // 仍只有上一条
});

test("新建：密码认证先登记密码凭据再创建连接；创建失败会回收刚建的密码，错误留在弹窗里", async () => {
  const { server } = await mount({ conns: [conn("a")], creds: keys });
  server.on("POST /api/v1/connections", () =>
    reply(409, { error: "jump_too_deep" }),
  );
  const dlg = await openNew();
  fill(dlg, "名称", "P");
  fill(dlg, "主机", "p.example");
  fill(dlg, "登录用户", "root");
  fireEvent.click(within(dlg).getByRole("radio", { name: "密码" }));
  fill(dlg, "密码", "pw1");
  fireEvent.click(within(dlg).getByRole("button", { name: "创建并激活" }));
  await waitFor(() =>
    expect(
      within(dlg)
        .getAllByRole("alert")
        .map((e) => e.textContent)
        .join(),
    ).toContain("最多 4 跳"),
  );
  const w = server
    .writes()
    .map((c) => `${c.method} ${c.path.replace(/s\d+$/, "s*")}`);
  expect(w).toEqual([
    "POST /api/v1/secrets",
    "POST /api/v1/connections",
    "DELETE /api/v1/secrets/s*",
  ]);
  expect(server.writes()[0]?.body).toMatchObject({
    kind: "password",
    value: "pw1",
  });
});

// ---- 删除 ----

test("删除守卫：被当作跳板（点名）、激活中、有目录挂载时，菜单项置灰并写明原因", async () => {
  await mount({
    conns: [
      conn("bastion"),
      conn("m", {
        label: "Mac 构建机",
        jump: ["bastion"],
        chain: aj("bastion"),
      }),
      conn("on", { status: "active" }),
      conn("mounted"),
    ],
    creds: keys,
    directories: [{ id: "w", name: "w", path: "/x", environmentId: "mounted" }],
  });
  const reason = async (name: string) => {
    selectConn(name);
    const item = await menuItem("删除连接");
    expect(isDisabled(item)).toBe(true);
    const text = item.textContent ?? "";
    closeMenu();
    return text;
  };
  expect(await reason("bastion")).toContain("被「Mac 构建机」当跳板");
  expect(await reason("on")).toContain("先断开");
  expect(await reason("mounted")).toContain("有 1 个目录挂载");
});

test("删除：弹窗说明只移除登记不删远端文件；确认后连接与它的密码凭据一起清理", async () => {
  const { server } = await mount({
    conns: [
      conn("a"),
      conn("b", { auth: { kind: "password", secretId: "pw-b" } }),
    ],
    creds: [...keys, key("pw-b", { kind: "password" })],
  });
  selectConn("b");
  fireEvent.click(await menuItem("删除连接"));
  const dlg = await screen.findByRole("dialog", { name: "删除「b」" });
  expect(dlg.textContent).toContain("不会删除远端任何文件");
  expect(server.writes()).toHaveLength(0);
  fireEvent.click(within(dlg).getByRole("button", { name: "删除" }));
  await waitFor(() => expect(railOrder()).toEqual(["a"]));
  const w = server.writes().map((c) => `${c.method} ${c.path}`);
  expect(w[0]).toBe("DELETE /api/v1/connections/b");
  expect(w).toContain("DELETE /api/v1/secrets/pw-b");
  expect(detailName()).toBe("a");
  expect(await screen.findByText("已删除「b」")).toBeTruthy();
});

test("删除被服务端拒绝（本地状态已过期）：弹窗里点名引用者，连接还在", async () => {
  const { server } = await mount({ conns: [conn("a")], creds: keys });
  server.on("DELETE /api/v1/connections/a", () =>
    reply(409, {
      error: "referenced",
      referencedBy: [{ id: "m", label: "Mac 构建机" }],
    }),
  );
  fireEvent.click(await menuItem("删除连接"));
  const dlg = await screen.findByRole("dialog", { name: "删除「a」" });
  fireEvent.click(within(dlg).getByRole("button", { name: "删除" }));
  const alert = await within(dlg).findByRole("alert");
  expect(alert.textContent).toContain("「Mac 构建机」");
  expect(alert.textContent).toContain("当作跳板机");
  expect(railOrder()).toEqual(["a"]);
});

test("没有任何连接：左列表与详情区都有空态，新建入口可用", async () => {
  await mount({ conns: [], creds: keys });
  expect(screen.getAllByText("还没有连接")).toHaveLength(2);
  expect(screen.getByText(/连接由服务端持有/)).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: "新建连接" }).length,
  ).toBeGreaterThan(0);
});

test("地址里的主机密钥一行：已信任（记录时间、复制指纹）/ 待核对 / 未记录", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  await mount({
    conns: [
      conn("trusted", { hostKey: trusted("SHA256:plainfp") }),
      conn("fresh"),
      conn("changed", { hostKey: trusted("SHA256:OLDfp") }),
    ],
    creds: keys,
    pending: { changed: "SHA256:NEWfp" },
  });
  const row = () =>
    screen.getByText("主机密钥", { selector: ".u-row-label" }).closest(".u-row")
      ?.textContent ?? "";
  selectConn("trusted");
  expect(row()).toContain("已信任");
  expect(row()).toContain("ssh-ed25519 · SHA256:plainfp");
  expect(row()).toContain("记录于 2026-10-21");
  click("复制指纹");
  expect(writeText).toHaveBeenCalledWith("SHA256:plainfp");
  selectConn("fresh");
  expect(row()).toContain("未记录");
  expect(screen.queryByRole("button", { name: "复制指纹" })).toBeNull();
  selectConn("changed");
  expect(row()).toContain("待核对");
  expect(row()).toContain("SHA256:NEWfp");
});
