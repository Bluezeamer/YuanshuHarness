import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import {
  checkArgs,
  NAME_RE,
  NamedWorkflows,
  type ParamDecl,
  parseNamedWorkflow,
} from "./named.js";

const meta = (json: string, script = "return 1;") =>
  `/* @workflow\n${json}\n*/\n${script}`;

describe("解析命名流程文件", () => {
  test("正常：元数据是纯 JSON，脚本是块注释之后的全部文本", () => {
    const text = `\n\n/* @workflow\n{
  "description": "评审一批 PR",
  "params": { "scope": { "type": "string", "default": "week" }, "limit": { "type": "integer", "required": true } },
  "phases": ["list", "review"]
}\n*/\nconst a = 1;\nreturn await agent("x" + a);`;
    const r = parseNamedWorkflow(text);
    if (!r.ok) throw new Error(r.error);
    expect(r.meta).toEqual({
      description: "评审一批 PR",
      params: {
        scope: { type: "string", default: "week" },
        limit: { type: "integer", required: true },
      },
      phases: ["list", "review"],
    });
    expect(r.script).toBe('\nconst a = 1;\nreturn await agent("x" + a);');
  });

  test("没有元数据块、块没闭合、JSON 非法、字段不合法都拒载并说明原因", () => {
    const noBlock = parseNamedWorkflow("return 1;");
    expect(noBlock.ok).toBe(false);
    expect(!noBlock.ok && noBlock.error).toContain("/* @workflow");

    const open = parseNamedWorkflow(
      '/* @workflow\n{"description":"x"}\nreturn 1;',
    );
    expect(open.ok).toBe(false);
    expect(!open.ok && open.error).toContain("closed");

    const badJson = parseNamedWorkflow(
      "/* @workflow\n{ description: x }\n*/\nreturn 1;",
    );
    expect(badJson.ok).toBe(false);
    expect(!badJson.ok && badJson.error).toContain("invalid JSON");

    const noDesc = parseNamedWorkflow(meta(`{"params":{}}`));
    expect(!noDesc.ok && noDesc.error).toContain('"description"');

    const unknownTop = parseNamedWorkflow(
      meta(`{"description":"x","parms":{}}`),
    );
    expect(!unknownTop.ok && unknownTop.error).toContain('"parms"');

    const badType = parseNamedWorkflow(
      meta(`{"description":"x","params":{"a":{"type":"date"}}}`),
    );
    expect(!badType.ok && badType.error).toContain("type");

    const badDefault = parseNamedWorkflow(
      meta(
        `{"description":"x","params":{"a":{"type":"integer","default":"1"}}}`,
      ),
    );
    expect(!badDefault.ok && badDefault.error).toContain("default");

    const unknownParamField = parseNamedWorkflow(
      meta(`{"description":"x","params":{"a":{"type":"string","option":1}}}`),
    );
    expect(!unknownParamField.ok && unknownParamField.error).toContain(
      '"option"',
    );

    const badPhases = parseNamedWorkflow(
      meta(`{"description":"x","phases":[1]}`),
    );
    expect(!badPhases.ok && badPhases.error).toContain("phases");

    const emptyScript = parseNamedWorkflow(meta(`{"description":"x"}`, "  "));
    expect(!emptyScript.ok && emptyScript.error).toContain("no script");
  });

  test("JSON 字符串里的 */ 用 *\\/ 转义，宿主按第一个 */ 定为块尾", () => {
    const r = parseNamedWorkflow(
      meta(`{"description":"ends the block: *\\/ really"}`, "return 2;"),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.meta.description).toBe("ends the block: */ really");
    expect(r.script.trim()).toBe("return 2;");
  });
});

