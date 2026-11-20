import { expect, test, vi } from "vitest";
import { canvasRelOf, parseImageRef, resolveImageTarget } from "./imageRef";

// 会话 s-ssh 的主目录在 ssh 主机 dev1 上；s-local 的主目录在 Server 本机
vi.mock("../../api/directories", () => ({
  sessionDirectories: async (_token: unknown, sessionId: string) => ({
    ok: true,
    data:
      sessionId === "s-ssh"
        ? [{ environmentId: "dev1", path: "/data/proj", role: "local" }]
        : [{ environmentId: "local", path: "/w/proj", role: "local" }],
  }),
}));
vi.mock("../../api/environments", () => ({
  listEnvironments: async () => ({
    ok: true,
    data: [
      { id: "dev1", name: "开发机" },
      { id: "gpu", name: "gpu-box" },
    ],
  }),
}));

test("file:// 形式：主机 + 绝对路径", () => {
  expect(parseImageRef("file://server/home/me/a.png")).toEqual({
    host: "server",
    path: "/home/me/a.png",
    relative: false,
  });
  // file:///abs：没有主机，按本机
  expect(parseImageRef("file:///tmp/a.png")).toEqual({
    path: "/tmp/a.png",
    relative: false,
  });
});

test("file:主机:绝对路径 形式（含中文主机名与转义）", () => {
  expect(parseImageRef("file:开发机:/tmp/图 1.png")).toEqual({
    host: "开发机",
    path: "/tmp/图 1.png",
    relative: false,
  });
  expect(parseImageRef("file:%E5%BC%80%E5%8F%91%E6%9C%BA:/tmp/a.png")).toEqual({
    host: "开发机",
    path: "/tmp/a.png",
    relative: false,
  });
});

test("裸绝对路径按本机；裸相对路径标记为相对", () => {
  expect(parseImageRef("/tmp/a.png")).toEqual({
    path: "/tmp/a.png",
    relative: false,
  });
  expect(parseImageRef("./tmp/cards.png")).toEqual({
    path: "./tmp/cards.png",
    relative: true,
  });
  expect(parseImageRef("https://example.com/a.png")).toEqual({
    path: "https://example.com/a.png",
    relative: true,
  });
});

test("给了 base 的相对地址：按 md 所在目录解析，不看会话；.. 能出目录，编码的空格会还原", async () => {
  const base = { kind: "file", env: "h1", dir: "/w/docs" } as const;
  expect(await resolveImageTarget("./a.assets/x.png", undefined, base)).toEqual(
    {
      env: "h1",
      path: "/w/docs/a.assets/x.png",
    },
  );
  expect(await resolveImageTarget("../img/y.png", undefined, base)).toEqual({
    env: "h1",
    path: "/w/img/y.png",
  });
  expect(
    await resolveImageTarget("a.assets/image%201.png", undefined, base),
  ).toEqual({ env: "h1", path: "/w/docs/a.assets/image 1.png" });
  // 带主机的 file: 引用不受 base 影响
  expect(
    await resolveImageTarget("file:server:/tmp/a.png", undefined, base),
  ).toEqual({ env: "local", path: "/tmp/a.png" });
});

test("主机名：local 是会话主目录所在的主机，server 是 Server 本机，其余按连接名或 id（大小写不敏感）", async () => {
  const at = (ref: string, sid?: string) => resolveImageTarget(ref, sid);
  // 主目录在 ssh 主机上：local 指向它，server 仍是 Server 本机
  expect(await at("file:local:/data/proj/a.png", "s-ssh")).toEqual({
    env: "dev1",
    path: "/data/proj/a.png",
  });
  expect(await at("file:server:/tmp/a.png", "s-ssh")).toEqual({
    env: "local",
    path: "/tmp/a.png",
  });
  expect(await at("file:LOCAL:/w/proj/a.png", "s-local")).toEqual({
    env: "local",
    path: "/w/proj/a.png",
  });
  expect(await at("file:开发机:/x.png", "s-ssh")).toEqual({
    env: "dev1",
    path: "/x.png",
  });
  expect(await at("file:GPU:/x.png", "s-ssh")).toEqual({
    env: "gpu",
    path: "/x.png",
  });
  // 附件区：路径以附件区根为 /，环境固定 attachment
  expect(
    await at("file:attachment:/2026-11-16/ab12cd34-c.png", "s-ssh"),
  ).toEqual({
    env: "attachment",
    path: "/2026-11-16/ab12cd34-c.png",
  });
});

test("相对路径落在会话主目录所在的主机上（主目录在 ssh 时不是 Server 本机）", async () => {
  expect(await resolveImageTarget("out/c.png", "s-ssh")).toEqual({
    env: "dev1",
    path: "/data/proj/out/c.png",
  });
  expect(await resolveImageTarget("./c.png", "s-local")).toEqual({
    env: "local",
    path: "/w/proj/c.png",
  });
});

test("解析不了的引用抛出带原因的错误：没有主机、未知主机、外链、没有会话", async () => {
  const why = (ref: string, sid?: string) =>
    resolveImageTarget(ref, sid).then(
      () => "ok",
      (e: Error) => e.message,
    );
  expect(await why("/tmp/a.png", "s-local")).toContain("缺少主机名");
  expect(await why("file:///tmp/a.png", "s-local")).toContain("缺少主机名");
  expect(await why("file:nope:/tmp/a.png", "s-local")).toBe(
    "没有叫「nope」的主机",
  );
  expect(await why("file:本机:/tmp/a.png", "s-local")).toBe(
    "没有叫「本机」的主机",
  );
  expect(await why("https://x.dev/a.png", "s-local")).toContain("外链");
  expect(await why("c.png")).toContain("没有会话目录");
  expect(await why("file:dev1:tmp/a.png", "s-local")).toContain("以 / 开头");
});

test("笔记里的相对图片地址换成相对 .canvas/ 的路径", () => {
  expect(canvasRelOf("./访谈.assets/a.png", "访谈.md")).toBe(
    "访谈.assets/a.png",
  );
  expect(canvasRelOf("访谈.assets/a.png", "产品/访谈.md")).toBe(
    "产品/访谈.assets/a.png",
  );
  expect(canvasRelOf("../访谈.assets/a.png", "产品/访谈.md")).toBe(
    "访谈.assets/a.png",
  );
  // 出了 .canvas/：留着 ../，是项目文件引用（服务端再核对在项目目录之内）
  expect(canvasRelOf("../../docs/a.png", "产品/访谈.md")).toBe("../docs/a.png");
  expect(canvasRelOf("../../../x.png", "访谈.md")).toBe("../../../x.png");
  expect(canvasRelOf("a%20b.png", "n.md")).toBe("a b.png");
  // 不是相对路径：交给文件接口那一套
  expect(canvasRelOf("/tmp/a.png", "n.md")).toBeNull();
  expect(canvasRelOf("file:local:/tmp/a.png", "n.md")).toBeNull();
  expect(canvasRelOf("https://x.dev/a.png", "n.md")).toBeNull();
  expect(canvasRelOf("", "n.md")).toBeNull();
});
