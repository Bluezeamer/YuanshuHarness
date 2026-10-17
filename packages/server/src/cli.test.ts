import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Deps, execute } from "./cli.js";

let base: string;
let webRoot: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-cli-"));
  webRoot = path.join(base, "web");
  await mkdir(webRoot);
  await writeFile(path.join(webRoot, "index.html"), "<title>x</title>");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function harness(over: Partial<Deps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const controller = new AbortController();
  const deps: Deps = {
    env: {},
    home: base,
    cwd: base,
    stdout: { write: (s) => void out.push(s) },
    stderr: { write: (s) => void err.push(s) },
    signal: controller.signal,
    webRoot,
    logStream: { write: () => {} },
    ...over,
  };
  return {
    deps,
    controller,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function waitHealthy(port: number) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.status === 200) return;
    } catch {
      // 还没起来，继续等
    }
    if (Date.now() > deadline) throw new Error("服务没有在 5 秒内变为可访问");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("用法与帮助（R1）", () => {
  test("裸命令：用法写 stderr，非零，不启动", async () => {
    const h = harness();
    expect(await execute([], h.deps)).not.toBe(0);
    expect(h.stderr()).toContain("yuanshu serve");
    expect(h.stdout()).toBe("");
  });

  test("未知子命令：点名，非零", async () => {
    const h = harness();
    expect(await execute(["start"], h.deps)).not.toBe(0);
    expect(h.stderr()).toContain("start");
    expect(h.stdout()).toBe("");
  });

  test.each([["--help"], ["-h"], ["serve", "--help"]])(
    "%s：用法写 stdout，退出 0",
    async (...argv) => {
      const h = harness();
      expect(await execute(argv, h.deps)).toBe(0);
      expect(h.stdout()).toContain("yuanshu serve");
      expect(h.stderr()).toBe("");
    },
  );

  test("配置非法：非零，指明哪一项，且不创建数据目录", async () => {
    const dataDir = path.join(base, "data");
    const h = harness();
    const code = await execute(
      ["serve", "--port", "70000", "--data-dir", dataDir],
      h.deps,
    );
    expect(code).not.toBe(0);
    expect(h.stderr()).toContain("--port");
    await expect(stat(dataDir)).rejects.toThrow();
  });
});

describe("serve（R7）", () => {
  test("运行到信号到来后以 0 退出，且 5 秒内完成", async () => {
    const port = await freePort();
    const dataDir = path.join(base, "data");
    const h = harness();
    const done = execute(
      ["serve", "--port", String(port), "--data-dir", dataDir],
      h.deps,
    );
    await waitHealthy(port);

    const started = Date.now();
    h.controller.abort();
    expect(await done).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await readdir(dataDir)).toEqual(["sessions", "yuanshu.db"]);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  test("环境变量同样生效", async () => {
    const port = await freePort();
    const h = harness({
      env: {
        YUANSHU_PORT: String(port),
        YUANSHU_DATA_DIR: path.join(base, "data"),
      },
    });
    const done = execute(["serve"], h.deps);
    await waitHealthy(port);
    h.controller.abort();
    expect(await done).toBe(0);
  });

  test("监听失败：非零，错误含 host 与 port", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const { port } = blocker.address() as net.AddressInfo;
    try {
      const h = harness();
      const code = await execute(
        [
          "serve",
          "--port",
          String(port),
          "--data-dir",
          path.join(base, "data"),
        ],
        h.deps,
      );
      expect(code).not.toBe(0);
      expect(h.stderr()).toContain(`127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