describe("args 校验", () => {
  const params: Record<string, ParamDecl> = {
    scope: { type: "string", default: "week" },
    limit: { type: "integer", required: true },
    verbose: { type: "boolean", default: false },
    tags: { type: "array" },
  };

  test("按默认值填充，没给的非必填参数没默认值就不出现", () => {
    expect(checkArgs(params, { limit: 3 })).toEqual({
      ok: true,
      args: { scope: "week", limit: 3, verbose: false },
    });
    expect(checkArgs(params, undefined)).toMatchObject({ ok: false });
  });

  test("缺 args 当 {}；错误一次列全：必填缺失、类型不符、未声明的键", () => {
    const r = checkArgs(params, { scop: "day", limit: "3", tags: {} });
    if (r.ok) throw new Error("should fail");
    expect(r.error).toContain('"limit" must be of type integer');
    expect(r.error).toContain('"scop"');
    expect(r.error).toContain('"tags" must be of type array');
    expect(r.error).toContain("allowed: scope, limit, verbose, tags");

    const missing = checkArgs(params, {});
    expect(!missing.ok && missing.error).toContain('"limit" is required');

    const notObject = checkArgs(params, [1]);
    expect(!notObject.ok && notObject.error).toContain("must be an object");
  });

  test("number 要有限数，integer 要整数，object 不含数组与 null", () => {
    const p: Record<string, ParamDecl> = {
      n: { type: "number" },
      o: { type: "object" },
    };
    expect(checkArgs(p, { n: 1.5, o: { a: 1 } })).toMatchObject({ ok: true });
    expect(checkArgs(p, { n: Number.NaN })).toMatchObject({ ok: false });
    expect(checkArgs(p, { n: Number.POSITIVE_INFINITY })).toMatchObject({
      ok: false,
    });
    expect(checkArgs(p, { n: 1.5, o: [] })).toMatchObject({ ok: false });
    expect(checkArgs(p, { n: 1.5, o: null })).toMatchObject({ ok: false });
  });

  test("没声明 params：args 原样透传", () => {
    expect(checkArgs({}, [1, 2])).toEqual({ ok: true, args: [1, 2] });
    expect(checkArgs({}, undefined)).toEqual({ ok: true, args: undefined });
  });
});

describe("两层目录", () => {
  let root: string;
  let globalDir: string;
  let projectDir: string;
  const env = new LocalEnv();
  const write = (dir: string, name: string, text: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${name}.js`), text);
  };
  const named = (project: string | null) =>
    new NamedWorkflows({
      globalDir,
      project: () => (project === null ? null : { env, path: project }),
    });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "yuanshu-named-"));
    globalDir = path.join(root, "ys", "workflows");
    projectDir = path.join(root, "proj");
    mkdirSync(projectDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("目录不存在等于空；名称不合法的文件被忽略", async () => {
    expect(await named(projectDir).list("s")).toEqual({
      entries: [],
      invalid: [],
    });
    write(globalDir, "Upper", meta(`{"description":"x"}`));
    write(globalDir, "../escape", meta(`{"description":"x"}`));
    write(globalDir, "good-one", meta(`{"description":"好的"}`));
    const { entries, invalid } = await named(projectDir).list("s");
    expect(entries.map((e) => e.name)).toEqual(["good-one"]);
    expect(invalid).toEqual([]);
  });

  test("项目层覆盖全局层，被覆盖的全局那条不列", async () => {
    write(globalDir, "review", meta(`{"description":"global"}`));
    write(globalDir, "only-global", meta(`{"description":"g2"}`));
    write(
      path.join(projectDir, ".ys", "workflows"),
      "review",
      meta(`{"description":"project"}`),
    );
    const w = named(projectDir);
    const { entries } = await w.list("s");
    expect(entries.map((e) => [e.name, e.layer, e.meta.description])).toEqual([
      ["only-global", "global", "g2"],
      ["review", "project", "project"],
    ]);
    const r = await w.resolveRun("s", "review", undefined);
    expect(r).toMatchObject({ ok: true, layer: "project" });
  });

  test("无效文件在列表里带原因，resolve 报同一条原因", async () => {
    write(globalDir, "broken", '{"description":"x"}');
    const w = named(projectDir);
    const { entries, invalid } = await w.list("s");
    expect(entries).toEqual([]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.name).toBe("broken");
    const r = await w.resolve("s", "broken");
    expect(r.kind).toBe("invalid");
    expect(r.kind === "invalid" && r.error).toBe(invalid[0]?.error);
    expect(await w.resolveRun("s", "broken", {})).toMatchObject({
      ok: false,
      error: invalid[0]?.error,
    });
  });

  test("不存在的名称报错并列出可用的名称", async () => {
    write(globalDir, "alpha", meta(`{"description":"a"}`));
    const r = await named(projectDir).resolveRun("s", "beta", undefined);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("alpha");
  });

  test("路径穿越式名称被拒，不去找文件", async () => {
    write(root, "secret", meta(`{"description":"x"}`));
    const w = named(projectDir);
    for (const name of ["../secret", "a/b", "/etc/passwd", "Upper"]) {
      expect(NAME_RE.test(name)).toBe(false);
      expect(await w.resolve("s", name)).toMatchObject({ kind: "invalid" });
    }
    expect(await w.list("s")).toMatchObject({ entries: [], invalid: [] });
  });
});
