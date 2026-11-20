// 跨主机判定：文件工具的目标按它归属的已登记目录判（档位、规则、敏感名、画布保护都在那一端）。
// 直接驱动权限扩展的 tool_call 处理器；locate 用真的地址簿（session/address），只是把判定上下文换成测试夹具。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv } from "../env/types.js";
import { VirtualEnv } from "../env/virtual.js";
import { createAddressBook } from "../session/address.js";
import type { PromptResult, PromptSpec } from "../session/prompts.js";
import type { Directory } from "../store/directories.js";
import { COLLAB_ENV_ID, LOCAL_ENV_ID } from "../store/environments.js";
import { CollabArea } from "../subagent/collab.js";
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
// 协作区：一棵树的根（虚拟主机 collab 的 /）
let TREE = "";
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "yuanshu-addrgate-"));
  [A, B, OUT] = ["a", "b", "out"].map((d) => path.join(root, d)) as [
    string,
    string,
    string,
  ];
  for (const d of [A, B, OUT]) mkdirSync(d);
  writeFileSync(path.join(A, "a.txt"), "x");
  writeFileSync(path.join(OUT, "o.txt"), "x");
  TREE = path.join(root, "collab", "r1");
  for (const id of ["c1", "c2"])
    mkdirSync(path.join(TREE, id), {
      recursive: true,
    });
  writeFileSync(path.join(TREE, "c1", "report.md"), "report");
  writeFileSync(path.join(TREE, "c2", "other.md"), "other");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const localEnv = new LocalEnv();
// 同一台物理机上的「另一台主机」：路径方言走 posix，id 不是 local。
const dev1 = new Proxy(new LocalEnv(), {
  get: (t, k) =>
    k === "id" ? "e1" : k === "kind" ? "ssh" : Reflect.get(t, k, t),
}) as unknown as PathEnv;

const d = (
  id: string,
  name: string,
  p: string,
  env = LOCAL_ENV_ID,
): Directory => ({
  id,
  name,
  path: p,
  environmentId: env,
  createdAt: "t",
});
// 目录在 beforeAll 里定（那时临时目录才存在）；这里按路径现取。
const PROJ = () => d("d-a", "A", A);
const DOCS = () => d("d-b", "B", B);
const DEV = () => d("d-dev", "train", OUT, "e1");
const COLLAB = () => d("d-collab", "collab", TREE, COLLAB_ENV_ID);
const all = () => [PROJ(), DOCS(), DEV()];

/** 协作区的读写判定：真的 CollabArea（rootId = r1），子代理 id 为 selfId。 */
const collabAllows = (
  selfId: string | null,
  canEditBoard = false,
): ((access: "read" | "write", p: string) => boolean) => {
  const area = new CollabArea(path.dirname(TREE), () => canEditBoard);
  // 把测试里现造的树当成它的根（CollabArea 的 base 是 r1 的父目录，rootId = r1）
  return (access, p) => area.allows("r1", selfId, access, p);
};

interface Opts {
  tier?: Tier;
  rules?: { path: { access: "read" | "write"; value: string }[] };
  unattended?: boolean;
  added?: RememberRule[];
  /** 「记住」落在哪些 directory（按 id）。 */
  addedTo?: string[];
  answer?: PromptResult;
  dirs?: Directory[];
  currentId?: string;
  /** 协作区的读写判定（缺省：没有协作区）。 */
  collab?: (access: "read" | "write", p: string) => boolean;
}

// 附件区环境按目录路径现造（VirtualEnv 的根就是附件目录）。
const attach = { envs: {} as Record<string, unknown> };

