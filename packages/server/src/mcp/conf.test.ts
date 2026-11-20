// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 测试里要写 ${VAR} 与 ${secret:id} 这类字面量
import { describe, expect, test } from "vitest";
import { DEFAULT_OPTIONS, type McpServerMeta, nameKey } from "../store/mcp.js";
import { parseMcpJson, toConf } from "./conf.js";

const deps = (existing: string[] = [], secrets: string[] = []) => ({
  secretExists: (id: string) => secrets.includes(id),
  conflict: (n: string) => existing.find((e) => nameKey(e) === nameKey(n)),
});

const one = (entry: unknown, name = "x") => ({ mcpServers: { [name]: entry } });
const parse = (v: unknown, d = deps()) => parseMcpJson(v, d);
const codes = (v: unknown, d = deps()) =>
  parse(v, d)
    .diagnostics.filter((x) => x.level === "error")
    .map((x) => x.code);

describe("mcpServers JSON 校验", () => {
  test("合法 stdio / http：返回草稿与预览", () => {
    const a = parse(
      one(
        {
          command: "npx",
          args: ["-y", "@acme/notes-mcp"],
          env: { DB: "${NOTES_DB}" },
          exposure: "hidden",
          timeout: 30,
        },
        "notes",
      ),
    );
    expect(a.ok).toBe(true);
    expect(a.draft).toMatchObject({
      name: "notes",
      config: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@acme/notes-mcp"],
        env: [{ key: "DB", value: "${NOTES_DB}" }],
      },
      options: { enabled: true, exposure: "hidden", timeout: 30 },
      preview: {
        transport: "stdio",
        target: "npx -y @acme/notes-mcp",
        envCount: 1,
        headerCount: 0,
      },
    });
    const b = parse(
      one({ url: "https://docs.example.com/mcp", headers: { A: "b" } }, "docs"),
    );
    expect(b.draft).toMatchObject({
      config: { transport: "http", url: "https://docs.example.com/mcp" },
      options: { exposure: "direct", enabled: true },
      preview: { transport: "http", headerCount: 1 },
    });
  });

  test("JSON 文本：解析失败、空、非对象", () => {
    expect(codes("{")).toEqual(["invalid_json"]);
    expect(codes("  ")).toEqual(["empty"]);
    expect(codes("[]")).toEqual(["not_object"]);
    expect(parse(JSON.stringify(one({ command: "npx" }))).ok).toBe(true);
  });

  test("顶层必须有 mcpServers，且一次一条", () => {
    expect(codes({ x: {} })).toEqual(["no_mcp_servers"]);
    expect(codes({ mcpServers: {} })).toEqual(["not_single"]);
    expect(
      codes({ mcpServers: { a: { command: "x" }, b: { command: "y" } } }),
    ).toEqual(["not_single"]);
  });

  test("名称文法：^[A-Za-z0-9_-]{1,32}$", () => {
    for (const n of ["my.srv", "a b", "x".repeat(33)])
      expect(codes(one({ command: "npx" }, n))).toContain("invalid_name");
    for (const n of ["a", "_x", "-x", "x".repeat(32), "My-Srv_2"])
      expect(parse(one({ command: "npx" }, n)).ok).toBe(true);
  });

  test("重名：- 与 _ 视为相同、不分大小写；编辑自己不算重名", () => {
    const d = deps(["my-srv"]);
    for (const n of ["my_srv", "MY-SRV", "My_Srv", "my-srv"])
      expect(codes(one({ command: "npx" }, n), d)).toEqual(["name_exists"]);
    expect(parse(one({ command: "npx" }, "other"), d).ok).toBe(true);
    // 编辑：调用方把自己排除在 conflict 之外
    expect(
      parse(one({ command: "npx" }, "my-srv"), {
        ...d,
        conflict: () => undefined,
      }).ok,
    ).toBe(true);
  });

  test("拒绝 sse；type 只能是 stdio / http / streamable-http，且要与 command/url 一致", () => {
    expect(codes(one({ type: "sse", url: "https://a.example/mcp" }))).toEqual([
      "sse",
    ]);
    expect(codes(one({ type: "ws", command: "x" }))).toEqual(["invalid_type"]);
    expect(codes(one({ type: "http", command: "x" }))).toEqual([
      "type_mismatch",
    ]);
    expect(codes(one({ type: "stdio", url: "https://a.example" }))).toEqual([
      "type_mismatch",
    ]);
    expect(
      parse(one({ type: "streamable-http", url: "https://a.example/mcp" })).ok,
    ).toBe(true);
  });

  test("command 与 url 二选一", () => {
    expect(codes(one({}))).toEqual(["no_command_url"]);
    expect(codes(one({ command: "x", url: "https://a.example" }))).toEqual([
      "both_command_url",
    ]);
  });

  test("command 不能含空格（参数进 args）", () => {
    expect(codes(one({ command: "npx -y foo" }))).toEqual([
      "command_has_space",
    ]);
    expect(codes(one({ command: "" }))).toEqual(["invalid_command"]);
    expect(codes(one({ command: 1 }))).toEqual(["invalid_command"]);
  });

  test("args 须为字符串数组；env / headers 值须为字符串", () => {
    expect(codes(one({ command: "x", args: "-y" }))).toEqual(["invalid_args"]);
    expect(codes(one({ command: "x", args: [1] }))).toEqual(["invalid_args"]);
    expect(codes(one({ command: "x", env: { A: 1 } }))).toEqual([
      "invalid_map",
    ]);
    expect(codes(one({ command: "x", env: ["A"] }))).toEqual(["invalid_map"]);
    expect(codes(one({ url: "https://a.example", headers: { A: 1 } }))).toEqual(
      ["invalid_map"],
    );
  });

  test("headers 只用于 http；cwd / args 只用于 stdio", () => {
    expect(codes(one({ command: "x", headers: { A: "b" } }))).toEqual([
      "headers_on_stdio",
    ]);
    expect(codes(one({ url: "https://a.example", args: ["x"] }))).toEqual([
      "stdio_only",
    ]);
    expect(codes(one({ url: "https://a.example", cwd: "/tmp" }))).toEqual([
      "stdio_only",
    ]);
    expect(
      parse(one({ command: "x", cwd: "/tmp" })).draft?.config,
    ).toMatchObject({ cwd: "/tmp" });
  });

  test("url 须 http(s)", () => {
    expect(codes(one({ url: "ftp://a.example" }))).toEqual(["invalid_url"]);
    expect(codes(one({ url: "docs.example.com/mcp" }))).toEqual([
      "invalid_url",
    ]);
  });

  test("timeout 须为正数；enabled 须为布尔；exposure 限四值", () => {
    for (const t of [0, -1, "30", Number.NaN])
      expect(codes(one({ command: "x", timeout: t }))).toEqual([
        "invalid_timeout",
      ]);
    expect(codes(one({ command: "x", enabled: "yes" }))).toEqual([
      "invalid_enabled",
    ]);
    expect(codes(one({ command: "x", exposure: "visible" }))).toEqual([
      "invalid_exposure",
    ]);
    for (const x of ["direct", "hidden"])
      expect(parse(one({ command: "x", exposure: x })).ok).toBe(true);
    // 旧写法不再接受，报错里说明原因
    for (const x of ["codemode", "deferred"]) {
      const r = parse(one({ command: "x", exposure: x }));
      expect(r.ok).toBe(false);
      expect(
        r.diagnostics.find((d) => d.code === "invalid_exposure")?.message,
      ).toContain("已不支持");
    }
    expect(
      parse(one({ command: "x", enabled: false })).draft?.options,
    ).toMatchObject({ enabled: false });
  });

  test("toolExposure：按工具覆盖，值同样限四值", () => {
    expect(
      parse(one({ command: "x", toolExposure: { a: "hidden" } })).draft?.options
        .toolExposure,
    ).toEqual({ a: "hidden" });
    expect(codes(one({ command: "x", toolExposure: { a: "nope" } }))).toEqual([
      "invalid_tool_exposure",
    ]);
    expect(codes(one({ command: "x", toolExposure: [] }))).toEqual([
      "invalid_tool_exposure",
    ]);
  });

  test("未知键只提示，不阻止；description 手填被忽略并提示", () => {
    const r = parse(one({ command: "x", foo: 1, description: "手写" }));
    expect(r.ok).toBe(true);
    expect(r.diagnostics.map((d) => [d.level, d.code])).toEqual([
      ["warning", "description_ignored"],
      ["warning", "unknown_key"],
    ]);
    expect(JSON.stringify(r.draft)).not.toContain("手写");
  });

  test("一次报出所有问题，而不是第一个就停", () => {
    expect(
      codes(
        one({
          command: "npx -y",
          env: { A: 1 },
          timeout: -1,
          exposure: "x",
        }),
      ).sort(),
    ).toEqual(
      [
        "command_has_space",
        "invalid_exposure",
        "invalid_map",
        "invalid_timeout",
      ].sort(),
    );
  });

  test("密码库引用写成 ${secret:id}：必须存在，前缀保留", () => {
    const e = {
      url: "https://a.example/mcp",
      headers: { Authorization: "Bearer ${secret:s1}" },
    };
    expect(codes(one(e))).toEqual(["unknown_secret"]);
    expect(parse(one(e), deps([], ["s1"])).draft?.config).toMatchObject({
      headers: [{ key: "Authorization", secretId: "s1", prefix: "Bearer " }],
    });
  });
});

