// bash 的 host：工作目录、档位、规则、「记住」与 sudo 探测都按命令实际所在的那个目录判；
// 不给 host 就还是当前目录（行为与原来一致）。解析失败（裸主机、不在清单里的目录、附件区、
// 写成文件地址）与文件工具一样直接把原文给模型，不弹卡片。
// 直接驱动权限扩展的 tool_call 处理器；目录解析用真的地址簿（session/address），判定上下文用测试夹具。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv } from "../env/types.js";
import { createAddressBook } from "../session/address.js";
import type { PromptSpec } from "../session/prompts.js";
import type { Directory } from "../store/directories.js";
import { COLLAB_ENV_ID, LOCAL_ENV_ID } from "../store/environments.js";
import type { VariableMeta } from "../store/secrets.js";
import type { RememberRule } from "./decide.js";
import {
  type DirectoryCtx,
  type Located,
  permissionExtension,
} from "./extension.js";
import type { PathEnv } from "./paths.js";
import type { Tier } from "./tier.js";

let root = "";
let A = "";
let B = "";
let OUT = "";
beforeAll(() => {
  root = makeTmpDir("yuanshu-hostdir-");
  [A, B, OUT] = ["a", "b", "out"].map((d) => path.join(root, d)) as [
    string,
    string,
    string,
  ];
  for (const d of [A, B, OUT]) mkdirSync(d);
});

const localEnv = new LocalEnv();
// 同一台物理机上的「另一台主机」：路径方言与访问方式同本机，只是 id / kind 不同。
const devEnv = new Proxy(new LocalEnv(), {
  get: (t, k) =>
    k === "id" ? "e1" : k === "kind" ? "ssh" : Reflect.get(t, k, t),
}) as unknown as PathEnv;

const dir = (
  id: string,
  name: string,
  p: string,
  envId = LOCAL_ENV_ID,
): Directory => ({ id, name, path: p, environmentId: envId, createdAt: "t" });
const PROJ = () => dir("d-a", "A", A);
const DOCS = () => dir("d-b", "B", B);
const DEV = () => dir("d-dev", "train", OUT, "e1");

const meta = (over: Partial<VariableMeta> = {}): VariableMeta => ({
  id: "v1",
  name: "tok",
  purpose: "",
  scopeKind: "any",
  scopeTarget: null,
  tier: "rules",
  maskable: true,
  createdAt: "2026-10-20T00:00:00Z",
  group: null,
  policy: "allow",
  expiry: { kind: "never" },
  rotatedAt: null,
  ...over,
});

interface Opts {
  /** 目录各自的档位：缺省都是 rules。 */
  tierA?: Tier;
  tierDev?: Tier;
  /** 目录各自的命令规则。 */
  commandsB?: string[];
  unattended?: boolean;
  answer?: "allow" | "deny" | "remember";
  vars?: VariableMeta[];
}