function harness(o: Opts = {}) {
  const called: string[] = [];
  // 归属目录的环境与池的 envOf 同源：虚拟主机是 VirtualEnv，ssh 是可用的那条。
  const envOf = (dir: Directory): PathEnv => {
    if (dir.environmentId === "e1") return dev1;
    if (dir.environmentId === LOCAL_ENV_ID)
      return localEnv as unknown as PathEnv;
    const existing = attach.envs[dir.path];
    if (existing) return existing as unknown as PathEnv;
    const made = new VirtualEnv(
      dir.path,
      dir.environmentId,
    ) as unknown as PathEnv;
    attach.envs[dir.path] = made;
    return made;
  };
  const ctxOf = (dir: Directory): DirectoryCtx => ({
    id: dir.id,
    name: dir.name,
    ref: `${dir.environmentId === "e1" ? "dev1" : "local"}:${dir.name}`,
    where: {
      env: envOf(dir),
      cwd: dir.path,
    },
    tier: o.tier ?? "rules",
    rules: { path: o.rules?.path ?? [], command: [] },
    addRule: (r) => {
      o.addedTo?.push(dir.id);
      o.added?.push(r);
    },
  });
  const dirs = o.dirs ?? all();
  const current = dirs.find((x) => x.id === (o.currentId ?? "d-a")) ?? PROJ();
  const book = createAddressBook({
    directories: () => dirs,
    primaryEnvId: () => "local",
    current: () => current,
    envOf: (dir) => envOf(dir) as unknown as ExecEnv,
    connectionName: (id) => (id === "e1" ? "dev1" : undefined),
  });
  const locate = async (
    host: string | undefined,
    path: string | undefined,
  ): Promise<Located> => {
    const at = await book.locate(host, path);
    return {
      host: at.host,
      shown: at.shown,
      env: at.env,
      path: at.path,
      ctx: ctxOf(at.directory),
    };
  };
  const asked: PromptSpec[] = [];
  const audits: Array<{ detail: Record<string, unknown> }> = [];
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  permissionExtension({
    // 命令类走地址簿的目录（与执行时同一个解析）：裸主机、不在清单里的目录同样经它报错；
    // 不给参数就是会话当前目录。
    directoryCtx: async (hostName) =>
      ctxOf(
        hostName === undefined || hostName.trim() === ""
          ? current
          : book.directory(hostName),
      ),
    tier: () => o.tier ?? "rules",
    locate,
    ask: async (spec) => {
      asked.push(spec);
      return o.answer ?? { outcome: "answered", optionId: "allow" };
    },
    audit: (rec) => audits.push(rec),
    ...(o.unattended ? { unattended: true } : {}),
    ...(o.collab ? { collab: { allows: o.collab } } : {}),
  })({
    on: (_n: string, h: (e: unknown) => Promise<unknown>) => {
      handler = h as never;
    },
  } as never);
  return {
    asked,
    audits,
    locate: (host: string | undefined, path: string | undefined) => {
      called.push(`${host ?? ""}${path ?? ""}`);
      return locate(host, path);
    },
    run: (tool: string, input: Record<string, unknown>) =>
      handler?.({ toolName: tool, toolCallId: "t1", input }) as Promise<
        { block?: boolean; reason?: string } | undefined
      >,
  };
}

const X = (...p: string[]) => path.join(...p);

