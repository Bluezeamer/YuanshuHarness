import { describe, expect, test } from "vitest";
import { fileUrl, serviceHost } from "./hostnames.js";
import { resolveTarget, TargetError, type TargetOptions } from "./target.js";

const UUID = "0199c3e1-7a2b-7c4d-8e9f-0123456789ab";

// 环境表：名字（web1）、id（uuid）与 server 都指得到。
const envs: Record<string, string> = {
  server: "local",
  local: "local",
  web1: UUID,
  [UUID]: UUID,
};

const opts: TargetOptions = {
  findEnv: (name) => envs[name.toLowerCase()] ?? null,
  defaultEnvId: "local",
};

const resolve = (raw: string, o: TargetOptions = opts) => resolveTarget(raw, o);

describe("公网地址", () => {
  test.each([
    ["https://example.com", "https://example.com/"],
    ["http://example.com/a?b=c#d", "http://example.com/a?b=c#d"],
    ["  https://example.com  ", "https://example.com/"],
    ["HTTP://EXAMPLE.COM", "http://example.com/"],
    ["http://8.8.8.8:8080/x", "http://8.8.8.8:8080/x"],
  ])("%s → public %s", (raw, url) => {
    expect(resolve(raw)).toEqual({ kind: "public", url });
  });
});

describe("虚拟主机名（服务）", () => {
  test("server.localhost 指向本机，保留路径与查询", () => {
    expect(resolve("http://server.localhost:3000/a/b?q=1#h")).toEqual({
      kind: "service",
      envId: "local",
      port: 3000,
      url: "http://server.localhost:3000/a/b?q=1#h",
    });
  });

  test("环境 id 的虚拟主机名", () => {
    expect(resolve(`http://${UUID}.localhost:8080/`)).toEqual({
      kind: "service",
      envId: UUID,
      port: 8080,
      url: `http://${UUID}.localhost:8080/`,
    });
  });

  test("大小写不敏感，标签归一成环境 id", () => {
    const t = resolve("http://SERVER.LOCALHOST:3000/");
    expect(t.kind === "service" && t.url).toBe("http://server.localhost:3000/");
  });

  test("没写端口按 80", () => {
    expect(resolve("http://server.localhost/x")).toEqual({
      kind: "service",
      envId: "local",
      port: 80,
      url: "http://server.localhost:80/x",
    });
  });

  test("服务只支持 http", () => {
    expect(() => resolve("https://server.localhost:3000/")).toThrow(
      /只支持 http/,
    );
  });
});

describe("裸回环地址", () => {
  // 裸 localhost 说明不了是哪台主机：四种写法一律拒，原文钉住
  test.each([
    "localhost:3000",
    "127.0.0.1:3000",
    "[::1]:3000",
    "http://localhost:3000/",
  ])("%s 被拒", (raw) => {
    expect(() => resolve(raw)).toThrow(TargetError);
    expect(() => resolve(raw)).toThrow(
      "裸 localhost 没有说明是哪台主机：请写 local:<端口>，或 <主机名>:<端口>（主机名见 list_directories）",
    );
  });

  test("有默认环境也照样拒：默认只用于不写主机的绝对路径", () => {
    expect(() => resolve("http://localhost:5173/app?x=1")).toThrow(
      /裸 localhost/,
    );
  });

  // 用户在地址栏里写 localhost 是常态：接线处给 loopbackEnvId（工作区主目录所在的环境）就照常解析
  test("给了 loopbackEnvId（用户地址栏）：四种写法都指向它", () => {
    const user: TargetOptions = { ...opts, loopbackEnvId: UUID };
    for (const raw of [
      "localhost:3000",
      "127.0.0.1:3000",
      "[::1]:3000",
      "http://localhost:3000/",
    ])
      expect(resolve(raw, user)).toMatchObject({
        kind: "service",
        envId: UUID,
        port: 3000,
      });
    expect(resolve("http://localhost/x", user)).toMatchObject({ port: 80 });
    expect(() => resolve("https://localhost:3000/", user)).toThrow(
      /只支持 http/,
    );
  });

  test("loopbackEnvId 为 null（找不到主目录）时仍拒绝", () => {
    expect(() =>
      resolve("localhost:3000", { ...opts, loopbackEnvId: null }),
    ).toThrow(/裸 localhost/);
  });
});

describe("host:端口", () => {
  test.each([
    ["web1:3000", `http://${serviceHost(UUID, 3000)}`],
    ["web1:3000/path?q=1", `http://${serviceHost(UUID, 3000)}/path?q=1`],
    ["server:8080/", "http://server.localhost:8080/"],
    ["local:3000", "http://server.localhost:3000"],
    ["WEB1:3000", `http://${serviceHost(UUID, 3000)}`],
  ])("%s", (raw, url) => {
    const t = resolve(raw);
    expect(t.kind).toBe("service");
    expect(t.url).toBe(url);
  });

  test("找不到主机时提示公网地址要带协议", () => {
    expect(() => resolve("example.com:8080")).toThrow(TargetError);
    expect(() => resolve("example.com:8080")).toThrow(
      /找不到主机 example\.com.*http:\/\//,
    );
  });

  test("端口越界", () => {
    expect(() => resolve("web1:0")).toThrow(/1–65535/);
    expect(() => resolve("web1:70000")).toThrow(/1–65535/);
  });
});

describe("文件", () => {
  test("绝对路径落在默认环境", () => {
    expect(resolve("/w/sub/a.html")).toEqual({
      kind: "file",
      envId: "local",
      path: "/w/sub/a.html",
      url: fileUrl("local", "/w/sub/a.html"),
    });
  });

  test("默认环境为 null 时拒绝", () => {
    expect(() => resolve("/w/a.html", { ...opts, defaultEnvId: null })).toThrow(
      /没有默认目录/,
    );
  });

  test("主机名:/绝对路径", () => {
    expect(resolve("web1:/srv/a b.html")).toEqual({
      kind: "file",
      envId: UUID,
      path: "/srv/a b.html",
      url: fileUrl(UUID, "/srv/a b.html"),
    });
  });

  test("别的主机上的绝对路径", () => {
    expect(
      resolve("dev1:/srv/a.html", {
        ...opts,
        findEnv: (name) => (name === "dev1" ? UUID : null),
      }),
    ).toMatchObject({ kind: "file", envId: UUID, path: "/srv/a.html" });
  });

  test("主机名不存在", () => {
    expect(() => resolve("nope:/a.html")).toThrow(/找不到主机 nope/);
  });

  test("文件虚拟主机地址", () => {
    expect(resolve("http://server.files.localhost/w/a%20b.html")).toEqual({
      kind: "file",
      envId: "local",
      path: "/w/a b.html",
      url: "http://server.files.localhost/w/a%20b.html",
    });
  });
});

describe("拒绝的输入", () => {
  test.each([
    "",
    "   ",
    "file:///etc/passwd",
    "data:text/html,x",
    "chrome://settings",
    "attachment:/a.html",
    "view-source:http://example.com",
    "javascript:alert(1)",
    "ftp://example.com/x",
    "not a url",
    "example.com",
  ])("%s", (raw) => {
    expect(() => resolve(raw)).toThrow(TargetError);
  });

  test("超长地址", () => {
    expect(() => resolve(`https://example.com/${"a".repeat(4096)}`)).toThrow(
      /过长/,
    );
  });

  test("不支持的协议给固定文案", () => {
    expect(() => resolve("data:text/html,x")).toThrow(
      "只支持 http 与 https 地址、绝对文件路径、host:端口",
    );
  });
});