function harness(o: Opts = {}) {
  const added: Record<string, RememberRule[]> = {
    "d-a": [],
    "d-b": [],
    "d-dev": [],
  };
  const envOf = (d: Directory): PathEnv =>
    d.environmentId === "e1" ? devEnv : (localEnv as unknown as PathEnv);
  const ctxOf = (d: Directory): DirectoryCtx => ({
    id: d.id,
    name: d.name,
    ref:
      d.environmentId === "e1"
        ? `dev1:${d.name}`
        : d.environmentId === COLLAB_ENV_ID
          ? `collab:${d.name}`
          : `local:${d.name}`,
    where: { env: envOf(d), cwd: d.path },
    tier:
      d.id === "d-dev"
        ? (o.tierDev ?? "rules")
        : d.id === "d-a"
          ? (o.tierA ?? "rules")
          : "rules",
    rules: {
      path: [],
      command: d.id === "d-b" ? (o.commandsB ?? []) : [],
    },
    addRule: (r) => added[d.id]?.push(r),
  });
  const dirs = [PROJ(), DOCS(), DEV()];
  const book = createAddressBook({
    directories: () => dirs,
    primaryEnvId: () => LOCAL_ENV_ID,
    current: () => PROJ(),
    envOf: (d) => envOf(d) as unknown as ExecEnv,
    connectionName: (id) => (id === "e1" ? "dev1" : undefined),
  });
  const locate = async (
    hostName: string | undefined,
    p: string | undefined,
  ): Promise<Located> => {
    const at = await book.locate(hostName, p);
    return {
      host: at.host,
      shown: at.shown,
      env: at.env,
      path: at.path,
      ctx: ctxOf(at.directory),
    };
  };
  const asked: PromptSpec[] = [];
  const audits: Array<{ summary: string; environmentId?: string }> = [];
  const refs: Array<{ directoryId: string; hostId: string }> = [];
  const probes: Array<{ envId: string; cwd: string; args: string[] }> = [];
  const invalidated: string[] = [];
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  permissionExtension({
    // 命令类按地址簿的目录解析（与执行时同一个解析）；文件类按地址判归属。
    directoryCtx: async (ref) => ctxOf(book.directory(ref ?? "local:A")),
    locate,
    tier: () => "rules",
    ask: async (spec) => {
      asked.push(spec);
      return { outcome: "answered", optionId: o.answer ?? "allow" };
    },
    audit: (rec) => audits.push(rec as never),
    variables: () => o.vars ?? [],
    references: { record: (rec) => refs.push(rec) },
    sudo: {
      probe: async (env, cwd, args) => {
        probes.push({ envId: env.id, cwd, args });
        return "nopasswd";
      },
      invalidate: (envId) => invalidated.push(envId),
    },
    ...(o.unattended ? { unattended: true } : {}),
  })({
    on: (_n: string, h: (e: unknown) => Promise<unknown>) => {
      handler = h;
    },
  } as never);
  return {
    added,
    asked,
    audits,
    refs,
    probes,
    invalidated,
    run: (input: Record<string, unknown>) =>
      handler?.({ toolName: "bash", toolCallId: "t1", input }) as Promise<
        { block?: boolean; reason?: string } | undefined
      >,
  };
}

