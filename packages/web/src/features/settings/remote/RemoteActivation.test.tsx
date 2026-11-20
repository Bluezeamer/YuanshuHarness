// 迁移自 remote-connections.smoke.cjs：激活六步、主机密钥阻断与核对、一次只激活一个、跳板未激活、无密码连接。
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { clearToasts } from "../../../ui";
import {
  click,
  conn,
  key,
  mount,
  rail,
  reply,
  selectConn,
  tofu,
  trusted,
} from "./testkit";

afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
});

const keys = [key("k1")];
const stepStates = () =>
  within(screen.getByRole("list", { name: "激活步骤" }))
    .getAllByRole("listitem")
    .map((li) => li.getAttribute("data-state"));

test("激活六步：逐步可观察，毫秒定格，完成后保留步骤并可收起", async () => {
  const { server } = await mount(
    { conns: [tofu("a")], creds: keys },
    { auto: false },
  );
  click("激活");
  await screen.findByRole("list", { name: "激活步骤" });
  const names = within(screen.getByRole("list", { name: "激活步骤" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);
  expect(names).toHaveLength(6);
  for (const n of [
    "解析主机",
    "TCP 连接",
    "主机密钥",
    "认证",
    "远端探测",
    "控制通道",
  ])
    expect(names.some((t) => t?.startsWith(n))).toBe(true);
  expect(stepStates()).toEqual([
    "running",
    "pending",
    "pending",
    "pending",
    "pending",
    "pending",
  ]);
  expect(screen.getByText("正在建立连接…")).toBeTruthy();

  server.tick("a");
  await waitFor(() => expect(stepStates()[0]).toBe("done"));
  expect(stepStates()[1]).toBe("running");
  expect(screen.getByText("10ms")).toBeTruthy(); // 毫秒定格
  for (let i = 0; i < 5; i++) server.tick("a");
  await waitFor(() => expect(stepStates()).toEqual(Array(6).fill("done")));
  expect(screen.getByText("激活完成 · 210ms")).toBeTruthy();
  expect(screen.getAllByText("已激活").length).toBeGreaterThan(0);
  // 完成后面板保留，可收起
  click("收起");
  expect(screen.queryByRole("list", { name: "激活步骤" })).toBeNull();
});

test("激活失败：停在出错阶段，显示错误码，后面的步骤不继续，可重试", async () => {
  const { server } = await mount({ conns: [tofu("a")], creds: keys });
  server.failAt.a = { step: 1, code: "tcp_refused" };
  click("激活");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("TCP 连接失败");
  expect(alert.textContent).toContain("tcp_refused");
  expect(stepStates()).toEqual([
    "done",
    "failed",
    "pending",
    "pending",
    "pending",
    "pending",
  ]);
  expect(
    screen.getAllByRole("img", { name: "激活失败" }).length,
  ).toBeGreaterThan(0);
  // 修好之后同一个按钮重试，不需要刷新
  delete server.failAt.a;
  click("激活");
  await waitFor(() => expect(stepStates()).toEqual(Array(6).fill("done")));
});

test("同时只允许一个连接处于激活过程中（B9）", async () => {
  const { server, store } = await mount(
    { conns: [tofu("a"), tofu("b")], creds: keys },
    { auto: false },
  );
  selectConn("a");
  click("激活");
  await screen.findByRole("list", { name: "激活步骤" });

  selectConn("b");
  const btn = screen.getByRole("button", { name: "激活" }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(btn.title).toContain("正在激活「a」");
  fireEvent.click(btn);
  // 绕过按钮直接调 store 也被拒，且没有发出请求
  expect(await store.activate("b")).toMatchObject({ ok: false, code: "busy" });
  expect(server.writesTo(/b\/activate/)).toHaveLength(0);

  // a 结束后 b 解锁
  selectConn("a");
  for (let i = 0; i < 6; i++) server.tick("a");
  await waitFor(() =>
    expect(screen.getByText("激活完成 · 210ms")).toBeTruthy(),
  );
  selectConn("b");
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "激活" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});

test("另一个标签页已在激活别的连接：服务端 409 busy，提示点名，并接上那次激活", async () => {
  const { server } = await mount(
    { conns: [tofu("a"), tofu("b")], creds: keys },
    { auto: false },
  );
  // 本页不知道的激活：直接对假服务端发起
  await server.fetchMock("/api/v1/connections/a/activate", { method: "POST" });
  selectConn("b");
  const btn = screen.getByRole("button", { name: "激活" }) as HTMLButtonElement;
  expect(btn.disabled).toBe(false);
  fireEvent.click(btn);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("同一时间只能激活一个连接");
  expect(alert.textContent).toContain("「a」正在激活");
  // 重取后 a 的激活出现在列表里，b 随之锁住
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "激活" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true),
  );
  selectConn("a");
  await screen.findByRole("list", { name: "激活步骤" });
});

test("跳板未激活：拒绝激活并提示先激活跳板机，不发请求", async () => {
  const bastion = conn("bastion");
  const mac = conn("mac", {
    jump: ["bastion"],
    chain: [{ id: "bastion", label: "bastion" }],
  });
  const { server } = await mount({ conns: [bastion, mac], creds: keys });
  selectConn("mac");
  click("激活");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("先激活跳板机");
  expect(alert.textContent).toContain("bastion");
  expect(server.writesTo(/activate/)).toHaveLength(0);
  expect(screen.queryByRole("list", { name: "激活步骤" })).toBeNull();
  expect(screen.getAllByText("已断开").length).toBeGreaterThan(0);
});

test("跳板状态已过期时，服务端的 409 jump_inactive 同样给出明确提示", async () => {
  const bastion = conn("bastion", { status: "active" });
  const mac = conn("mac", {
    jump: ["bastion"],
    chain: [{ id: "bastion", label: "bastion" }],
  });
  const { server } = await mount({ conns: [bastion, mac], creds: keys });
  server.on("POST /api/v1/connections/mac/activate", () =>
    reply(409, {
      error: "jump_inactive",
      jump: { id: "bastion", label: "bastion" },
    }),
  );
  selectConn("mac");
  click("激活");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("跳板机「bastion」还没有激活");
});

test("主机密钥变更：激活被阻断，并排「记录 / 本次」，确认前不继续认证", async () => {
  const mac = conn("mac", { hostKey: trusted("SHA256:OLDfp") });
  const { server } = await mount({ conns: [mac], creds: keys });
  server.seen.mac = "SHA256:NEWfp";
  click("激活");
  const box = await screen.findByRole("region", { name: "主机密钥核对" });
  expect(box.textContent).toContain("主机密钥已变更");
  expect(box.textContent).toContain("可能是主机重装，也可能是中间人");
  expect(box.textContent).toContain("核对前不会发送任何凭据");
  const rows = within(box)
    .getAllByText(/^SHA256:/)
    .map((e) => e.textContent);
  expect(rows).toEqual(["SHA256:OLDfp", "SHA256:NEWfp"]); // 记录在前、本次在后
  expect(within(box).getByText("记录")).toBeTruthy();
  expect(within(box).getByText("本次")).toBeTruthy();
  // 停在主机密钥一步，认证及之后都没开始；这不是出错而是等待核对
  expect(stepStates()).toEqual([
    "done",
    "done",
    "failed",
    "pending",
    "pending",
    "pending",
  ]);
  expect(screen.getByText("等待你核对主机密钥")).toBeTruthy();
  // 左列表的状态点是「待核对」，没有被激活
  expect(within(rail()).getByRole("img", { name: "待核对" })).toBeTruthy();
  expect(server.writesTo(/trust/)).toHaveLength(0);
});

test("信任新密钥后自动继续被阻断的激活（B8）", async () => {
  const mac = conn("mac", { hostKey: trusted("SHA256:OLDfp") });
  const { server } = await mount({ conns: [mac], creds: keys });
  server.seen.mac = "SHA256:NEWfp";
  click("激活");
  await screen.findByRole("region", { name: "主机密钥核对" });
  click("信任新密钥并继续");
  await waitFor(() => expect(stepStates()).toEqual(Array(6).fill("done")));
  expect(screen.queryByRole("region", { name: "主机密钥核对" })).toBeNull();
  const order = server.writes().map((c) => c.path.split("/").pop());
  expect(order).toEqual(["activate", "trust", "activate"]);
  expect(server.conns[0]?.hostKey?.fingerprint).toBe("SHA256:NEWfp");
});

test("首次连接（询问）：只展示本次指纹，信任后继续；之后再变更仍会阻断", async () => {
  const { server } = await mount({ conns: [conn("gpu")], creds: keys });
  click("激活");
  const box = await screen.findByRole("region", { name: "主机密钥核对" });
  expect(box.textContent).toContain("首次连接 · 尚未记录主机密钥");
  expect(within(box).queryByText("记录")).toBeNull();
  expect(within(box).getByText("SHA256:gpu-host")).toBeTruthy();
  click("信任并继续");
  await waitFor(() => expect(stepStates()).toEqual(Array(6).fill("done")));
  expect(server.conns[0]?.hostKey?.fingerprint).toBe("SHA256:gpu-host");
});

test("首次连接（自动记录）直接通过；但变更永不自动信任", async () => {
  const tofu = {
    keepAlive: true,
    reuseSession: true,
    hostKey: "tofu",
    proxyJumpFallback: false,
  } as const;
  const { server } = await mount({
    conns: [
      conn("a", { policy: tofu }),
      conn("b", { policy: tofu, hostKey: trusted("SHA256:OLDfp") }),
    ],
    creds: keys,
  });
  selectConn("a");
  click("激活");
  await waitFor(() => expect(stepStates()).toEqual(Array(6).fill("done")));
  expect(screen.queryByRole("region", { name: "主机密钥核对" })).toBeNull();

  server.seen.b = "SHA256:NEWfp";
  selectConn("b");
  click("激活");
  await screen.findByRole("region", { name: "主机密钥核对" });
  expect(server.conns.find((c) => c.id === "b")?.hostKey?.fingerprint).toBe(
    "SHA256:OLDfp",
  );
});

test("暂不处理会收起核对框，再点激活重新展开", async () => {
  const { server } = await mount({ conns: [conn("gpu")], creds: keys });
  click("激活");
  await screen.findByRole("region", { name: "主机密钥核对" });
  click("暂不处理");
  expect(screen.queryByRole("region", { name: "主机密钥核对" })).toBeNull();
  expect(screen.getByText(/点击「激活」会重新展开核对/)).toBeTruthy();
  click("激活");
  await screen.findByRole("region", { name: "主机密钥核对" });
  // 服务端仍有待核对指纹，第二次激活被 409 verify_required 拒绝，没有重新发起
  expect(server.writesTo(/activate/).length).toBe(2);
});

test("没有凭据的连接：点激活先展开密码输入，不发激活请求；保存后继续激活", async () => {
  const bare = conn("edge", { auth: { kind: null, secretId: null } });
  const { server } = await mount({ conns: [bare], creds: [] });
  click("激活");
  const pw = await screen.findByLabelText("登录密码");
  expect(server.writes()).toHaveLength(0);
  fireEvent.change(pw, { target: { value: "s3cret" } });
  click("保存并激活");
  // 首次连接策略为询问，会停在核对；这里只关心密码被登记且之后发起了激活
  await screen.findByRole("region", { name: "主机密钥核对" });
  const writes = server.writes().map((c) => `${c.method} ${c.path}`);
  expect(writes).toEqual([
    "POST /api/v1/secrets",
    "PATCH /api/v1/connections/edge",
    "POST /api/v1/connections/edge/activate",
  ]);
  expect(server.writes()[0]?.body).toMatchObject({
    kind: "password",
    value: "s3cret",
  });
  expect(server.writes()[1]?.body).toMatchObject({
    auth: { kind: "password" },
  });
});

test("激活进行中点取消：走断开接口中止激活，步骤面板消失", async () => {
  const { server } = await mount(
    { conns: [conn("a")], creds: keys },
    { auto: false },
  );
  click("激活");
  await screen.findByRole("list", { name: "激活步骤" });
  click("取消");
  await waitFor(() =>
    expect(screen.queryByRole("list", { name: "激活步骤" })).toBeNull(),
  );
  expect(server.writesTo(/deactivate/)).toHaveLength(1);
  expect(
    (screen.getByRole("button", { name: "激活" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

const listCalls = (server: { calls: { method: string; path: string }[] }) =>
  server.calls.filter(
    (c) => c.method === "GET" && c.path === "/api/v1/connections",
  ).length;

test("已激活的连接被服务端断开：不刷新，界面切到已断开，日志里有「连接已断开」", async () => {
  const { server } = await mount(
    { conns: [tofu("a", { status: "active" })], creds: keys },
    { watchMs: 10 },
  );
  expect(screen.getByRole("button", { name: "断开" })).toBeTruthy();
  server.drop("a");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "激活" })).toBeTruthy(),
  );
  expect(screen.queryByRole("button", { name: "断开" })).toBeNull();
  expect(screen.getAllByText("已断开").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("tab", { name: /^连接日志/ }));
  expect(await screen.findByText("连接已断开")).toBeTruthy();
});

test("停在日志页时掉线：日志随连接状态变化重取，新事件自己出现", async () => {
  const { server } = await mount(
    { conns: [tofu("a", { status: "active" })], creds: keys },
    { watchMs: 10 },
  );
  fireEvent.click(screen.getByRole("tab", { name: /^连接日志/ }));
  await screen.findByText("这个筛选下还没有事件");
  server.drop("a");
  expect(await screen.findByText("连接已断开")).toBeTruthy();
});

test("巡检很轻：没有已激活连接时不发请求；页面不可见时暂停", async () => {
  const idle = await mount({ conns: [tofu("a")], creds: keys }, { watchMs: 5 });
  await new Promise((ok) => setTimeout(ok, 80));
  expect(listCalls(idle.server)).toBe(1); // 只有首屏那次
  cleanup();

  const hidden = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  try {
    const { server } = await mount(
      { conns: [tofu("a", { status: "active" })], creds: keys },
      { watchMs: 5 },
    );
    await new Promise((ok) => setTimeout(ok, 80));
    expect(listCalls(server)).toBe(1);
    hidden.mockReturnValue("visible");
    await waitFor(() => expect(listCalls(server)).toBeGreaterThan(1));
  } finally {
    hidden.mockRestore();
  }
});

test("巡检的响应迟到：期间状态被别的操作改过就丢弃，不把界面刷回旧状态", async () => {
  const { server, store } = await mount(
    { conns: [tofu("a", { status: "active" })], creds: keys },
    { watchMs: 5 },
  );
  // 服务端在发出请求时就定了答案（a 仍是已激活），响应却晚到
  let hold = false;
  let held = 0;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const res = server.fetchMock(input, init);
    if (
      hold &&
      (init?.method ?? "GET") === "GET" &&
      input === "/api/v1/connections"
    ) {
      hold = false;
      held++;
      await new Promise((ok) => setTimeout(ok, 60));
    }
    return res;
  });
  const seen: string[] = [];
  store.subscribe(() => {
    const st = store.getSnapshot();
    if (st.phase === "ready") seen.push(st.conns[0]?.status ?? "");
  });
  hold = true;
  await waitFor(() => expect(held).toBe(1));
  expect((await store.deactivate("a")).ok).toBe(true);
  await new Promise((ok) => setTimeout(ok, 150));
  expect(seen).toContain("inactive");
  expect(seen.slice(seen.indexOf("inactive"))).not.toContain("active");
});
