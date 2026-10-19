import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { startStub, stubSessionFactory } from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { type Deps, execute } from "../cli.js";
import { createServer, type YuanshuServer } from "../server.js";

// 第一次请求调用 ask_user，工具结果回来后回一句话。
const stub = await startStub((n, body) => {
  const msgs = (body.messages ?? []) as Array<{
    role: string;
    content?: unknown;
  }>;
  const last = msgs[msgs.length - 1];
  if (last?.role === "tool") return `答复=${String(last.content)}`;
  return n === 1
    ? {
        tool: "ask_user",
        args: { question: "选哪个？", options: ["甲", "乙"] },
      }
    : "x";
});
afterAll(() => stub.close());

let base: string;
const running: YuanshuServer[] = [];
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-cliprompt-"));
  await mkdir(path.join(base, "web"));
  await writeFile(path.join(base, "web", "index.html"), "<title>x</title>");
});
afterEach(async () => {
  stub.requests.length = 0;
  for (const s of running.splice(0)) await s.stop();
  await rm(base, { recursive: true, force: true });
});

async function boot() {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  const server = createServer(
    { host: "127.0.0.1", port, dataDir: path.join(base, "d"), allowCidrs: [] },
    {
      webRoot: path.join(base, "web"),
      logStream: { write: () => {} },
      sessionFactory: stubSessionFactory(stub),
      startDir: base,
    },
  );
  running.push(server);
  await server.start();
  return { url: `http://127.0.0.1:${port}` };
}

test("R2 两个连接并发 answer_prompt：一个成功一个 prompt_resolved；未知/缺参失败", async () => {
  const { url } = await boot();
  const id = (
    (await await fetch(`${url}/api/v1/sessions`, { method: "POST" }).then((r) =>
      r.json(),
    )) as { id: string }
  ).id;
  const ws = url.replace("http", "ws");
  const a = await TestClient.connect(`${ws}/api/v1/sessions/${id}/stream`);
  const b = await TestClient.connect(`${ws}/api/v1/sessions/${id}/stream`);
  await a.command("send_message", { text: "开始" });
  await waitFor(() => b.types().includes("prompt.requested"), "requested");
  const promptId = b.frames.find((f) => f.type === "prompt.requested")?.data
    .promptId as string;
  expect((await a.command("answer_prompt", {})).error?.code).toBe(
    "bad_request",
  );
  expect(
    (await a.command("answer_prompt", { promptId: "nope", optionId: "0" }))
      .error?.code,
  ).toBe("prompt_unknown");
  expect(
    (await a.command("answer_prompt", { promptId, optionId: "zzz" })).error
      ?.code,
  ).toBe("bad_request");
  const [r1, r2] = await Promise.all([
    a.command("answer_prompt", { promptId, optionId: "0" }),
    b.command("answer_prompt", { promptId, optionId: "1" }),
  ]);
  expect([r1.ok, r2.ok].sort()).toEqual([false, true]);
  expect([r1, r2].find((r) => !r.ok)?.error?.code).toBe("prompt_resolved");
  a.close();
  b.close();
});

test("R10 attach 显示提问与编号选项，/answer 2 作答后运行继续", async () => {
  const { url } = await boot();

  const out: string[] = [];
  const err: string[] = [];
  const stdin = new PassThrough();
  const mk = (): Deps => ({
    env: { YUANSHU_URL: url },
    home: base,
    cwd: base,
    stdin,
    stdout: { write: (s) => void out.push(s) },
    stderr: { write: (s) => void err.push(s) },
    signal: new AbortController().signal,
  });
  expect(await execute(["new"], mk())).toBe(0);
  const id = out.join("").trim();
  out.length = 0;

  const done = execute(["attach", id], mk());
  stdin.write("开始\n");
  await waitFor(() => out.join("").includes("2. 乙"), "显示选项");
  expect(out.join("")).toContain("[提问] 选哪个？");
  stdin.write("/answer 9\n");
  await waitFor(() => err.join("").includes("编号无效"), "无效编号");
  stdin.write("/answer 2\n");
  await waitFor(() => out.join("").includes("答复=乙"), "运行继续");
  stdin.end();
  expect(await done).toBe(0);
});
