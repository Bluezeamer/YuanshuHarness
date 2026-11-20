import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv } from "../env/types.js";
import { VirtualEnv } from "../env/virtual.js";
import { createAddressBook } from "../session/address.js";
import {
  DETAIL_STRING_MAX,
  type PromptResult,
  type PromptSpec,
} from "../session/prompts.js";
import type { Directory } from "../store/directories.js";
import { ATTACHMENT_ENV_ID, LOCAL_ENV_ID } from "../store/environments.js";
import type { RememberRule } from "./decide.js";
import {
  type DirectoryCtx,
  type Located,
  permissionExtension,
} from "./extension.js";
import type { PathEnv } from "./paths.js";
import type { Tier } from "./tier.js";
import type { ToolPolicy } from "./tool-matrix.js";

// transfer_files 的两端各按自己归属目录的档位、规则与 cwd 判定：源端读、目标端写。
// 直接驱动权限扩展的 tool_call 处理器。会话挂三个工作目录：A（当前）、B（同一台本机上的另一个目录）、
// dev（另一台主机 dev1 上的目录），另有 OUT 在它们之外（不属于任何登记的目录，按「当前目录」归属）。
let root = "";
let A = "";
let B = "";
let DEV = "";
let OUT = "";
beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-xgate-")));
  [A, B, DEV, OUT] = ["a", "b", "dev", "out"].map((d) =>
    path.join(root, d),
  ) as [string, string, string, string];
  for (const d of [A, B, DEV, OUT]) mkdirSync(d);
  writeFileSync(path.join(A, "a.txt"), "x");
  writeFileSync(path.join(OUT, "o.txt"), "x");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Rule = { access: "read" | "write"; value: string };
const env = new LocalEnv() as unknown as PathEnv;
// 另一台主机：路径方言与访问方式同本机，只是 id 不同（真实 ssh 由 env/tools 与 permission 的 ssh 测试覆盖）。
const devEnv = new Proxy(new LocalEnv(), {
  get: (t, k) =>
    k === "id" ? "e1" : k === "kind" ? "ssh" : Reflect.get(t, k, t),
}) as unknown as PathEnv;

function ws(
  name: string,
  cwd: string,
  over: { tier?: Tier; rules?: Rule[]; virtual?: boolean } = {},
) {
  const added: RememberRule[] = [];
  const ctx: DirectoryCtx = {
    id: `id-${name}`,
    name,
    ref: `local:${name}`,
    where: {
      env: over.virtual ? new VirtualEnv(cwd) : name === "dev" ? devEnv : env,
      cwd,
    },
    tier: over.tier ?? "rules",
    rules: { path: over.rules ?? [], command: [] },
    addRule: (r) => added.push(r),
  };
  return { ctx, added };
}

interface Opts {
  a?: { tier?: Tier; rules?: Rule[] };
  b?: { tier?: Tier; rules?: Rule[] };
  dev?: { tier?: Tier; rules?: Rule[] };
  att?: { tier?: Tier; rules?: Rule[] };
  /** 会话当前所在的 directory。 */
  current?: "A" | "B";
  unattended?: boolean;
  policy?: Record<string, ToolPolicy>;
  answer?: PromptResult;
  review?: boolean;
}

/** 附件区的根：一个真的目录，虚拟主机 attachment 指向它。 */
const ATT = () => path.join(root, "att");