describe("toConf 回显", () => {
  const meta = (over: Partial<McpServerMeta>): McpServerMeta => ({
    ...DEFAULT_OPTIONS,
    name: "x",
    config: { transport: "stdio", command: "npx", args: ["-y", "p"], env: [] },
    tools: null,
    toolsAt: null,
    createdAt: "t",
    updatedAt: "t",
    approval: "ask",
    description: null,
    handshake: null,
    latestVersion: null,
    global: false,
    ...over,
  });

  test("与 JSON 入口同形：往返不丢信息，密码库引用不泄露值", () => {
    const m = meta({
      config: {
        transport: "http",
        url: "https://a.example/mcp",
        headers: [
          { key: "A", value: "v" },
          { key: "Authorization", secretId: "s1", prefix: "Bearer " },
        ],
      },
      exposure: "direct",
      enabled: false,
      timeout: 20,
      toolExposure: { t: "hidden" },
    });
    const conf = toConf(m);
    expect(conf).toEqual({
      url: "https://a.example/mcp",
      headers: { A: "v", Authorization: "Bearer ${secret:s1}" },
      timeout: 20,
      exposure: "direct",
      enabled: false,
      toolExposure: { t: "hidden" },
    });
    const back = parse({ mcpServers: { x: conf } }, deps([], ["s1"]));
    expect(back.draft?.config).toEqual(m.config);
    expect(back.draft?.options).toMatchObject({
      enabled: false,
      exposure: "direct",
      timeout: 20,
    });
  });
});
