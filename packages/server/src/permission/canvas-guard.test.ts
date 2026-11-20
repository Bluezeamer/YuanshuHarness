import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { PromptSpec } from "../session/prompts.js";
import { permissionExtension } from "./extension.js";
import { dirAt, locateAt } from "./testkit.js";
import type { Tier } from "./tier.js";

// 画布文件夹的写保护：write / edit 落在 <cwd>/.canvas/ 里，任何档位都被拦；读不拦。

const root = mkdtempSync(path.join(tmpdir(), "yuanshu-canvas-guard-"));
const cwd = path.join(root, "ws");
mkdirSync(path.join(cwd, ".canvas", "boards"), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function harness(tier: Tier = "rules") {
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  const asked: PromptSpec[] = [];
  const audits: Array<{ detail: Record<string, unknown> }> = [];
  permissionExtension({
    directoryCtx: dirAt(cwd, { tier }),
    tier: () => tier,
    locate: locateAt(cwd, { tier }),
    ask: async (spec) => {
      asked.push(spec);
      return { outcome: "answered", optionId: "allow" } as never;
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
    run: (tool: string, input: Record<string, unknown>) =>
      handler?.({ toolName: tool, input, toolCallId: "c1" }) as Promise<
        { block?: boolean; reason?: string } | undefined
      >,
  };
}

const CARD = ".canvas/boards/b.cards/a.md";

describe("画布写保护", () => {
  test("write / edit 写 .canvas/ 被拦，且任何档位都拦（含 full）", async () => {
    for (const tier of ["rules", "auto", "full"] as const) {
      const h = harness(tier);
      expect(await h.run("write", { path: CARD, content: "x" })).toMatchObject({
        block: true,
      });
      expect(
        await h.run("edit", { path: CARD, old: "a", new: "b" }),
      ).toMatchObject({
        block: true,
      });
      // 绝对路径、目录本身、还不存在的文件同样拦
      expect(
        await h.run("write", {
          path: path.join(cwd, ".canvas", "index.md"),
          content: "x",
        }),
      ).toMatchObject({ block: true });
      expect(
        await h.run("write", { path: path.join(cwd, ".canvas"), content: "x" }),
      ).toMatchObject({ block: true });
      expect(
        await h.run("write", { path: ".canvas/new/x.md", content: "x" }),
      ).toMatchObject({ block: true });
      expect(h.asked).toHaveLength(0);
    }
  });

  test("拒绝原因说明要改用 canvas_edit，并留下审计", async () => {
    const h = harness("full");
    const r = await h.run("write", { path: CARD, content: "x" });
    expect(r?.reason).toContain(".canvas/ is managed by the canvas_edit tool");
    expect(r?.reason).toContain("reading them with read");
    expect(h.audits.at(-1)?.detail).toMatchObject({
      tool: "write",
      decision: "deny",
      by: "rule",
    });
  });

  test("读 .canvas/ 不拦", async () => {
    const h = harness("rules");
    expect(await h.run("read", { path: CARD })).toBeUndefined();
    expect(
      await h.run("grep", { pattern: "x", path: ".canvas" }),
    ).toBeUndefined();
    expect(await h.run("ls", { path: ".canvas" })).toBeUndefined();
    expect(h.asked).toHaveLength(0);
  });

  test("其他路径不受影响：cwd 内的普通写入照常放行，cwd 外照常审批", async () => {
    const h = harness("rules");
    expect(
      await h.run("write", { path: "notes/a.txt", content: "x" }),
    ).toBeUndefined();
    expect(h.asked).toHaveLength(0);
    await h.run("write", {
      path: path.join(root, "outside.txt"),
      content: "x",
    });
    expect(h.asked).toHaveLength(1);
    // 名字里带 .canvas 但在 cwd 之外不算
    await h.run("write", {
      path: path.join(root, "other/.canvas/a.md"),
      content: "x",
    });
    expect(h.asked).toHaveLength(2);
  });

  test("bash 拦不住，也不该在这里拦", async () => {
    const h = harness("full");
    expect(
      await h.run("bash", { command: `echo hi > ${CARD}` }),
    ).toBeUndefined();
  });
});