describe("命令按目标目录的档位、规则与 cwd 判", () => {
  test("不给 host：还是当前目录（A），A 内只读直放、A 外写要审批", async () => {
    const h = harness();
    expect(await h.run({ command: "ls" })).toBeUndefined();
    expect(h.asked).toEqual([]);
    await h.run({ command: `touch ${path.join(OUT, "x")}` });
    expect(h.asked).toHaveLength(1);
  });

  test("目标目录（B）内的只读命令：按 B 的 cwd 判为目录内，直放；同一条命令在当前目录 A 是目录外，要审批", async () => {
    writeFileSync(path.join(B, "f.txt"), "x");
    const h = harness();
    expect(
      await h.run({ host: "local:B", command: `cat ${path.join(B, "f.txt")}` }),
    ).toBeUndefined();
    expect(h.asked).toEqual([]);
    await h.run({ command: `cat ${path.join(B, "f.txt")}` });
    expect(h.asked).toHaveLength(1);
  });

  test("目标目录之外的写：按目标目录判为目录外，要审批", async () => {
    const h = harness();
    await h.run({ host: "local:B", command: `touch ${path.join(OUT, "n")}` });
    expect(h.asked).toHaveLength(1);
  });

  test("目标目录上已记住的命令：在那条命令里直放，当前目录上不生效", async () => {
    const hit = harness({ commandsB: ["mkdir n"] });
    expect(
      await hit.run({ host: "local:B", command: "mkdir n" }),
    ).toBeUndefined();
    expect(hit.asked).toEqual([]);
    // 同样一条命令在当前目录 A：没有这条规则，照旧弹窗
    await hit.run({ command: "mkdir n" });
    expect(hit.asked).toHaveLength(1);
  });

  test("「记住」落在目标目录，不落在会话当前目录", async () => {
    const h = harness({ answer: "remember" });
    await h.run({ host: "local:B", command: "mkdir newdir" });
    expect(h.added["d-b"]).toHaveLength(1);
    expect(h.added["d-a"]).toEqual([]);
  });

  test("档位按目标目录：当前目录 full、目标目录 rules 时仍按 rules 判", async () => {
    const h = harness({ tierA: "full" });
    await h.run({ host: "local:B", command: "mkdir newdir" });
    expect(h.asked).toHaveLength(1);
  });

  test("档位按目标目录：目标目录 full 时不弹窗（当前目录是 rules）", async () => {
    const h = harness({ tierDev: "full" });
    expect(
      await h.run({ host: "dev1:train", command: "rm -rf build" }),
    ).toBeUndefined();
    expect(h.asked).toEqual([]);
  });

  test("auto 档：送自动审核，审核放行就不弹窗", async () => {
    const reviewed: string[] = [];
    const asked: PromptSpec[] = [];
    let handler: ((e: unknown) => Promise<unknown>) | undefined;
    const ctx: DirectoryCtx = {
      id: "d-b",
      name: "B",
      ref: "local:B",
      where: { env: localEnv as unknown as PathEnv, cwd: B },
      tier: "auto",
      rules: { path: [], command: [] },
      addRule: () => {},
    };
    permissionExtension({
      directoryCtx: async (ref) => {
        if (ref !== "local:B") throw new Error('Directory "x" not found.');
        return ctx;
      },
      locate: async () => {
        throw new Error("not used");
      },
      tier: () => "rules",
      review: async (call) => {
        reviewed.push(call.summary);
        return { decision: "allow" };
      },
      ask: async (spec) => {
        asked.push(spec);
        return { outcome: "answered", optionId: "allow" };
      },
    })({
      on: (_n: string, h: (e: unknown) => Promise<unknown>) => {
        handler = h;
      },
    } as never);
    const run = (input: Record<string, unknown>) =>
      handler?.({ toolName: "bash", toolCallId: "t1", input }) as Promise<
        { block?: boolean; reason?: string } | undefined
      >;
    expect(await run({ host: "local:B", command: "mkdir n" })).toBeUndefined();
    expect(reviewed).toHaveLength(1);
    expect(asked).toEqual([]);
  });
});

describe("无人值守（子会话）", () => {
  test("需要人工的命令按目标目录拒绝，不产生规则，审计记目标环境", async () => {
    const h = harness({ unattended: true, answer: "remember" });
    const r = await h.run({ host: "dev1:train", command: "mkdir n" });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain("没有人工审批通道");
    expect(h.added["d-dev"]).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(h.audits.at(-1)).toMatchObject({
      environmentId: "e1",
      summary: "deny bash: mkdir n",
    });
  });

  test("交互式命令的探测按目标环境：需要密码的 sudo 在目标主机上被判为无人值守拒绝", async () => {
    const asked: PromptSpec[] = [];
    const probes: Array<{ envId: string; cwd: string }> = [];
    const audits: Array<{ environmentId?: string }> = [];
    let handler: ((e: unknown) => Promise<unknown>) | undefined;
    const ctx: DirectoryCtx = {
      id: "d-dev",
      name: "train",
      ref: "dev1:train",
      where: { env: devEnv as unknown as PathEnv, cwd: OUT },
      tier: "rules",
      rules: { path: [], command: [] },
      addRule: () => {},
    };
    permissionExtension({
      directoryCtx: async () => ctx,
      locate: async () => {
        throw new Error("not used");
      },
      tier: () => "rules",
      unattended: true,
      sudo: {
        probe: async (env, cwd) => {
          probes.push({ envId: env.id, cwd });
          return "password";
        },
        invalidate: () => {},
      },
      ask: async (spec) => {
        asked.push(spec);
        return { outcome: "answered", optionId: "allow" };
      },
      audit: (rec) => audits.push(rec as never),
    })({
      on: (_n: string, h: (e: unknown) => Promise<unknown>) => {
        handler = h;
      },
    } as never);
    const r = (await handler?.({
      toolName: "bash",
      toolCallId: "t1",
      input: { host: "dev1:train", command: "sudo apt update" },
    })) as { block?: boolean; reason?: string } | undefined;
    expect(r).toMatchObject({ block: true });
    expect(probes).toEqual([{ envId: "e1", cwd: OUT }]);
    expect(asked).toEqual([]);
    expect(audits.at(-1)?.environmentId).toBe("e1");
  });
});

