import { expect, test } from "vitest";
import {
  deleteGuard,
  disconnectImpact,
  EMPTY_FORM,
  editableOf,
  jumpChoices,
  logCounts,
  patchOf,
  relTime,
  sshCommand,
  stateOf,
  tidy,
  validateEdit,
  validateForm,
  visibleConnections,
} from "./model";
import { conn } from "./testkit";

// a ← b ← c ← d：a 是最外层跳板，d 经 c、b、a 到达
const chain = () => {
  const a = conn("a", { status: "active" });
  const b = conn("b", {
    jump: ["a"],
    chain: [{ id: "a", label: "a" }],
    status: "active",
  });
  const c = conn("c", {
    jump: ["b"],
    chain: [
      { id: "a", label: "a" },
      { id: "b", label: "b" },
    ],
  });
  const d = conn("d", {
    jump: ["c"],
    chain: [
      { id: "a", label: "a" },
      { id: "b", label: "b" },
      { id: "c", label: "c" },
    ],
  });
  // e 的链有 4 级：再把谁挂在它下面就是第 6 层
  const e = conn("e", {
    jump: ["d"],
    chain: ["a", "b", "c", "d"].map((id) => ({ id, label: id })),
  });
  return [a, b, c, d, e];
};

test("左列表排序：已激活在前、待处理（待核对指纹）次之、其余在后，同级保持原序；可按主机筛选", () => {
  const list = [
    conn("off1"),
    conn("pend", {
      status: "verify-required",
      hostKeyChange: {
        old: "A",
        new: "B",
        oldType: "t",
        newType: "t",
        changedFrom: "A",
      },
    }),
    conn("off2"),
    conn("on", { status: "active" }),
  ];
  expect(visibleConnections(list, "").map((c) => c.id)).toEqual([
    "on",
    "pend",
    "off1",
    "off2",
  ]);
  expect(visibleConnections(list, "off2.example").map((c) => c.id)).toEqual([
    "off2",
  ]);
  expect(visibleConnections(list, "OPS").length).toBe(4); // 用户名也能筛，不分大小写
  expect(stateOf(list[1] as never).label).toBe("待核对");
});

test("状态：激活中点呼吸态，失败的激活标红，已激活绿点", () => {
  expect(stateOf(conn("x", { status: "activating" }))).toMatchObject({
    tone: "accent",
    motion: "pulse",
  });
  expect(stateOf(conn("x", { status: "active" })).tone).toBe("live");
  expect(
    stateOf(conn("x", { activation: { state: "failed", steps: [] } })).tone,
  ).toBe("danger");
});

test("跳板候选：自己不可选；下游会形成环路；链深超过 4 跳被拦", () => {
  const all = chain() as never[];
  // 编辑 a：b、c、d、e 都是它的下游
  const forA = jumpChoices("a", all);
  expect(forA.map((j) => j.conn.id)).toEqual(["b", "c", "d", "e"]);
  expect(forA.every((j) => j.reason?.includes("环路"))).toBe(true);
  // 编辑一个独立的连接 x：d 的链 3 级（+1 = 4 跳，刚好）；e 的链 4 级，选它会超
  const forX = jumpChoices("x", [...all, conn("x")]);
  expect(forX.find((j) => j.conn.id === "d")?.reason).toBeNull();
  expect(forX.find((j) => j.conn.id === "e")?.reason).toContain("4 跳");
  // 新建（无自身）同理
  expect(
    jumpChoices(null, all).find((j) => j.conn.id === "e")?.reason,
  ).toContain("4 跳");
});

test("跳板候选：自身有下游时，下游深度也计入链深", () => {
  const [a, b, c, d] = chain() as [never, never, never, never];
  // 编辑 c（下游 d、e，深度 2）：选 b 链 1，+1+2 = 4 刚好：选 b（链 1，+1+1=3）可以；选一条自己无关的链深 3 的连接则超
  const x = conn("x", {
    chain: [
      { id: "p", label: "p" },
      { id: "q", label: "q" },
      { id: "r", label: "r" },
    ],
    jump: ["r"],
  });
  const e = chain()[4] as never;
  const choices = jumpChoices("c", [a, b, c, d, e, x]);
  expect(choices.find((j) => j.conn.id === "b")?.reason).toBeNull();
  expect(choices.find((j) => j.conn.id === "x")?.reason).toContain("4 跳");
});