describe("目标地址按它归属的目录判", () => {
  test("local 主机、当前目录内：直接放行", async () => {
    const h = harness();
    expect(await h.run("read", { path: "a.txt" })).toBeUndefined();
    expect(
      await h.run("read", { host: "local", path: X(A, "a.txt") }),
    ).toBeUndefined();
    expect(h.asked).toEqual([]);
  });

  test("另一台主机（dev1）上的目录外路径：按 dev1 的目录判为目录外，要审批", async () => {
    const h = harness();
    await h.run("read", { host: "dev1", path: "/etc/hosts" });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.detail).toMatchObject({
      tool: "read",
      summary: "dev1:/etc/hosts",
    });
  });

  test("跨目录读比当前目录判得更松：另一目录的 cwd 内直接放行", async () => {
    const h = harness();
    // B 不是当前目录，但它是已登记目录，路径在它之内
    expect(
      await h.run("read", { host: "local:B", path: X(B, "notes.txt") }),
    ).toBeUndefined();
    expect(h.asked).toEqual([]);
  });

  test("「记住」写进归属目录，而不是会话当前目录", async () => {
    const added: RememberRule[] = [];
    const addedTo: string[] = [];
    const h = harness({
      added,
      addedTo,
      answer: { outcome: "answered", optionId: "remember" },
    });
    // 点名 dev1 上的 train（它的 cwd 是 OUT），路径落在目录之外：归属仍是它，规则记在它上面
    await h.run("write", {
      host: "dev1:train",
      path: "/var/elsewhere/n.txt",
      content: "x",
    });
    expect(addedTo).toEqual(["d-dev"]);
    expect(added).toHaveLength(1);
  });

  test("附件区的文件直接放行，不看档位与敏感文件名", async () => {
    const attachRoot = path.join(root, "att");
    mkdirSync(attachRoot, { recursive: true });
    const att = d("d-att", "attachment", attachRoot, "attachment");
    const h = harness({ dirs: [PROJ(), att] });
    for (const p of ["/2026-11-16/x.png", "/.env"]) {
      const r = await h.run("read", { host: "attachment", path: p });
      expect(r).toBeUndefined();
    }
    expect(h.asked).toEqual([]);
  });

  test("附件区越界：在 locate 处就拒绝，不弹卡片", async () => {
    const attachRoot = path.join(root, "att");
    mkdirSync(attachRoot, { recursive: true });
    const att = d("d-att", "attachment", attachRoot, "attachment");
    const h = harness({ dirs: [PROJ(), att] });
    const r = await h.run("read", { host: "attachment", path: "/../x" });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain("must stay inside it");
    expect(h.asked).toEqual([]);
    expect(h.audits.at(-1)?.detail).toMatchObject({
      by: "rule",
      decision: "deny",
    });
  });

  test("写另一个已登记目录的 .canvas/：被拦（读不拦）", async () => {
    const h = harness();
    const r = await h.run("write", {
      host: "local:B",
      path: X(B, ".canvas", "index.md"),
      content: "x",
    });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain(".canvas/ is managed by the canvas_edit tool");
    expect(
      await h.run("read", {
        host: "local:B",
        path: X(B, ".canvas", "index.md"),
      }),
    ).toBeUndefined();
  });

  test("无人值守：需要审批的文件调用直接拒绝，不产生规则", async () => {
    const added: RememberRule[] = [];
    const h = harness({ unattended: true, added });
    const r = await h.run("read", { host: "dev1", path: "/etc/hosts" });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain("没有人工审批通道");
    expect(added).toEqual([]);
    expect(h.asked).toEqual([]);
  });

  test("完全允许档：任何主机上的路径都放行", async () => {
    const h = harness({ tier: "full" });
    expect(
      await h.run("read", { host: "dev1", path: "/etc/hosts" }),
    ).toBeUndefined();
    expect(h.asked).toEqual([]);
  });

  test("不带 host 的绝对路径：在当前目录所在的主机上，属于目录外要审批", async () => {
    const h = harness();
    await h.run("read", { path: "/etc/hosts" });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.detail).toMatchObject({ summary: "local:/etc/hosts" });
  });

  test("未知主机：拒绝并把清单给模型，不弹卡片", async () => {
    const h = harness();
    const r = await h.run("read", { host: "ghost", path: "/etc/hosts" });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain('Unknown host "ghost"');
    expect(h.asked).toEqual([]);
  });

  test("路径里带主机名：拒绝并教它把主机放进 host，不弹卡片", async () => {
    const h = harness();
    const r = await h.run("read", { path: "dev1:/etc/hosts" });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain("starts with a host name");
    expect(h.asked).toEqual([]);
  });

  test("附件区只读：写与改在两档下都被拒，读不拒", async () => {
    const attachRoot = path.join(root, "att");
    mkdirSync(attachRoot, { recursive: true });
    const att = d("d-att", "attachment", attachRoot, "attachment");
    for (const tier of ["rules", "full"] as const) {
      const h = harness({ dirs: [PROJ(), att], tier });
      for (const tool of ["write", "edit"]) {
        const r = await h.run(tool, {
          host: "attachment",
          path: "/2026-11-16/x.png",
          content: "x",
          edits: [],
        });
        expect(r).toMatchObject({ block: true });
        expect(r?.reason).toContain("The attachment host is read-only.");
      }
      expect(
        await h.run("read", { host: "attachment", path: "/2026-11-16/x.png" }),
      ).toBeUndefined();
      expect(h.asked).toEqual([]);
    }
  });

  test("host:目录名 下的相对路径：从那个目录起，归属也是它", async () => {
    const addedTo: string[] = [];
    const h = harness({
      addedTo,
      answer: { outcome: "answered", optionId: "remember" },
    });
    // B 不是当前目录：点名它之后相对路径从 B 起
    const r = await h.run("write", {
      host: "local:B",
      path: "new.txt",
      content: "x",
    });
    expect(r).toBeUndefined();
    expect(addedTo).toEqual([]);
    // OUT 之外的点名目录给出目录外的路径：归属仍是该目录
    await h.run("write", {
      host: "dev1:train",
      path: "../elsewhere/new.txt",
      content: "x",
    });
    expect(addedTo).toEqual(["d-dev"]);
  });

  test("ls 与带选择器的 grep / find 不扫整棵树找敏感文件；不带选择器的 grep 照旧要审批", async () => {
    const C = path.join(root, "c");
    mkdirSync(C, { recursive: true });
    writeFileSync(path.join(C, ".env"), "K=v");
    const h = harness({ dirs: [PROJ(), d("d-c", "C", C)] });
    const at = C;
    expect(await h.run("ls", { path: at })).toBeUndefined();
    expect(
      await h.run("grep", { pattern: "x", path: at, glob: "*.ts" }),
    ).toBeUndefined();
    expect(await h.run("find", { pattern: "*.ts", path: at })).toBeUndefined();
    expect(h.asked).toEqual([]);
    await h.run("grep", { pattern: "x", path: at });
    expect(h.asked).toHaveLength(1);
  });

  describe("协作区（虚拟主机 collab）", () => {
    test("子代理读整棵树（含别人的子目录）都放行，不看档位、不弹审批", async () => {
      for (const tier of ["rules", "full"] as const) {
        const h = harness({
          dirs: [PROJ(), COLLAB()],
          tier,
          collab: collabAllows("c1"),
        });
        expect(
          await h.run("read", { host: "collab", path: "/c1/report.md" }),
        ).toBeUndefined();
        expect(
          await h.run("read", { host: "collab", path: "/c2/other.md" }),
        ).toBeUndefined();
        expect(h.asked).toEqual([]);
      }
    });

    test("子代理写自己的子目录放行；写别人的子目录与树根拒绝（两档都拒）", async () => {
      for (const tier of ["rules", "full"] as const) {
        const h = harness({
          dirs: [PROJ(), COLLAB()],
          tier,
          collab: collabAllows("c1"),
        });
        expect(
          await h.run("write", {
            host: "collab",
            path: "/c1/notes.md",
            content: "x",
          }),
        ).toBeUndefined();
        for (const path of ["/c2/other.md", "/board.md"]) {
          const r = await h.run("write", {
            host: "collab",
            path,
            content: "x",
          });
          expect(r).toMatchObject({ block: true });
          expect(r?.reason).toContain(
            "That path in the collab host is not yours to change.",
          );
        }
        expect(h.asked).toEqual([]);
      }
    });

    test("根会话（selfId 为 null）写拒绝；读照常放行", async () => {
      const h = harness({
        dirs: [PROJ(), COLLAB()],
        collab: collabAllows(null),
      });
      expect(
        await h.run("read", { host: "collab", path: "/c1/report.md" }),
      ).toBeUndefined();
      const r = await h.run("write", {
        host: "collab",
        path: "/board.md",
        content: "x",
      });
      expect(r).toMatchObject({ block: true });
      expect(h.asked).toEqual([]);
    });

    test("团队成员全部停止时 lead 可改公告板；有人在跑就不行", async () => {
      const idle = harness({
        dirs: [PROJ(), COLLAB()],
        collab: collabAllows(null, true),
      });
      expect(
        await idle.run("edit", {
          host: "collab",
          path: "/board.md",
          edits: [],
        }),
      ).toBeUndefined();
      const busy = harness({
        dirs: [PROJ(), COLLAB()],
        collab: collabAllows(null, false),
      });
      expect(
        await busy.run("edit", {
          host: "collab",
          path: "/board.md",
          edits: [],
        }),
      ).toMatchObject({ block: true });
    });

    test("主目录在 ssh 上、目录里没有本机目录：collab 照样可寻址（读放行）", async () => {
      const h = harness({
        dirs: [DEV(), COLLAB()],
        currentId: "d-dev",
        collab: collabAllows("c1"),
      });
      expect(
        await h.run("read", { host: "collab", path: "/c2/other.md" }),
      ).toBeUndefined();
      expect(h.asked).toEqual([]);
    });

    test("传输的写端也按 collab 判，full 档同样拒绝（judgeTarget 在放行之前判）", async () => {
      const h = harness({
        dirs: [PROJ(), COLLAB()],
        tier: "full",
        collab: collabAllows(null),
      });
      const r = await h.run("transfer_files", {
        from: path.join(A, "a.txt"),
        to: "/board.md",
        to_host: "collab",
      });
      expect(r).toMatchObject({ block: true });
      expect(r?.reason).toContain(
        "That path in the collab host is not yours to change.",
      );
      expect(h.asked).toEqual([]);
    });

    test("传输：协作区里别人的报告可以读出来（源端放行），写进自己那份子目录也放行", async () => {
      const h = harness({
        dirs: [PROJ(), COLLAB()],
        collab: collabAllows("c1"),
      });
      expect(
        await h.run("transfer_files", {
          from: "/c2/other.md",
          from_host: "collab",
          to: path.join(A, "copy.md"),
        }),
      ).toBeUndefined();
      expect(
        await h.run("transfer_files", {
          from: path.join(A, "a.txt"),
          to: "/c1/mine.txt",
          to_host: "collab",
        }),
      ).toBeUndefined();
      expect(h.asked).toEqual([]);
    });

    test("collab 不是目录：switch 用的 directory 引用被拒", () => {
      const h = harness({ dirs: [PROJ(), COLLAB()] });
      return expect(h.locate("collab:x", "/a")).rejects.toThrow(
        "The collab host is not a directory.",
      );
    });
  });
});
