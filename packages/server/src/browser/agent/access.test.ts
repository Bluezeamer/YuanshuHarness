// 站点授权与目标放行的判定：表驱动，不装浏览器。
import { expect, test } from "vitest";
import type { Target } from "../net/target.js";
import { type AccessState, decideOpen, isHighValueHost } from "./access.js";

const state = (
  opts: { approved?: boolean; known?: boolean } = {},
): AccessState => ({
  approved: () => opts.approved ?? false,
  known: () => opts.known ?? false,
});
const approved = state({ approved: true });
const refused = state();
const known = state({ known: true });

const publicTarget = (url: string): Target => ({ kind: "public", url });

const serviceTarget = (envId: string, port: number): Target => ({
  kind: "service",
  envId,
  port,
  url: `http://${envId === "local" ? "server" : envId}.localhost:${port}/`,
});

test("本工作区的文件免审批", () => {
  const targets: Target[] = [
    {
      kind: "file",
      envId: "local",
      path: "/w/index.html",
      url: "http://server.files.localhost/w/index.html",
    },
    {
      kind: "file",
      envId: "e2",
      path: "/srv/app.html",
      url: "http://web1.files.localhost/srv/app.html",
    },
  ];
  for (const target of targets) {
    expect(decideOpen(target, "w1", refused)).toEqual({ kind: "allow" });
    expect(decideOpen(target, "w1", approved)).toEqual({ kind: "allow" });
  }
});

test("服务：见过的端口或已批准的来源放行，都没有则要问", () => {
  expect(decideOpen(serviceTarget("local", 5173), "w1", known)).toEqual({
    kind: "allow",
  });
  expect(decideOpen(serviceTarget("e2", 3000), "w1", known)).toEqual({
    kind: "allow",
  });
  expect(decideOpen(serviceTarget("e2", 3000), "w1", approved)).toEqual({
    kind: "allow",
  });

  const d = decideOpen(serviceTarget("e2", 3000), "w1", refused, "web1:3000");
  expect(d).toEqual({
    kind: "ask",
    origin: "http://e2.localhost:3000",
    reason: "agent 要访问 web1:3000 上的服务（这个端口没在命令输出里出现过）",
    service: true,
  });

  // 问的是这个工作区、这个环境、这个端口
  const seen: Array<[string, string, number]> = [];
  const spy: AccessState = {
    approved: () => false,
    known: (workspaceKey, envId, port) => {
      seen.push([workspaceKey, envId, port]);
      return false;
    },
  };
  decideOpen(serviceTarget("e2", 8080), "w7", spy);
  expect(seen).toEqual([["w7", "e2", 8080]]);
});

test("公网：按工作区与 origin 判断已批准与否", () => {
  const target = publicTarget("https://example.com/a?b=1");
  expect(decideOpen(target, "w1", approved)).toEqual({ kind: "allow" });
  expect(decideOpen(target, "w1", refused)).toMatchObject({
    kind: "ask",
    origin: "https://example.com",
  });
  // 见过端口不影响公网站点
  expect(decideOpen(target, "w1", known)).toMatchObject({ kind: "ask" });

  // 问的是 origin（协议+主机+端口），不是路径；同一工作区按 origin 查
  const seen: Array<[string, string]> = [];
  const byOrigin: AccessState = {
    approved: (workspaceKey, origin) => {
      seen.push([workspaceKey, origin]);
      return origin === "http://localhost:8080";
    },
    known: () => false,
  };
  expect(
    decideOpen(publicTarget("http://localhost:8080/x"), "w2", byOrigin),
  ).toEqual({
    kind: "allow",
  });
  expect(seen).toEqual([["w2", "http://localhost:8080"]]);
  // 端口不同就是另一个站点
  expect(
    decideOpen(publicTarget("http://localhost:8081/x"), "w2", byOrigin),
  ).toMatchObject({
    kind: "ask",
    origin: "http://localhost:8081",
  });
});

test("ask 的理由写清是哪个站点", () => {
  const d = decideOpen(
    publicTarget("https://mail.example.org/inbox"),
    "w1",
    refused,
  );
  expect(d.kind).toBe("ask");
  if (d.kind !== "ask") return;
  expect(d.reason).toContain("https://mail.example.org");
  // 外部站点不带 service 标记
  expect(d.service).toBeUndefined();
});

test("高敏感站点：精确与后缀命中，前缀规则，边缘不误中", () => {
  // 名单里的站与其子域
  for (const host of [
    "mail.google.com",
    "outlook.live.com",
    "console.aws.amazon.com",
    "paypal.com",
    "github.com",
    "gist.github.com",
    "api.github.com",
    "gitlab.com",
    "alipay.com",
    "pay.weixin.qq.com",
    "PAYPAL.COM",
    "github.com.",
  ])
    expect(isHighValueHost(host), host).toBe(true);

  // 前缀规则
  for (const host of [
    "bank.example.com",
    "banking.example.com",
    "pay.example.com",
  ])
    expect(isHighValueHost(host), host).toBe(true);

  // 不能误中：标签边界之外的相似串、规则里的前缀出现在别处
  for (const host of [
    "notgithub.com",
    "github.com.evil.test",
    "mybank.example.com",
    "example.com",
    "localhost",
    "",
    "mail.google.com.evil.test",
  ])
    expect(isHighValueHost(host), host).toBe(false);
});
