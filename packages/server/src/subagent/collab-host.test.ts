// 协作区作为虚拟主机 collab 的接线：会话里可见的 collab 目录、子代理启动时建好的自己的子目录、
// 开场说明里的 collab 地址，以及远程目录上的子代理照样能用 collab 读整棵树。
import { existsSync } from "node:fs";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import { type StubReply, startStub } from "../../test/support/stub.js";
import {
  isChild,
  type Msg,
  subagentWorld,
  textOf,
  type World,
} from "../../test/support/subagents.js";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { EnvHub } from "../env/hub.js";
import { VirtualEnv } from "../env/virtual.js";
import { COLLAB_ENV_ID, EnvironmentStore } from "../store/environments.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";

const lastOf = (body: Record<string, unknown>) =>
  ((body.messages ?? []) as Msg[]).at(-1);
// 消息内容可能是块数组：拼出文本再比对（textOf 对数组会 JSON 序列化）
const blockText = (c: unknown): string =>
  Array.isArray(c)
    ? c.map((b: { text?: string }) => b?.text ?? "").join("")
    : textOf(c);
const textOfBody = (body: Record<string, unknown>, role: string) =>
  ((body.messages ?? []) as Msg[])
    .filter((m) => m.role === role)
    .map((m) => blockText(m.content))
    .join("\n");

const PARENT: { reply: (body: Record<string, unknown>) => StubReply } = {
  reply: () => "",
};
const CHILD: { reply: (body: Record<string, unknown>) => StubReply } = {
  reply: () => "",
};
const stub = await startStub((_n, body) =>
  isChild(body) ? CHILD.reply(body) : PARENT.reply(body),
);
afterAll(() => stub.close());

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0).reverse()) await w.close();
  stub.requests.length = 0;
  PARENT.reply = () => "";
  CHILD.reply = () => "";
});

function setup(o: Parameters<typeof subagentWorld>[1] = {}) {
  const w = subagentWorld(stub, o);
  worlds.push(w);
  return w;
}

const ended = (c: ReturnType<typeof collector>) => () =>
  c.types().includes("run.ended");

async function root(w: World) {
  const e = w.pool.get((await w.pool.create()).id);
  if (!e) throw new Error("no entry");
  const c = collector();
  e.subscribe(c);
  return { e, c };
}

const childRequests = () => stub.requests.filter((r) => isChild(r.body));

// 远程用例：ssh 主机的环境 id 与它自己的虚拟协作区环境（EnvHub 要它才认 collab 主机）
let remoteEnvId = "";
const collabEnv = new VirtualEnv(
  makeTmpDir("yuanshu-collab-host-"),
  COLLAB_ENV_ID,
);

describe("协作区在会话里的目录", () => {
  test("根会话没有子代理时不带 collab；派发之后带上，id 是 collab:<根会话>", async () => {
    const w = setup();
    const { e, c } = await root(w);
    const ids = () => w.pool.visibleDirectories(e.id).map((d) => d.id);
    expect(ids().some((id) => id.startsWith("collab:"))).toBe(false);

    PARENT.reply = (body) =>
      lastOf(body)?.role === "tool"
        ? "收尾"
        : { tool: "spawn_subagent", args: { task: "T" } };
    CHILD.reply = (body) =>
      lastOf(body)?.role === "tool"
        ? "done"
        : { tool: "deliver", args: { summary: "s" } };
    e.send("go");
    await waitFor(ended(c), "父运行结束", 20_000);

    const collab = w.pool
      .visibleDirectories(e.id)
      .find((d) => d.environmentId === COLLAB_ENV_ID);
    expect(collab).toMatchObject({
      id: `collab:${e.id}`,
      name: "collab",
      path: w.collab.treeDir(e.id),
    });
  });

  test("子会话一开始就带 collab，自己的子目录也已经建好", async () => {
    const w = setup();
    const { e, c } = await root(w);
    PARENT.reply = (body) =>
      lastOf(body)?.role === "tool"
        ? "收尾"
        : { tool: "spawn_subagent", args: { task: "T" } };
    e.send("go");
    await waitFor(ended(c), "父运行结束", 20_000);
    const childId = w.subagents.list()[0]?.childId as string;
    expect(w.pool.visibleDirectories(childId).map((d) => d.id)).toContain(
      `collab:${e.id}`,
    );
    expect(existsSync(w.collab.ownDir(e.id, childId))).toBe(true);
  });
});