test("ssh 命令：直连 / 单跳 / 多跳（-J 逗号串联，非 22 端口带端口）", () => {
  const [a, b, c] = chain() as [never, never, never];
  const odd = conn("o", { port: 2222, user: "root", host: "10.0.0.2" });
  expect(sshCommand(odd, [odd])).toBe("ssh -p 2222 root@10.0.0.2");
  expect(sshCommand(b, [a, b])).toBe(
    "ssh -J ops@a.example -p 22 ops@b.example",
  );
  expect(sshCommand(c, [a, b, c])).toBe(
    "ssh -J ops@a.example,ops@b.example -p 22 ops@c.example",
  );
});

test("断开影响面：会话数含已激活下游；没有会话也没有下游时无需确认", () => {
  const [a, b, c] = chain() as [never, never, never];
  const sessions = (id: string) => (id === "b" ? 2 : 0);
  const imp = disconnectImpact(a, [a, b, c], sessions);
  expect(imp.downstream.map((d) => d.label)).toEqual(["b"]); // c 未激活，不连带
  expect(imp.sessions).toBe(2);
  expect(imp.needsConfirm).toBe(true);
  const solo = conn("solo", { status: "active" });
  expect(disconnectImpact(solo, [solo], () => 0).needsConfirm).toBe(false);
  expect(disconnectImpact(solo, [solo], () => 1).needsConfirm).toBe(true);
});

test("删除守卫：激活中 > 被当跳板（点名）> 有目录；其余放行", () => {
  expect(deleteGuard(conn("x", { status: "active" }), 0).blocked).toContain(
    "先断开",
  );
  expect(
    deleteGuard(
      conn("x", { dependants: [{ id: "y", label: "Mac 构建机" }] }),
      3,
    ).blocked,
  ).toContain("「Mac 构建机」");
  expect(deleteGuard(conn("x"), 2).blocked).toContain("2 个目录");
  expect(deleteGuard(conn("x"), 0).blocked).toBeNull();
});

test("新建校验：名称/主机/用户必填，私钥必选，密码非空", () => {
  const e = validateForm(EMPTY_FORM, []);
  expect(Object.keys(e).sort()).toEqual(["auth", "host", "label", "user"]);
  const p = validateForm({ ...EMPTY_FORM, authKind: "password" }, []);
  expect(p.auth).toBe("填写密码");
});

test("新建校验：主机不含空格；端口 1–65535；主机+端口+用户不重复；名称不重复", () => {
  const ok = {
    ...EMPTY_FORM,
    label: "N",
    host: "h.example",
    user: "u",
    keyId: "k",
  };
  expect(validateForm({ ...ok, host: "a b" }, []).host).toContain("空格");
  for (const port of ["0", "65536", "abc", "", "22.5"])
    expect(validateForm({ ...ok, port }, []).port).toBeTruthy();
  expect(validateForm({ ...ok, port: "65535" }, [])).toEqual({});
  const existing = conn("e", {
    label: "N2",
    host: "h.example",
    user: "u",
    port: 22,
  });
  expect(validateForm(ok, [existing]).host).toContain("N2");
  expect(validateForm(ok, [existing]).host).toContain("相同");
  expect(
    validateForm({ ...ok, host: "other" }, [conn("e", { label: "N" })]).label,
  ).toContain("占用");
});

test("新建校验：跳板选了环路外的超深候选会被拦", () => {
  const all = chain() as never[];
  const ok = { ...EMPTY_FORM, label: "N", host: "h", user: "u", keyId: "k" };
  expect(validateForm({ ...ok, jumpId: "e" }, all).jump).toContain("4 跳");
  expect(validateForm({ ...ok, jumpId: "d" }, all).jump).toBeUndefined();
});

test("相对时间", () => {
  const now = Date.parse("2026-10-25T12:00:00.000Z");
  expect(relTime("2026-10-25T11:59:50.000Z", now)).toBe("刚刚");
  expect(relTime("2026-10-25T11:30:00.000Z", now)).toBe("30 分钟前");
  expect(relTime("2026-10-25T09:00:00.000Z", now)).toBe("3 小时前");
  expect(relTime("2026-10-22T12:00:00.000Z", now)).toBe("3 天前");
  expect(relTime(null, now)).toBe("—");
});

test("日志计数按类别统计", () => {
  const row = (type: "fail" | "activate") =>
    ({
      id: 1,
      at: "",
      type,
      text: "",
      detail: "",
      connectionId: "a",
      connection: "a",
    }) as const;
  expect(logCounts([row("fail"), row("fail"), row("activate")])).toMatchObject({
    all: 3,
    fail: 2,
    activate: 1,
    config: 0,
  });
});

