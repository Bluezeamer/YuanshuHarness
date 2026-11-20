// 手动冒烟：本机 sshd 作为第二个环境，走 HTTP 层验证跨环境传输（ADR-0062）。
// 不需要模型；本机没有 sshd 时整体跳过，不进默认检查。
//
// 用法：pnpm --filter yuanshu-harness-server exec vitest run test/live/transfer-ssh.live.test.ts
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type YuanshuServer } from "../../src/server.js";
import { hasSshd, startSshd, type TestSshd } from "../support/sshd.js";

let root = "";
let sshd: TestSshd;
let server: YuanshuServer;
let http = "";
let sshEnvId = "";

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${http}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

interface Job {
  id: string;
  state: "running" | "done" | "failed" | "cancelled";
  files: number;
  bytes: number;
  error?: { code: string; message: string };
}

// 发起传输并轮询到终态，和界面里 useTransfers 做的事一致。
async function run(
  from: { env: string; path: string },
  to: { env: string; path: string },
  overwrite = false,
): Promise<Job> {
  const r = await call("POST", "/api/v1/transfer-jobs", {
    from,
    to,
    overwrite,
    sessionId: null,
  });
  expect(r.status).toBe(202);
  const id = r.body.id as string;
  let job = r.body as Job;
  // 共享的 waitFor 只收同步条件，这里要异步轮询，自己写循环。
  const deadline = Date.now() + 10_000;
  while (job.state === "running") {
    if (Date.now() > deadline) throw new Error("等待超时：传输结束");
    await new Promise((ok) => setTimeout(ok, 50));
    job = (await call("GET", `/api/v1/transfer-jobs/${id}`)).body as Job;
  }
  return job;
}

beforeAll(async () => {
  if (!hasSshd) return;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-live-xfer-")));
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  const start = path.join(root, "start");
  mkdirSync(start);
  sshd = await startSshd();
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(root, "data"),
      allowCidrs: [],
    },
    {
      webRoot: path.join(root, "web"),
      startDir: start,
      logStream: { write() {} },
    },
  );
  const addr = await server.start();
  http = `http://${addr.host}:${addr.port}`;
  const key = await call("POST", "/api/v1/secrets", {
    name: "k",
    kind: "ssh_key",
    value: sshd.privateKey,
  });
  const env = await call("POST", "/api/v1/environments", {
    name: "box",
    host: "127.0.0.1",
    port: sshd.port,
    username: sshd.user,
    secretId: key.body.id,
  });
  sshEnvId = env.body.id as string;
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await sshd?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test.skipIf(!hasSshd)("本机 → ssh：复制单个文件，内容一致", async () => {
  const src = path.join(root, "a.txt");
  writeFileSync(src, "from-local\n");
  const dst = path.join(root, "remote-a.txt");
  const job = await run(
    { env: "local", path: src },
    { env: sshEnvId, path: dst },
  );
  expect(job).toMatchObject({ state: "done", files: 1 });
  expect(readFileSync(dst, "utf8")).toBe("from-local\n");
});

test.skipIf(!hasSshd)("ssh → 本机：复制目录，递归内容一致", async () => {
  const srcDir = path.join(root, "tree");
  mkdirSync(path.join(srcDir, "sub"), { recursive: true });
  writeFileSync(path.join(srcDir, "x.txt"), "X");
  writeFileSync(path.join(srcDir, "sub", "y.txt"), "YY");
  const dstDir = path.join(root, "tree-back");
  const job = await run(
    { env: sshEnvId, path: srcDir },
    { env: "local", path: dstDir },
  );
  expect(job).toMatchObject({ state: "done", files: 2, bytes: 3 });
  expect(readFileSync(path.join(dstDir, "sub", "y.txt"), "utf8")).toBe("YY");
});

test.skipIf(!hasSshd)(
  "目标已存在：失败 conflict；overwrite=true 重发后成功",
  async () => {
    const src = path.join(root, "c.txt");
    const dst = path.join(root, "c-dst.txt");
    writeFileSync(src, "new");
    writeFileSync(dst, "old");
    const first = await run(
      { env: "local", path: src },
      { env: sshEnvId, path: dst },
    );
    expect(first.state).toBe("failed");
    expect(first.error?.code).toBe("conflict");
    expect(readFileSync(dst, "utf8")).toBe("old");

    const second = await run(
      { env: "local", path: src },
      { env: sshEnvId, path: dst },
      true,
    );
    expect(second.state).toBe("done");
    expect(readFileSync(dst, "utf8")).toBe("new");
  },
);

test.skipIf(!hasSshd)("源不存在：失败 src_missing，不留目标", async () => {
  const dst = path.join(root, "never.txt");
  const job = await run(
    { env: sshEnvId, path: path.join(root, "nope.txt") },
    { env: "local", path: dst },
  );
  expect(job.state).toBe("failed");
  expect(job.error?.code).toBe("src_missing");
  expect(existsSync(dst)).toBe(false);
});

test.skipIf(!hasSshd)("取消：未知任务 404，已结束的任务状态不变", async () => {
  expect((await call("DELETE", "/api/v1/transfer-jobs/nope")).status).toBe(404);
  const src = path.join(root, "d.txt");
  writeFileSync(src, "d");
  const job = await run(
    { env: "local", path: src },
    { env: sshEnvId, path: path.join(root, "d-dst.txt") },
  );
  expect(job.state).toBe("done");
  const r = await call("DELETE", `/api/v1/transfer-jobs/${job.id}`);
  expect(r.status).toBe(200);
  expect(r.body.state).toBe("done");
});