describe("协作区对子代理是虚拟主机 collab", () => {
  test("远程目录上的子代理：开场说明给 collab 地址，list_directories 列出 collab，读整棵树不弹审批", async () => {
    // 一台只登记不连接的 ssh 主机：子代理在那上面的目录里工作
    const w = setup({
      builtinTools: true,
      deps: (data) => {
        const environments = new EnvironmentStore(data.db);
        const rec = environments.create({
          name: "dev1",
          host: "10.0.0.9",
          port: 22,
          username: "dev",
          os: "posix",
          secretId: null,
        });
        remoteEnvId = rec?.id ?? "";
        const hub = new EnvHub(
          environments,
          new SecretStore(data.db, loadMasterKey(data.dir)),
          undefined,
          undefined,
          undefined,
          collabEnv,
        );
        return { environments, envHub: hub };
      },
    });
    const remote = remoteEnvId
      ? w.data.directories.create(
          "train",
          "/data/train",
          new Date(),
          remoteEnvId,
        )
      : undefined;
    if (!remote) throw new Error("远程目录没建成");
    const { e, c } = await root(w);
    // 远程目录要进会话的工作区清单，地址簿里才有 dev1
    const wsId = w.pool.workspaceIdOf(e.id) as string;
    const local = w.data.directories.getDefault();
    if (!local) throw new Error("no local dir");
    await w.pool.setWorkspaceDirectories(wsId, [local.id, remote.id]);
    // 别的成员写在树里的东西：子代理要读得到
    w.collab.writeReport(e.id, "sibling", "SIBLING-REPORT");
    PARENT.reply = (body) =>
      lastOf(body)?.role === "tool"
        ? "收尾"
        : {
            tool: "spawn_subagent",
            args: { task: "T", directory: `dev1:${remote.name}` },
          };
    CHILD.reply = (body) => {
      const results = (body.messages ?? []) as Msg[];
      const seen = results.filter((m) => m.role === "tool").length;
      if (seen === 0) return { tool: "list_directories", args: {} };
      if (seen === 1)
        return {
          tool: "read",
          args: { host: "collab", path: "/sibling/report.md" },
        };
      return "done";
    };
    e.send("go");
    await waitFor(ended(c), "父运行结束", 20_000);

    const childId = w.subagents.list()[0]?.childId as string;
    const brief = textOfBody(childRequests()[0]?.body ?? {}, "user");
    // 起始目录在 ssh 上，collab 说明照样给，写的是虚拟主机里的自己的路径
    expect(brief).toContain("You work in the directory dev1:train");
    expect(brief).toContain("- Shared folder: the virtual host collab.");
    expect(brief).toContain(`write files under /${childId}/`);
    // list_directories 里有 collab 行
    const listed = textOfBody(childRequests().at(-1)?.body ?? {}, "tool");
    expect(listed).toContain("collab: the shared folder of this session tree");
    // 读别的成员的报告成功，且整趟没有审批弹窗
    expect(listed).toContain("SIBLING-REPORT");
    const approvals = c.frames.filter(
      (f) =>
        f.type === "prompt.requested" &&
        (f.data as { source?: string }).source === "approval",
    );
    expect(approvals).toHaveLength(0);
    expect(w.subagents.list()[0]?.denied).toBe(0);
  });

  test("开场说明里没有 Server 的真实路径（协作区只以 collab 出现）", async () => {
    const w = setup();
    const { e, c } = await root(w);
    PARENT.reply = (body) =>
      lastOf(body)?.role === "tool"
        ? "收尾"
        : { tool: "spawn_subagent", args: { task: "T" } };
    e.send("go");
    await waitFor(ended(c), "父运行结束", 20_000);
    const brief = textOfBody(childRequests()[0]?.body ?? {}, "user");
    expect(brief).not.toContain(w.collab.treeDir(e.id));
    expect(brief).toContain('host="collab"');
  });

  test("子代理不写自己那份以外的东西：写树根被拒，没有审批通道", async () => {
    const w = setup({ builtinTools: true });
    const { e, c } = await root(w);
    PARENT.reply = (body) =>
      lastOf(body)?.role === "tool"
        ? "收尾"
        : { tool: "spawn_subagent", args: { task: "T" } };
    CHILD.reply = (body) =>
      (body.messages as Msg[]).some((m) => m.role === "tool")
        ? "denied"
        : {
            tool: "write",
            args: { host: "collab", path: "/board.md", content: "x" },
          };
    e.send("go");
    await waitFor(ended(c), "父运行结束", 20_000);
    expect(existsSync(w.collab.boardPath(e.id))).toBe(false);
    expect(w.subagents.list()[0]?.denied).toBe(1);
    const result = textOfBody(childRequests().at(-1)?.body ?? {}, "tool");
    expect(result).toContain(
      "That path in the collab host is not yours to change.",
    );
  }, 20_000);
});