function harness(o: Opts = {}) {
  const sides = {
    A: ws("A", A, o.a),
    B: ws("B", B, o.b),
    dev: ws("dev", DEV, o.dev),
    ATT: ws("attachment", ATT(), { virtual: true, ...o.att }),
  };
  const dirs: Directory[] = [
    {
      id: "id-A",
      name: "A",
      path: A,
      environmentId: LOCAL_ENV_ID,
      createdAt: "t",
    },
    {
      id: "id-B",
      name: "B",
      path: B,
      environmentId: LOCAL_ENV_ID,
      createdAt: "t",
    },
    {
      id: "id-dev",
      name: "dev",
      path: DEV,
      environmentId: "e1",
      createdAt: "t",
    },
    {
      id: "id-ATT",
      name: "attachment",
      path: ATT(),
      environmentId: ATTACHMENT_ENV_ID,
      createdAt: "t",
    },
  ];
  const asked: PromptSpec[] = [];
  const audits: Array<{
    actor: string;
    summary: string;
    detail: Record<string, unknown>;
  }> = [];
  const reviewed: string[] = [];
  const cur = o.current === "B" ? 1 : 0;
  const book = createAddressBook({
    directories: () => dirs,
    primaryEnvId: () => LOCAL_ENV_ID,
    current: () => dirs[cur] as Directory,
    envOf: (d) =>
      (d.environmentId === ATTACHMENT_ENV_ID
        ? sides.ATT.ctx.where.env
        : d.environmentId === "e1"
          ? devEnv
          : env) as unknown as ExecEnv,
    connectionName: (id) => (id === "e1" ? "dev1" : undefined),
  });
  // 两端各按归属目录的档位与规则判（两端与单端都是 judgeTarget 一个解法）
  const locate = async (
    host: string | undefined,
    path: string | undefined,
  ): Promise<Located> => {
    const at = await book.locate(host, path);
    const side =
      at.directory.id === "id-B"
        ? sides.B
        : at.directory.id === "id-dev"
          ? sides.dev
          : at.directory.id === "id-ATT"
            ? sides.ATT
            : sides.A;
    return {
      host: at.host,
      shown: at.shown,
      env: at.env,
      path: at.path,
      ctx: side.ctx,
    };
  };
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  permissionExtension({
    // 单端流程用的 where / tier / rules 故意给哨兵（完全允许档、cwd 是所有目录的父目录、
    // 一条覆盖一切的写规则）：传输判定若误用了它们，所有「要审批」的用例都会变成放行而失败
    // 单端（命令类）的判定上下文故意给哨兵（完全允许档、一条覆盖一切的写规则）：
    // 传输判定若误用了它，所有「要审批」的用例都会变成放行而失败
    directoryCtx: async () => ({
      id: "sentinel",
      name: "sentinel",
      ref: "local:sentinel",
      where: { env: env as unknown as ExecEnv, cwd: root },
      tier: "full",
      rules: { path: [{ access: "write", value: root }], command: [] },
      addRule: () => {
        throw new Error("传输不应调用单端的 addRule");
      },
    }),
    tier: () => "full",
    locate,
    ...(o.unattended ? { unattended: true } : {}),
    ...(o.policy ? { toolPolicy: (t: string) => o.policy?.[t] ?? null } : {}),
    ...(o.review
      ? {
          review: async (c: { tool: string }) => {
            reviewed.push(c.tool);
            return { decision: "allow" as const };
          },
        }
      : {}),
    ask: async (spec) => {
      asked.push(spec);
      return o.answer ?? { outcome: "answered", optionId: "allow" };
    },
    audit: (rec) => audits.push(rec),
  })({
    on: (_n: string, h: (e: unknown) => Promise<unknown>) => {
      handler = h;
    },
  } as never);
  return {
    asked,
    audits,
    reviewed,
    added: { A: sides.A.added, B: sides.B.added, dev: sides.dev.added },
    call: (input: Record<string, unknown>) =>
      handler?.({
        toolName: "transfer_files",
        toolCallId: "t1",
        input,
      }) as Promise<{ block?: boolean; reason?: string } | undefined>,
  };
}

const X = (...p: string[]) => path.join(...p);
const optionIds = (spec?: PromptSpec) => spec?.options?.map((o) => o.id);
/** 两端都在本机（A 与 B）：只给绝对路径，host 缺省按当前目录判归属。 */
const between = (from: string, to: string, extra = {}) => ({
  from,
  to,
  ...extra,
});