test("断开影响面：多级下游（孙辈）也连带，会话数逐级累加；断开中间一环不牵连上游", () => {
  // a ← b ← c 三级都已激活
  const a = conn("a", { status: "active" });
  const b = conn("b", { status: "active", jump: ["a"] });
  const c = conn("c", { status: "active", jump: ["b"] });
  const per: Record<string, number> = { a: 1, b: 2, c: 4 };
  const imp = disconnectImpact(
    a as never,
    [a, b, c] as never[],
    (id) => per[id] ?? 0,
  );
  expect(imp.downstream.map((d) => d.label)).toEqual(["b", "c"]);
  expect(imp.sessions).toBe(7);
  // 断开中间一环：上游不受牵连
  const mid = disconnectImpact(
    b as never,
    [a, b, c] as never[],
    (id) => per[id] ?? 0,
  );
  expect(mid.downstream.map((d) => d.label)).toEqual(["c"]);
  expect(mid.sessions).toBe(6);
});

// ---- 详情页草稿 ----

test("草稿：由连接视图取出可改的字段；没有凭据的连接按私钥模式、不带私钥", () => {
  expect(editableOf(conn("a", { jump: ["j"] }))).toEqual({
    host: "a.example",
    port: "22",
    user: "ops",
    jump: "j",
    authKind: "key",
    keyId: "k1",
    hostKey: "ask",
    keepAlive: true,
  });
  const pw = editableOf(
    conn("a", { auth: { kind: "password", secretId: "p" } }),
  );
  expect([pw.authKind, pw.keyId]).toEqual(["password", ""]);
  const none = editableOf(conn("a", { auth: { kind: null, secretId: null } }));
  expect([none.authKind, none.keyId]).toEqual(["key", ""]);
});

test("草稿：失焦收拾首尾空白与前导零，非数字的端口保持原样", () => {
  const e = editableOf(conn("a"));
  expect(tidy({ ...e, host: " h ", user: "u ", port: " 0022 " })).toMatchObject(
    {
      host: "h",
      user: "u",
      port: "22",
    },
  );
  expect(tidy({ ...e, port: " 22a " }).port).toBe("22a");
});

test("草稿校验：主机、端口、用户；认证只在动过它时才校验", () => {
  const saved = editableOf(conn("a"));
  expect(validateEdit(saved, saved, "")).toEqual({});
  expect(
    validateEdit({ ...saved, host: "a b", port: "0", user: " " }, saved, ""),
  ).toEqual({
    host: "主机不能包含空格",
    port: "端口必须是 1–65535 的整数",
    user: "填写登录用户",
  });
  // 从私钥改成密码：必须带密码；已经是密码模式时空着表示不换
  expect(validateEdit({ ...saved, authKind: "password" }, saved, "").auth).toBe(
    "填写密码",
  );
  expect(
    validateEdit({ ...saved, authKind: "password" }, saved, "x").auth,
  ).toBeUndefined();
  const pwSaved = editableOf(
    conn("a", { auth: { kind: "password", secretId: "p" } }),
  );
  expect(validateEdit(pwSaved, pwSaved, "").auth).toBeUndefined();
  // 私钥模式把私钥清空：已有私钥时要补选；本来就没有凭据时不标红
  expect(validateEdit({ ...saved, keyId: "" }, saved, "").auth).toBe(
    "选择一把私钥",
  );
  const bare = editableOf(conn("a", { auth: { kind: null, secretId: null } }));
  expect(validateEdit(bare, bare, "").auth).toBeUndefined();
});

test("草稿落库：只带改动的字段拼成一次 PATCH；密码单独带出", () => {
  const saved = editableOf(conn("a"));
  expect(patchOf(saved, saved, "")).toEqual({ input: {} });
  expect(
    patchOf(
      {
        ...saved,
        host: " h ",
        port: "2222",
        jump: "j",
        keyId: "k2",
        hostKey: "tofu",
        keepAlive: false,
      },
      saved,
      "",
    ),
  ).toEqual({
    input: {
      host: "h",
      port: 2222,
      jump: ["j"],
      auth: { secretId: "k2", kind: "key" },
      policy: { hostKey: "tofu", keepAlive: false },
    },
  });
  expect(
    patchOf({ ...saved, jump: "" }, { ...saved, jump: "j" }, "").input,
  ).toEqual({ jump: [] });
  // 换成密码：不写 auth，交给 store 先建凭据；密码只在密码模式才带
  expect(patchOf({ ...saved, authKind: "password" }, saved, "pw")).toEqual({
    input: {},
    password: "pw",
  });
  expect(patchOf(saved, saved, "leftover")).toEqual({ input: {} });
  // 已是密码模式时空着不换
  const pwSaved = editableOf(
    conn("a", { auth: { kind: "password", secretId: "p" } }),
  );
  expect(patchOf(pwSaved, pwSaved, "")).toEqual({ input: {} });
});