describe("解析失败：不弹卡片，原文给模型，记一条 deny 审计", () => {
  test.each([
    // 裸主机也按「目录要写成 <host>:<name>」拒
    ["dev1", "A directory is written <host>:<name>"],
    ["local:nope", 'Directory "local:nope" not found'],
    ["dev1:/x", 'Directory "dev1:/x" not found'],
    ["attachment", "A directory is written <host>:<name>"],
  ])("host=%s：拒绝并给原文", async (hostName, why) => {
    const h = harness();
    const r = await h.run({ host: hostName, command: "ls" });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain(why);
    expect(h.asked).toEqual([]);
    expect(h.audits.at(-1)?.summary).toContain("deny bash");
    expect(h.audits.at(-1)?.environmentId).toBeUndefined();
  });
});

describe("审批卡片", () => {
  test("显式给了 host：卡片写明运行位置（引用与 cwd）", async () => {
    const h = harness();
    await h.run({ host: "local:B", command: "mkdir deep/nested" });
    expect(h.asked[0]?.body).toContain(`运行位置：local:B（${B}）`);
  });

  test("不给 host：卡片里没有运行位置一行（与原来一致）", async () => {
    const h = harness();
    await h.run({ command: "mkdir deep" });
    expect(h.asked[0]?.body).not.toContain("运行位置");
  });
});

describe("sudo 探测与作废按目标环境", () => {
  test("目标在 dev1：探测与 invalidate 都用 dev1 的环境与 cwd", async () => {
    const h = harness();
    expect(
      await h.run({ host: "dev1:train", command: "sudo ls" }),
    ).toBeUndefined();
    expect(h.probes).toEqual([{ envId: "e1", cwd: OUT, args: ["ls"] }]);
    expect(h.invalidated).toEqual(["e1"]);
  });

  test("目标目录 full：sudo 命令不弹窗放行，作废的也是目标环境", async () => {
    const h = harness({ tierDev: "full" });
    expect(
      await h.run({ host: "dev1:train", command: "sudo ls" }),
    ).toBeUndefined();
    expect(h.asked).toEqual([]);
    expect(h.invalidated).toEqual(["e1"]);
  });

  test("不给 host：用当前目录的环境", async () => {
    const h = harness();
    await h.run({ command: "sudo ls" });
    expect(h.probes[0]?.envId).toBe(LOCAL_ENV_ID);
    expect(h.invalidated).toEqual([LOCAL_ENV_ID]);
  });
});

describe("审计与引用记录的落点", () => {
  test("审计的 environmentId 是命令实际所在的环境", async () => {
    const h = harness({ answer: "allow" });
    await h.run({ host: "dev1:train", command: "mkdir n" });
    expect(h.audits.at(-1)?.environmentId).toBe("e1");
    const here = harness();
    await here.run({ command: "ls" });
    expect(here.audits).toEqual([]);
  });

  test("隐私变量引用记在目标目录与目标主机上", async () => {
    const h = harness({ vars: [meta()] });
    await h.run({
      host: "dev1:train",
      command: "mkdir n; echo {{@tok}}",
    });
    expect(h.refs).toMatchObject([{ directoryId: "d-dev", hostId: "e1" }]);
  });
});