describe("两端各自按「读」「写」与各自 cwd 判定（规则档，出厂规则：cwd 内放行、cwd 外审批）", () => {
  test("两端都在各自目录内：直接放行，不弹窗", async () => {
    const h = harness();
    expect(await h.call(between(X(A, "a.txt"), X(B, "n.txt")))).toBeUndefined();
    expect(h.asked).toEqual([]);
  });

  test("相对路径按当前目录解析；目标端在 cwd 外时弹窗里显示解析后的地址", async () => {
    const h = harness();
    expect(await h.call({ from: "a.txt", to: "n.txt" })).toBeUndefined();
    expect(h.asked).toEqual([]);
    // 两端都相对当前目录 A：目标端解析到 A 之外的 OUT
    await h.call({ from: "a.txt", to: "../out/n.txt" });
    expect(h.asked[0]?.body).toContain(
      `from local:${X(A, "a.txt")} to local:${X(OUT, "n.txt")}`,
    );
  });

  test("只有目标端在 cwd 外：弹一个窗，只点名目标端", async () => {
    const h = harness();
    expect(
      await h.call(between(X(A, "a.txt"), X(OUT, "n.txt"))),
    ).toBeUndefined();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("Destination needs approval: write");
    expect(h.asked[0]?.body).not.toContain("Source needs approval");
    expect(h.asked[0]?.detail).toMatchObject({ tool: "transfer_files" });
  });

  test("只有源端在 cwd 外：只点名源端", async () => {
    const h = harness();
    await h.call(between(X(OUT, "o.txt"), X(A, "n.txt")));
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("Source needs approval: read");
    expect(h.asked[0]?.body).not.toContain("Destination needs approval");
  });

  test("跨主机两端都超出各自目录：合并成一个弹窗，摘要写清两端", async () => {
    const h = harness();
    await h.call({
      from: X(OUT, "o.txt"),
      to_host: "dev1",
      to: X(OUT, "n.txt"),
      overwrite: true,
    });
    expect(h.asked).toHaveLength(1);
    const body = h.asked[0]?.body ?? "";
    expect(body).toContain("Source needs approval");
    expect(body).toContain("Destination needs approval");
    expect(body).toContain(
      `from local:${X(OUT, "o.txt")} to dev1:${X(OUT, "n.txt")} (overwrite allowed)`,
    );
  });

  test("拒绝时把用户写的话带给模型（选 deny + 文字，或只写文字）", async () => {
    for (const answer of [
      { outcome: "answered", optionId: "deny", text: "别搬出去" },
      { outcome: "answered", text: "别搬出去" },
    ] as PromptResult[]) {
      const h = harness({ answer });
      const r = await h.call(between(X(A, "a.txt"), X(OUT, "n.txt")));
      expect(r?.block).toBe(true);
      expect(r?.reason).toContain("用户拒绝了该操作");
      expect(r?.reason).toContain("用户补充：别搬出去");
      const audit = JSON.stringify(h.audits.at(-1));
      expect(audit).not.toContain("别搬出去");
    }
    // 没写文字时保持原句
    const plain = harness({
      answer: { outcome: "answered", optionId: "deny" },
    });
    expect(
      (await plain.call(between(X(A, "a.txt"), X(OUT, "n.txt"))))?.reason,
    ).toBe("用户拒绝了该操作");
  });

  test("相对路径按会话当前目录解析，但判定按它归属的目录", async () => {
    const h = harness({ current: "B" });
    // 相对 B 解析出 A 里的文件：归属 A，所以在 A 的 cwd 内 → 放行（跨目录读比按当前目录更宽松）
    expect(await h.call({ from: "../a/a.txt", to: "n.txt" })).toBeUndefined();
    expect(h.asked).toEqual([]);
    // 相对 B 解析到 B 之外的 OUT：不归属任何目录，按当前目录 B 判为目录外
    await h.call({ from: "../a/a.txt", to: "../out/n.txt" });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("Destination needs approval: write");
  });

  test("目标是指向 cwd 外的符号链接目录：按真实位置算 cwd 外", async () => {
    symlinkSync(OUT, X(A, "to-out"));
    const h = harness();
    await h.call(between(X(A, "a.txt"), X(A, "to-out", "n.txt")));
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain(X(OUT, "n.txt"));
  });
});

