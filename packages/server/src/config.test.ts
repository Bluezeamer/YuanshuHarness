import { describe, expect, test } from "vitest";
import { parseConfig } from "./config.js";

const HOME = "/home/u";
const CWD = "/work/dir";
const parse = (argv: string[], env: Record<string, string> = {}) =>
  parseConfig(argv, env, HOME, CWD);

describe("子命令（R1）", () => {
  test("裸命令是用法错误", () => {
    expect(parse([])).toMatchObject({ kind: "error" });
  });

  test("未知子命令是用法错误，并点名", () => {
    const r = parse(["start"]);
    expect(r).toMatchObject({ kind: "error" });
    expect(r.kind === "error" && r.message).toContain("start");
  });

  test.each([["--help"], ["-h"], ["serve", "--help"], ["serve", "-h"]])(
    "%s 是帮助",
    (...argv) => {
      expect(parse(argv)).toEqual({ kind: "help" });
    },
  );

  test("serve 返回配置", () => {
    expect(parse(["serve"])).toMatchObject({ kind: "serve" });
  });
});

describe("默认值（R2）", () => {
  test("host、port、数据目录", () => {
    expect(parse(["serve"])).toEqual({
      kind: "serve",
      config: { host: "127.0.0.1", port: 7420, dataDir: "/home/u/.yuanshu" },
    });
  });
});

describe("优先级：命令行 > 环境变量 > 默认值（R2）", () => {
  test("只有环境变量时取环境变量", () => {
    expect(
      parse(["serve"], {
        YUANSHU_HOST: "0.0.0.0",
        YUANSHU_PORT: "9000",
        YUANSHU_DATA_DIR: "/data",
      }),
    ).toEqual({
      kind: "serve",
      config: { host: "0.0.0.0", port: 9000, dataDir: "/data" },
    });
  });

  test("命令行覆盖环境变量", () => {
    expect(
      parse(["serve", "--host", "::1", "--port", "81", "--data-dir", "/cli"], {
        YUANSHU_HOST: "0.0.0.0",
        YUANSHU_PORT: "9000",
        YUANSHU_DATA_DIR: "/data",
      }),
    ).toEqual({
      kind: "serve",
      config: { host: "::1", port: 81, dataDir: "/cli" },
    });
  });

  test("支持 --opt=value 写法", () => {
    expect(parse(["serve", "--port=8080"])).toMatchObject({
      config: { port: 8080 },
    });
  });
});

describe("数据目录路径（R2）", () => {
  test("相对路径按当前工作目录转为绝对路径", () => {
    expect(parse(["serve", "--data-dir", "rel/x"])).toMatchObject({
      config: { dataDir: "/work/dir/rel/x" },
    });
  });

  test("环境变量里的相对路径同样转换", () => {
    expect(parse(["serve"], { YUANSHU_DATA_DIR: "rel" })).toMatchObject({
      config: { dataDir: "/work/dir/rel" },
    });
  });

  test("绝对路径被规范化", () => {
    expect(parse(["serve", "--data-dir", "/a/b/../c/"])).toMatchObject({
      config: { dataDir: "/a/c" },
    });
  });
});

describe("非法输入一律报错（R2）", () => {
  test.each([
    ["空 host", ["serve", "--host", ""], {}],
    ["空 port", ["serve", "--port", ""], {}],
    ["空 data-dir", ["serve", "--data-dir", ""], {}],
    ["端口 0", ["serve", "--port", "0"], {}],
    ["端口 70000", ["serve", "--port", "70000"], {}],
    ["端口 80abc", ["serve", "--port", "80abc"], {}],
    ["端口 -1", ["serve", "--port=-1"], {}],
    ["端口 1.5", ["serve", "--port", "1.5"], {}],
    ["端口 0x50", ["serve", "--port", "0x50"], {}],
    ["端口含空格", ["serve", "--port", " 80"], {}],
    ["未知选项（拼错）", ["serve", "--prot", "80"], {}],
    ["未实现的 --token", ["serve", "--token", "x"], {}],
    ["选项缺值", ["serve", "--host"], {}],
    ["多余的位置参数", ["serve", "extra"], {}],
    ["环境变量端口非法", ["serve"], { YUANSHU_PORT: "abc" }],
    ["环境变量 host 为空", ["serve"], { YUANSHU_HOST: "" }],
    ["环境变量数据目录为空", ["serve"], { YUANSHU_DATA_DIR: "" }],
    ["未知的 YUANSHU_ 环境变量", ["serve"], { YUANSHU_PROT: "80" }],
    ["未实现的 YUANSHU_TOKEN", ["serve"], { YUANSHU_TOKEN: "x" }],
  ])("%s", (_name, argv, env) => {
    expect(parse(argv, env)).toMatchObject({ kind: "error" });
  });

  test("环境变量非法时，即使被命令行覆盖也报错", () => {
    expect(
      parse(["serve", "--port", "80"], { YUANSHU_PORT: "abc" }),
    ).toMatchObject({ kind: "error" });
  });

  test("错误信息指明是哪一项", () => {
    const flag = parse(["serve", "--port", "70000"]);
    expect(flag.kind === "error" && flag.message).toContain("--port");
    const envErr = parse(["serve"], { YUANSHU_PORT: "abc" });
    expect(envErr.kind === "error" && envErr.message).toContain("YUANSHU_PORT");
    const unknown = parse(["serve"], { YUANSHU_PROT: "80" });
    expect(unknown.kind === "error" && unknown.message).toContain(
      "YUANSHU_PROT",
    );
  });

  test("不带 YUANSHU_ 前缀的无关环境变量被忽略", () => {
    expect(
      parse(["serve"], { PATH: "/bin", HOST: "x", PORT: "abc" }),
    ).toMatchObject({ kind: "serve" });
  });

  test("端口边界 1 与 65535 合法", () => {
    expect(parse(["serve", "--port", "1"])).toMatchObject({
      config: { port: 1 },
    });
    expect(parse(["serve", "--port", "65535"])).toMatchObject({
      config: { port: 65535 },
    });
  });
});
