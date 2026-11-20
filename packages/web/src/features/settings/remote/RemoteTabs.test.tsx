// 密钥页与连接日志页（主机密钥已并入连接详情，见 RemoteConns / RemoteActivation）。
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { LogEntry } from "../../../api/connections";
import { choose } from "../../../test/select";
import { clearToasts } from "../../../ui";
import { conn, isDisabled, key, mount } from "./testkit";

afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
});

const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const rowMenu = async (keyName: string, item: string) => {
  fireEvent.click(screen.getByRole("button", { name: `${keyName} 的操作` }));
  return screen.findByRole("menuitem", { name: new RegExp(`^${item}`) });
};
const tab = (name: RegExp) =>
  fireEvent.click(screen.getByRole("tab", { name }));
const change = (el: HTMLElement, value: string) =>
  fireEvent.change(el, { target: { value } });
const bodyRows = () =>
  screen
    .getAllByRole("row")
    .filter((r) => r.querySelector("td:not([colspan])"));

test("密钥页：表格列、只列私钥、被引用数；服务端不支持生成所以没有生成按钮", async () => {
  await mount({
    conns: [conn("a"), conn("b")],
    creds: [
      key("k1"),
      key("k2", { name: "ci-key", keyType: "ssh-rsa" }),
      key("pw", { kind: "password", name: "a 密码" }),
      key("k3", { name: "locked", fingerprint: null, keyType: null }),
    ],
  });
  tab(/^密钥/);
  const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
  expect(headers).toEqual(["名称", "类型", "指纹", "引用", "操作"]);
  const rows = bodyRows().map((r) => r.textContent ?? "");
  expect(rows).toHaveLength(3); // 密码凭据不在密钥页
  expect(rows.join("|")).not.toContain("a 密码");
  expect(rows[0]).toContain("ys-deploy-ed25519");
  expect(rows[0]).toContain("2 条连接");
  expect(rows[0]).toContain("SHA256:k1fp");
  expect(rows[2]).toContain("不可读"); // 带口令/解析不了
  expect(screen.queryByRole("button", { name: /生成/ })).toBeNull();
  expect(screen.getByRole("tab", { name: /^密钥/ }).textContent).toContain("3");
});

test("被连接引用的密钥不能删：菜单项置灰并写明几条连接在用；不发删除请求", async () => {
  const { server } = await mount({
    conns: [conn("a", { label: "GPU 训练机" })],
    creds: [key("k1")],
  });
  tab(/^密钥/);
  const del = await rowMenu("ys-deploy-ed25519", "删除密钥");
  expect(isDisabled(del)).toBe(true);
  expect(del.textContent).toContain("被 1 条连接使用");
  expect(screen.getByText("1 条连接").getAttribute("title") ?? "").toContain(
    "「GPU 训练机」",
  );
  expect(server.writes()).toHaveLength(0);
});

test("未被引用的密钥：弹窗说明不会撤销远端 authorized_keys，确认后删除", async () => {
  const { server } = await mount({
    conns: [conn("a")],
    creds: [key("k1"), key("k2", { name: "spare" })],
  });
  tab(/^密钥/);
  fireEvent.click(await rowMenu("spare", "删除密钥"));
  const dlg = await screen.findByRole("dialog", { name: "删除「spare」" });
  expect(dlg.textContent).toContain("不会自动撤销");
  expect(server.writes()).toHaveLength(0);
  fireEvent.click(within(dlg).getByRole("button", { name: "删除" }));
  await waitFor(() => expect(bodyRows()).toHaveLength(1));
  expect(server.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
    "DELETE /api/v1/secrets/k2",
  ]);
});

test("复制指纹在行菜单里；读不出指纹的密钥没有这一项", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  await mount({
    conns: [],
    creds: [key("k1"), key("k3", { name: "locked", fingerprint: null })],
  });
  tab(/^密钥/);
  fireEvent.click(await rowMenu("ys-deploy-ed25519", "复制指纹"));
  expect(writeText).toHaveBeenCalledWith("SHA256:k1fp");
  fireEvent.keyDown(document.body, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "locked 的操作" }));
  await screen.findByRole("menuitem", { name: /^删除密钥/ });
  expect(screen.queryByRole("menuitem", { name: "复制指纹" })).toBeNull();
});