describe("档位与规则按各自归属目录，不取会话当前的", () => {
  test("目标端完全允许、源端规则档：只有源端要审批（当前目录是源端 A）", async () => {
    const h = harness({ dev: { tier: "full" } });
    await h.call({
      from: X(OUT, "o.txt"),
      to_host: "dev1",
      to: X(OUT, "n.txt"),
    });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("Source needs approval");
    expect(h.asked[0]?.body).not.toContain("Destination needs approval");
  });

  test("源端完全允许、目标端规则档：只有目标端要审批", async () => {
    const h = harness({ a: { tier: "full" } });
    await h.call({
      from: X(OUT, "o.txt"),
      to_host: "dev1",
      to: X(OUT, "n.txt"),
    });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("Destination needs approval");
    expect(h.asked[0]?.body).not.toContain("Source needs approval");
  });

  test("两端都完全允许：不弹窗；任何一端是 full 都不能替另一端放行", async () => {
    const both = harness({ a: { tier: "full" }, dev: { tier: "full" } });
    expect(
      await both.call({
        from: X(OUT, "o.txt"),
        to_host: "dev1",
        to: X(OUT, "n.txt"),
      }),
    ).toBeUndefined();
    expect(both.asked).toEqual([]);
  });

  test("规则只对各自 directory 生效：写规则放行读写，读规则不放行写", async () => {
    // 源端 A 有 OUT 的读规则、目标端 dev 有 OUT 的写规则 → 两端都被规则覆盖
    const covered = harness({
      a: { rules: [{ access: "read", value: OUT }] },
      dev: { rules: [{ access: "write", value: OUT }] },
    });
    expect(
      await covered.call({
        from: X(OUT, "o.txt"),
        to_host: "dev1",
        to: X(OUT, "n.txt"),
      }),
    ).toBeUndefined();
    expect(covered.asked).toEqual([]);

    // 目标端只有读规则：写不被覆盖
    const readOnly = harness({
      a: { rules: [{ access: "read", value: OUT }] },
      dev: { rules: [{ access: "read", value: OUT }] },
    });
    await readOnly.call({
      from: X(OUT, "o.txt"),
      to_host: "dev1",
      to: X(OUT, "n.txt"),
    });
    expect(readOnly.asked).toHaveLength(1);
    expect(readOnly.asked[0]?.body).toContain("Destination needs approval");
    expect(readOnly.asked[0]?.body).not.toContain("Source needs approval");

    // 规则记在源端 A 上，不能替目标端放行
    const wrongSide = harness({
      a: {
        rules: [
          { access: "read", value: OUT },
          { access: "write", value: OUT },
        ],
      },
    });
    await wrongSide.call({
      from: X(OUT, "o.txt"),
      to_host: "dev1",
      to: X(OUT, "n.txt"),
    });
    expect(wrongSide.asked[0]?.body).toContain("Destination needs approval");
    expect(wrongSide.asked[0]?.body).not.toContain("Source needs approval");
  });

  test("auto 档的需要审批一端不送自动审核，直接交人工", async () => {
    const h = harness({
      a: { tier: "auto" },
      dev: { tier: "auto" },
      review: true,
    });
    await h.call({
      from: X(OUT, "o.txt"),
      to_host: "dev1",
      to: X(OUT, "n.txt"),
    });
    expect(h.reviewed).toEqual([]);
    expect(h.asked).toHaveLength(1);
  });
});

describe("附件区一端：根内的路径直接放行（不看档位与敏感名），越界由地址解析拒绝", () => {
  test("源端是附件区：根内放行（敏感文件名也不审批）", async () => {
    mkdirSync(ATT(), { recursive: true });
    writeFileSync(X(ATT(), ".env"), "SECRET=1");
    const h = harness();
    expect(
      await h.call({
        from_host: "attachment",
        from: "/.env",
        to: X(B, "n.txt"),
      }),
    ).toBeUndefined();
    expect(h.asked).toEqual([]);
  });

  test("源端是附件区且越界：在地址解析处拒绝", async () => {
    const h = harness();
    const r = await h.call({
      from_host: "attachment",
      from: "/../out/o.txt",
      to: X(B, "n.txt"),
    });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain(
      "Paths on the attachment host must stay inside it",
    );
    expect(h.asked).toEqual([]);
  });

  test("目标端是附件区：任何档位都拒（只读）", async () => {
    mkdirSync(ATT(), { recursive: true });
    for (const tier of ["rules", "full"] as const) {
      const h = harness({ att: { tier } });
      const r = await h.call({
        from: X(A, "a.txt"),
        to_host: "attachment",
        to: "/copy.txt",
      });
      expect(r).toMatchObject({ block: true });
      expect(r?.reason).toContain("The attachment host is read-only.");
      expect(h.asked).toEqual([]);
    }
  });
});

