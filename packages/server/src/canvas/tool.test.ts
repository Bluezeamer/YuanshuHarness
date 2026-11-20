import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv } from "../env/types.js";
import { CanvasRepo } from "./repo.js";
import { CanvasError } from "./service.js";
import { canvasExtension, canvasSyncExtension } from "./tool.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const project = () => {
  const d = mkdtempSync(path.join(tmpdir(), "yuanshu-canvas-tool-"));
  dirs.push(d);
  return d;
};

interface Result {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** 只取其中一个工具的 execute。 */
function tool(factory: ExtensionFactory) {
  let exec: ((id: string, params: unknown) => Promise<Result>) | undefined;
  let params: unknown;
  const pi = {
    registerTool: (t: {
      name: string;
      parameters: unknown;
      execute: (id: string, p: unknown) => Promise<Result>;
    }) => {
      params = t.parameters;
      exec = t.execute;
    },
    on: () => {},
  };
  void factory(pi as never);
  return {
    params: params as {
      type: string;
      properties: Record<string, { type?: string; enum?: string[] }>;
      required?: string[];
    },
    run: (p: unknown) => {
      if (!exec) throw new Error("tool not registered");
      return exec("t1", p);
    },
  };
}

const setup = (
  env: ExecEnv = new LocalEnv(),
  resolveTarget?: (target?: string) => {
    repo: CanvasRepo;
    label: string;
    envId: string;
  },
) => {
  const dir = project();
  const repo = new CanvasRepo(env, dir, { commitDelayMs: 10 });
  const t = tool(
    canvasExtension({
      sessionId: "s1",
      resolve:
        resolveTarget ??
        (() => ({ repo, label: "local:proj", envId: "local" })),
    }),
  );
  return { dir, repo, t };
};

const textOf = (r: Result) => r.content.map((c) => c.text).join("\n");

describe("canvas_edit 工具：别的主机上的文件", () => {
  test("file 写「主机名:绝对路径」：主机名经 resolveHost 换成环境 id，节点带 host；不认识的主机整批拒绝", async () => {
    const dir = project();
    const other = project();
    writeFileSync(path.join(other, "notes.md"), "# 远端");
    const repo = new CanvasRepo(new LocalEnv(), dir, {
      commitDelayMs: 10,
      envOf: (id) => (id === "h1" ? new LocalEnv() : null),
    });
    await repo.createBoard("b");
    const t = tool(
      canvasExtension({
        sessionId: "s1",
        resolve: () => ({ repo, label: "local:proj", envId: "local" }),
        resolveHost: (name) => (name === "dev-01" ? "h1" : null),
      }),
    );
    const abs = path.join(other, "notes.md");
    const ok = await t.run({
      ops: [{ op: "place", canvas: "b", file: `dev-01:${abs}` }],
    });
    expect(ok.isError).toBeUndefined();
    expect(textOf(ok)).toContain(`place h1:${abs} on b`);
    const { doc } = await repo.readBoard("b");
    expect(doc.nodes[0]).toMatchObject({ file: abs, host: "h1" });

    const unknown = await t.run({
      ops: [{ op: "place", canvas: "b", file: `nope:${abs}` }],
    });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('host "nope" not found');

    const gone = await t.run({
      ops: [{ op: "unplace", canvas: "b", file: `dev-01:${abs}` }],
    });
    expect(gone.isError).toBeUndefined();
    expect((await repo.readBoard("b")).doc.nodes).toHaveLength(0);
  });
});

describe("canvas_edit 工具", () => {
  test("schema 是扁平的：op 用 enum，其余都是可选属性", () => {
    const { t } = setup();
    expect(t.params.type).toBe("object");
    expect(t.params.required).toEqual(["ops"]);
    const item = (
      t.params.properties.ops as unknown as {
        items: { properties: Record<string, unknown>; required?: string[] };
      }
    ).items;
    expect(item.required).toEqual(["op"]);
    expect(Object.keys(item.properties).sort()).toEqual([
      "canvas",
      "file",
      "name",
      "new",
      "old",
      "op",
      "path",
      "text",
      "to",
    ]);
    expect(t.params.properties.directory?.type).toBe("string");
  });

  test("一批操作返回逐条结果文本", async () => {
    const { t, dir, repo } = setup();
    await repo.createBoard("b");
    const r = await t.run({
      ops: [
        { op: "create_card", canvas: "b", name: "风险", text: "# 风险" },
        { op: "create_card", canvas: "b", name: "接口", text: "# 接口" },
      ],
    });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toContain("Applied 2 operations on local:proj:");
    expect(textOf(r)).toContain("- create card b.cards/风险.md");
    expect(
      readFileSync(path.join(dir, ".canvas", "b.cards", "接口.md"), "utf8"),
    ).toBe("# 接口");
  });

  test("校验失败返回 isError，不抛", async () => {
    const { t, repo } = setup();
    await repo.createBoard("b");
    const r = await t.run({
      ops: [{ op: "update", path: "b.cards/none.md", text: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Operation 1 (update):");
    expect(textOf(r)).toContain("index.md");
  });

  test("ops 形状不对时逐条报是第几条", async () => {
    const { t, repo } = setup();
    await repo.createBoard("b");
    const r = await t.run({ ops: [{ op: "delete" }, { op: "nope" }] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Operation 1 (delete)");
    const empty = await t.run({ ops: [] });
    expect(empty.isError).toBe(true);
    const missing = await t.run({});
    expect(missing.isError).toBe(true);
  });

  test("directory 交给 resolve（缺省不传，由调用方落到会话的本地目录）", async () => {
    const dir = project();
    const repo = new CanvasRepo(new LocalEnv(), dir, { commitDelayMs: 10 });
    const asked: Array<string | undefined> = [];
    const t = tool(
      canvasExtension({
        sessionId: "s1",
        resolve: (target) => {
          asked.push(target);
          return { repo, label: "dev1:train", envId: "e1" };
        },
      }),
    );
    await repo.createBoard("b");
    const r = await t.run({
      directory: "工作区",
      ops: [{ op: "create_card", canvas: "b", name: "卡", text: "x" }],
    });
    expect(asked).toEqual(["工作区"]);
    expect(textOf(r)).toContain("on dev1:train");
    await t.run({
      ops: [{ op: "create_card", canvas: "b", name: "卡2", text: "x" }],
    });
    expect(asked[1]).toBeUndefined();
  });

  test("resolve 抛的解析错误按 isError 返回", async () => {
    const t = tool(
      canvasExtension({
        sessionId: "s1",
        resolve: () => {
          throw new CanvasError(
            "not_found",
            "directory not found: nope. Available: 主目录.",
          );
        },
      }),
    );
    const r = await t.run({
      directory: "nope",
      ops: [{ op: "delete", path: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Available: 主目录");
  });

  test("非 CanvasError 的异常照常抛", async () => {
    const t = tool(
      canvasExtension({
        sessionId: "s1",
        resolve: () => {
          throw new TypeError("boom");
        },
      }),
    );
    await expect(
      t.run({ ops: [{ op: "delete", path: "b.cards/a.md" }] }),
    ).rejects.toThrow("boom");
  });

  test("工具描述说清只读 index、只能经本工具写、不开放结构与坐标", () => {
    let description = "";
    const pi = {
      registerTool: (t: { description?: string }) => {
        description = t.description ?? "";
      },
      on: () => {},
    };
    void canvasExtension({
      sessionId: "s1",
      resolve: () => {
        throw new Error("unused");
      },
    })(pi as never);
    expect(description).toContain("read-only");
    expect(description).toContain("the main directory");
    expect(description).toContain("only this tool may write");
    expect(description).toContain("Do not invent node ids or positions");
    expect(description).toContain('{"op":"create_canvas"');
    expect(description).toContain('{"op":"unplace"');
  });
});

test("写到项目文件里不行：canvas_edit 只能碰 .canvas/", async () => {
  const dir = project();
  writeFileSync(path.join(dir, "notes.txt"), "hi");
  const repo = new CanvasRepo(new LocalEnv(), dir, { commitDelayMs: 10 });
  const t = tool(
    canvasExtension({
      sessionId: "s1",
      resolve: () => ({ repo, label: "local:proj", envId: "local" }),
    }),
  );
  const r = await t.run({ ops: [{ op: "delete", path: "../notes.txt" }] });
  expect(r.isError).toBe(true);
  expect(readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("hi");
});

describe("canvasSyncExtension", () => {
  test("读类与命令工具调用前先 settle（失败也放行），写类工具不管", async () => {
    const hook: { run?: (e: { toolName: string }) => Promise<unknown> } = {};
    let settled = 0;
    let fail = false;
    canvasSyncExtension(async () => {
      settled++;
      if (fail) throw new Error("remote down");
    })({
      on: (name: string, h: NonNullable<typeof hook.run>) => {
        if (name === "tool_call") hook.run = h;
      },
    } as never);
    const call = (toolName: string) => hook.run?.({ toolName });
    for (const name of ["read", "grep", "find", "ls", "bash"]) await call(name);
    expect(settled).toBe(5);
    await call("write");
    await call("canvas_edit");
    expect(settled).toBe(5);
    fail = true;
    await expect(call("read")).resolves.toBeUndefined();
  });
});
