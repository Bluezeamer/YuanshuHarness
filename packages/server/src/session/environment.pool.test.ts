// 「环境信息」段进真实会话：系统提示词里有它；主机被用户断开 / 目录被移除后，下一次运行带状态通知。
// 真实会话池 + 真实会话工厂 + OpenAI 兼容 stub；ssh 主机只登记、不真连（远程目录不做本机预检）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testData,
  testPool,
  testPresets,
} from "../../test/support/stub.js";
import { EnvHub } from "../env/hub.js";
import { EnvironmentStore } from "../store/environments.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import type { SessionPool } from "./pool.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let base = "";
let pool: SessionPool | undefined;
let data: TestData | undefined;

afterEach(() => {
  pool?.dispose();
  pool = undefined;
  data?.close();
  data = undefined;
  stub.requests.length = 0;
  if (base) rmSync(base, { recursive: true, force: true });
  base = "";
});

function boot() {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-envsection-"));
  const d = testData(path.join(base, "data"));
  const environments = new EnvironmentStore(d.db);
  const hub = new EnvHub(
    environments,
    new SecretStore(d.db, loadMasterKey(d.dir)),
  );
  const presets = testPresets(d);
  const t = testPool(stubSessionFactory(stub), d, {
    presetView: presets.view,
    modeView: presets.modeView,
    envHub: hub,
    environments,
  });
  pool = t.pool;
  data = d;
  const main = path.join(base, "main");
  mkdirSync(main, { recursive: true });
  const local = d.directories.create("main", main);
  const env = environments.create({
    name: "gpu-box",
    host: "10.0.0.9",
    port: 22,
    username: "dev",
    os: "posix",
    secretId: null,
  });
  if (!local || !env) throw new Error("夹具没建成");
  const remote = d.directories.create("api", "/srv/api", new Date(), env.id);
  if (!remote) throw new Error("远程目录没建成");
  return { hub, envId: env.id, local, remote, db: d, pool: t.pool };
}

async function run(p: SessionPool, id: string) {
  const e = p.get(id);
  if (!e) throw new Error("会话不在池里");
  const c = collector();
  e.subscribe(c);
  e.send("go");
  await waitFor(() => c.types().includes("run.ended"), "run.ended");
}

// 请求里带着整段历史，旧通知一直在：按出现次数判断「这一轮有没有新通知」
const changes = () =>
  (lastBody().match(/Prompt section <environment> changed/g) ?? []).length;

const lastBody = () => {
  const last = stub.requests.at(-1);
  if (!last) throw new Error("桩没收到请求");
  return JSON.stringify((last.body as { messages: unknown[] }).messages);
};

test("系统提示词里有环境信息：创建时间、本机与远程主机的系统事实", async () => {
  const w = boot();
  w.hub.setFacts(w.envId, "Linux 6.5.0-27-generic · x86_64");
  const s = await w.pool.create({ directoryIds: [w.local.id, w.remote.id] });
  if (!s) throw new Error("会话没建成");
  await run(w.pool, s.id);
  const sys = lastBody();
  expect(sys).toContain("<environment>");
  expect(sys).toContain("Session started: ");
  expect(sys).toContain("Hosts in this session, with their directories.");
  expect(sys).toMatch(/- \\"local\\": \S+ \S+, \S+/);
  expect(sys).toContain('- \\"gpu-box\\": Linux 6.5.0-27-generic, x86_64');
  // 目录列在各自的主机下，写成引用形式
  expect(sys).toContain(`  - local:${w.local.name}  ${w.local.path}`);
  expect(sys).toContain(`  - gpu-box:${w.remote.name}  ${w.remote.path}`);
  // <cwd> 是主目录的引用，不是裸路径
  expect(sys).toContain(
    `\\n<cwd>\\nThe session starts in its main directory local:${w.local.name} (${w.local.path})`,
  );
});

test("用户断开主机：下一次运行带差异通知；重新激活又通知一次；中间没变就不重复", async () => {
  const w = boot();
  w.hub.setFacts(w.envId, "Linux 6.5.0-27-generic · x86_64");
  const s = await w.pool.create({ directoryIds: [w.local.id, w.remote.id] });
  if (!s) throw new Error("会话没建成");
  await run(w.pool, s.id);
  await run(w.pool, s.id);
  expect(changes()).toBe(0);

  w.hub.pause(w.envId);
  await run(w.pool, s.id);
  expect(changes()).toBe(1);
  expect(lastBody()).toContain("DISCONNECTED by the user");
  expect(lastBody()).toContain("Settings → Remote connections");

  await run(w.pool, s.id);
  expect(changes()).toBe(1);

  // 重新激活要重新探测：开始时丢掉旧事实，免得写进过期的系统信息
  w.hub.prepareActivation(w.envId);
  expect(w.hub.factsOf(w.envId)).toBeNull();
  w.hub.setFacts(w.envId, "Linux 6.5.0-27-generic · x86_64");
  await run(w.pool, s.id);
  expect(changes()).toBe(2);
});

test("没探测到系统的主机写「system not detected yet」，探测到之后补发通知", async () => {
  const w = boot();
  const s = await w.pool.create({ directoryIds: [w.local.id, w.remote.id] });
  if (!s) throw new Error("会话没建成");
  await run(w.pool, s.id);
  expect(lastBody()).toContain("system not detected yet");

  w.hub.setFacts(w.envId, "Linux 6.5.0-27-generic · x86_64");
  await run(w.pool, s.id);
  expect(changes()).toBe(1);
  expect(lastBody()).toContain("Linux 6.5.0-27-generic, x86_64");
});