describe("敏感路径只交人工、不可记住", () => {
  test("源是目录且树里有敏感文件：要审批，且没有「记住」", async () => {
    mkdirSync(X(A, "proj"), { recursive: true });
    writeFileSync(X(A, "proj", ".env"), "SECRET=1");
    const h = harness();
    await h.call(between(X(A, "proj"), X(B, "proj")));
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("Source needs approval");
    expect(optionIds(h.asked[0])).toEqual(["allow", "deny"]);
  });

  test("源是不含敏感文件的目录（在当前目录之外）：普通审批，可记住", async () => {
    mkdirSync(X(OUT, "clean"), { recursive: true });
    writeFileSync(X(OUT, "clean", "f.txt"), "x");
    const h = harness();
    await h.call(between(X(OUT, "clean"), X(A, "clean")));
    expect(h.asked).toHaveLength(1);
    expect(optionIds(h.asked[0])).toEqual(["allow", "deny", "remember"]);
  });

  test("目标路径本身是敏感路径：要审批，没有「记住」", async () => {
    const h = harness();
    await h.call(between(X(A, "a.txt"), X(B, ".ssh", "authorized_keys")));
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("Destination needs approval");
    expect(optionIds(h.asked[0])).toEqual(["allow", "deny"]);
  });
});

describe("审批结果与「记住」", () => {
  test("两端都要审批且都可记住：各记到各自的目录（读规则记源端、写规则记目标端）", async () => {
    const h = harness({
      answer: { outcome: "answered", optionId: "remember" },
    });
    expect(
      await h.call({
        from: X(OUT, "o.txt"),
        to_host: "dev1",
        to: X(OUT, "n.txt"),
      }),
    ).toBeUndefined();
    expect(optionIds(h.asked[0])).toEqual(["allow", "deny", "remember"]);
    expect(h.added.A).toEqual([{ kind: "path", access: "read", value: OUT }]);
    expect(h.added.dev).toEqual([
      { kind: "path", access: "write", value: OUT },
    ]);
    expect(h.added.B).toEqual([]);
    expect(h.audits.at(-1)).toMatchObject({
      actor: "user",
      detail: { decision: "remember", by: "user" },
    });
  });

  test("只有一端要审批：只记那一端", async () => {
    const h = harness({
      answer: { outcome: "answered", optionId: "remember" },
    });
    await h.call(between(X(A, "a.txt"), X(OUT, "n.txt")));
    // 目标端在 OUT：不属于任何登记目录，按当前目录 A 归属，写规则记在 A 上
    expect(h.added.A).toEqual([{ kind: "path", access: "write", value: OUT }]);
    expect(h.added.B).toEqual([]);
  });

  test("要审批的一端不可记住（敏感路径）：整体不提供「记住」，答 remember 也不放行", async () => {
    mkdirSync(X(A, "p2"), { recursive: true });
    writeFileSync(X(A, "p2", ".env"), "S=1");
    const h = harness({
      answer: { outcome: "answered", optionId: "remember" },
    });
    const r = await h.call(between(X(A, "p2"), X(OUT, "n")));
    expect(optionIds(h.asked[0])).toEqual(["allow", "deny"]);
    expect(r).toMatchObject({ block: true });
    expect(h.added.A).toEqual([]);
  });

  test("用户批准一次：放行、不记规则；用户拒绝 / 超时 / 取消：拒绝", async () => {
    const allow = harness();
    expect(
      await allow.call(between(X(A, "a.txt"), X(OUT, "n.txt"))),
    ).toBeUndefined();
    expect(allow.added.A).toEqual([]);
    expect(allow.audits.at(-1)).toMatchObject({
      actor: "user",
      detail: { decision: "allow" },
    });

    for (const [answer, reason] of [
      [{ outcome: "answered", optionId: "deny" }, "用户拒绝了该操作"],
      [{ outcome: "timeout" }, "审批超时，已拒绝"],
      [{ outcome: "cancelled" }, "审批已取消，已拒绝"],
    ] as const) {
      const h = harness({ answer });
      expect(await h.call(between(X(A, "a.txt"), X(OUT, "n.txt")))).toEqual({
        block: true,
        reason,
      });
    }
  });
});