test("导入私钥：名称与内容没填完主按钮置灰；重名给出字段错误，成功后出现在表格", async () => {
  const { server } = await mount({ conns: [], creds: [key("k1")] });
  tab(/^密钥/);
  click("导入私钥");
  const dlg = await screen.findByRole("dialog", { name: "导入私钥" });
  expect(dlg.textContent).toContain("服务端暂不支持生成密钥");
  const go = () =>
    within(dlg).getByRole("button", { name: "导入并保存" }) as HTMLElement;
  expect(isDisabled(go())).toBe(true);
  change(within(dlg).getByLabelText("名称"), "ys-deploy-ed25519");
  expect(isDisabled(go())).toBe(true);
  change(within(dlg).getByLabelText("私钥"), "PEM-BODY");
  expect(isDisabled(go())).toBe(false);
  fireEvent.click(go());
  await waitFor(() =>
    expect(within(dlg).getByRole("alert").textContent).toContain("已被占用"),
  );
  change(within(dlg).getByLabelText("名称"), "smoke-key");
  fireEvent.click(go());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    bodyRows()
      .map((r) => r.textContent)
      .join("|"),
  ).toContain("smoke-key");
  expect(server.writes().at(-1)?.body).toEqual({
    name: "smoke-key",
    kind: "ssh_key",
    value: "PEM-BODY",
  });
});

const entry = (
  id: number,
  type: LogEntry["type"],
  text: string,
  at = `2026-10-25T10:${String(id % 60).padStart(2, "0")}:00.000Z`,
): LogEntry => ({
  id,
  at,
  type,
  text,
  detail: type === "fail" ? "tcp_refused" : "",
});

test("连接日志：按类别筛选，chip 带计数；多条连接合并、新的在前", async () => {
  await mount({
    conns: [conn("a", { label: "GPU" }), conn("b", { label: "Mac" })],
    creds: [key("k1")],
    logs: {
      a: [
        entry(3, "fail", "激活失败：TCP 连接"),
        entry(1, "activate", "激活成功"),
      ],
      b: [
        entry(2, "hostkey", "已信任新主机密钥"),
        entry(4, "config", "修改配置"),
      ],
    },
  });
  tab(/^连接日志/);
  await waitFor(() => expect(bodyRows()).toHaveLength(4));
  const chip = (name: string) =>
    screen.getByRole("button", { name: new RegExp(`^${name}`) });
  expect(chip("全部").textContent).toContain("4");
  expect(chip("失败").textContent).toContain("1");
  expect(chip("断开").textContent).toContain("0");
  // 合并后按时间倒序：config(10:04) 在最前
  expect(bodyRows()[0]?.textContent).toContain("修改配置");
  expect(bodyRows()[0]?.textContent).toContain("Mac");
  fireEvent.click(chip("失败"));
  expect(bodyRows()).toHaveLength(1);
  expect(bodyRows()[0]?.textContent).toContain("GPU");
  expect(bodyRows()[0]?.textContent).toContain("tcp_refused");
  expect(chip("失败").getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(chip("断开"));
  expect(screen.getByText("这个筛选下还没有事件")).toBeTruthy();
});

test("连接日志：加载更早的事件", async () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    entry(60 - i, "activate", `事件 ${60 - i}`),
  );
  const { server } = await mount({
    conns: [conn("a")],
    creds: [key("k1")],
    logs: { a: many },
  });
  tab(/^连接日志/);
  await waitFor(() => expect(bodyRows()).toHaveLength(50));
  click("加载更早的");
  await waitFor(() => expect(bodyRows()).toHaveLength(60));
  expect(screen.queryByRole("button", { name: "加载更早的" })).toBeNull();
  const logCalls = server.calls
    .filter((c) => /\/log/.test(c.path))
    .map((c) => c.path);
  expect(logCalls).toEqual([
    "/api/v1/connections/a/log?limit=50",
    "/api/v1/connections/a/log?limit=50&before=11",
  ]);
});

test("密钥删除后，连接详情里的私钥下拉随之刷新", async () => {
  await mount({
    conns: [conn("a")],
    creds: [key("k1"), key("k2", { name: "spare" })],
  });
  const options = () => {
    const sel = screen.getByRole("combobox", { name: "私钥" });
    fireEvent.click(sel);
    const texts = screen.getAllByRole("option").map((o) => o.textContent);
    fireEvent.click(sel);
    return texts;
  };
  expect(options()).toContain("spare");
  tab(/^密钥/);
  fireEvent.click(await rowMenu("spare", "删除密钥"));
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "删除「spare」" }),
    ).getByRole("button", { name: "删除" }),
  );
  await waitFor(() => expect(bodyRows()).toHaveLength(1));
  tab(/^连接\d/);
  expect(options()).not.toContain("spare");
  // 选不到的私钥不会被偷偷换掉：选择仍可用
  choose(screen.getByRole("combobox", { name: "私钥" }), "k1");
});