describe("无人值守的子会话：拿不准一律拒绝", () => {
  test("两端都放行：照常执行", async () => {
    const h = harness({ unattended: true });
    expect(await h.call(between(X(A, "a.txt"), X(B, "n.txt")))).toBeUndefined();
  });

  test("任一端需要审批：拒绝、不弹窗、不产生规则，并记审计", async () => {
    const h = harness({ unattended: true });
    const r = await h.call(between(X(A, "a.txt"), X(OUT, "n.txt")));
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain("子会话没有人工审批通道");
    expect(r?.reason).toContain("Destination needs approval");
    expect(h.asked).toEqual([]);
    expect(h.added).toEqual({ A: [], B: [], dev: [] });
    expect(h.audits[0]).toMatchObject({
      actor: "system",
      detail: { tool: "transfer_files", decision: "deny", by: "unattended" },
    });
  });
});

describe("弹窗展示有上限", () => {
  test("两端路径太长、弹窗看不全：不让批准，直接拒绝", async () => {
    const h = harness();
    const long = X(OUT, "d".repeat(DETAIL_STRING_MAX));
    const r = await h.call({ from: X(A, "a.txt"), to: long });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain("无法完整展示给用户审批");
    expect(h.asked).toEqual([]);
  });
});

describe("无法判定一律拒绝", () => {
  test("未知主机：拒绝并把原因给模型，不弹窗", async () => {
    const h = harness();
    const r = await h.call({
      from_host: "ghost",
      from: "/a.txt",
      to: X(B, "n.txt"),
    });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain('Unknown host "ghost"');
    expect(r?.reason).toContain("Hosts in this session: local, dev1");
    expect(h.asked).toEqual([]);
  });

  test("两端各自解析：源端给目录、目标端给裸主机 + 绝对路径", async () => {
    const h = harness();
    expect(
      await h.call({
        from_host: "local:A",
        from: "a.txt",
        to_host: "dev1",
        to: X(OUT, "n.txt"),
      }),
    ).toBeUndefined();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("Destination needs approval");
    expect(h.asked[0]?.body).not.toContain("Source needs approval");
  });

  test("host:ws 下相对路径的归属目录判定：相对路径从该目录起，按该目录的 cwd 判", async () => {
    const h = harness();
    // from_host 点名 B 的目录（B 不是当前目录），B 是本地目录
    expect(
      await h.call({
        from_host: "local:B",
        from: "b-in.txt",
        to: X(A, "n.txt"),
      }),
    ).toBeUndefined();
    expect(h.asked).toEqual([]);
    // 相对 B 走到目录外：按归属目录 B 判为目录外，要审批
    await h.call({
      from_host: "local:B",
      from: "../out/o.txt",
      to: X(A, "n.txt"),
    });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("Source needs approval");
  });

  test("缺少 from 或 to：直接拒绝，不弹卡片", async () => {
    const h = harness();
    expect(await h.call({ from: "a.txt" })).toMatchObject({ block: true });
    expect(await h.call({ to: "n.txt" })).toMatchObject({ block: true });
    expect(h.asked).toEqual([]);
  });

  test("路径解析不了（悬空符号链接）：按 cwd 外处理，只交人工、不可记住", async () => {
    symlinkSync(X(root, "no-such-dir"), X(B, "dangling"));
    const h = harness();
    expect(
      await h.call(between(X(A, "a.txt"), X(B, "dangling", "n.txt"))),
    ).toBeUndefined();
    expect(h.asked).toHaveLength(1);
    expect(optionIds(h.asked[0])).toEqual(["allow", "deny"]);
  });
});
