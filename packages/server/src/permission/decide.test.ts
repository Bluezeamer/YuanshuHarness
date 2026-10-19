import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  analyzeCommand,
  isReadOnlyCommand,
  normalizeCommand,
  rememberable,
} from "./bash.js";
import { type Action, type Ctx, decide } from "./decide.js";
import { isInside, isSensitive, resolveTarget } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "yuanshu-perm-"));
const cwd = path.join(root, "proj");
const outside = path.join(root, "outside");
mkdirSync(cwd);
mkdirSync(outside);
writeFileSync(path.join(outside, "secret.txt"), "x");
symlinkSync(outside, path.join(cwd, "link"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  tier: "rules",
  cwd,
  pathRules: [],
  commandRules: [],
  ...over,
});
const target = (p: string) => {
  const r = resolveTarget(p, cwd) as string;
  return { path: r, dir: path.dirname(r) };
};
const pathAct = (p: string, access: "read" | "write" = "read"): Action => ({
  kind: "path",
  access,
  targets: [target(p)],
});
const cmdAct = async (line: string): Promise<Action> => {
  const a = await analyzeCommand(line);
  return {
    kind: "command",
    line,
    words: a.words,
    opaque: a.opaque,
    readOnly: await isReadOnlyCommand(line),
    normalized: await normalizeCommand(line),
    rememberable: await rememberable(line),
    sudo: a.words.includes("sudo"),
  };
};

describe("R3 路径判定", () => {
  test.each([
    ["cwd 内相对路径", "a/b.txt", "allow"],
    ["cwd 内尚不存在的深层路径", "x/y/z.txt", "allow"],
    ["cwd 外绝对路径", path.join(outside, "secret.txt"), "ask"],
    ["用 .. 逃出 cwd", "../outside/secret.txt", "ask"],
    ["符号链接逃出 cwd", "link/secret.txt", "ask"],
    ["符号链接下尚不存在的文件", "link/new.txt", "ask"],
  ])("%s", (_n, p, want) => {
    expect(decide(pathAct(p), ctx()).verdict).toBe(want);
  });

  test("full 放行一切，含敏感路径", () => {
    expect(decide(pathAct("/etc/passwd"), ctx({ tier: "full" })).verdict).toBe(
      "allow",
    );
    expect(decide(pathAct(".env"), ctx({ tier: "full" })).verdict).toBe(
      "allow",
    );
  });

  test("isInside 不把同前缀兄弟目录当作内部", () => {
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
  });
});

describe("R4 敏感路径", () => {
  test.each([
    ".env",
    ".env.local",
    "sub/.ssh/id",
    "a/.aws/credentials",
    "k/.kube/config",
    ".gnupg/x",
    ".npmrc",
    ".netrc",
    "id_rsa",
    "id_ed25519.pub",
    "c.pem",
    "c.key",
  ])("%s 在 cwd 内也要问且不可记住", (p) => {
    const d = decide(pathAct(p, "write"), ctx());
    expect(d).toEqual({ verdict: "ask", remember: null, reviewable: false });
  });

  test("已记住的目录规则不放行敏感路径", () => {
    const d = decide(
      pathAct(".env"),
      ctx({ pathRules: [{ access: "write", value: cwd }] }),
    );
    expect(d.verdict).toBe("ask");
  });

  test("普通文件名不误判", () => {
    expect(isSensitive("env.ts")).toBe(false);
    expect(isSensitive("monkey.txt")).toBe(false);
  });

  test("命令里的敏感词同样要问，即使整条是只读命令或已记住", async () => {
    const a = await cmdAct("cat .env");
    expect(a.kind === "command" && a.readOnly).toBe(true);
    expect(decide(a, ctx()).verdict).toBe("ask");
    const b = await cmdAct("cp x ~/.ssh/id_rsa");
    expect(decide(b, ctx({ commandRules: ["cp x ~/.ssh/id_rsa"] }))).toEqual({
      verdict: "ask",
      remember: null,
      reviewable: false,
    });
  });
});

describe("R4 敏感命令变体", () => {
  test.each([
    "cat .env*",
    "bash -c 'cat .env'",
    'eval "cat .env"',
    "sh -c 'cat .ssh/id_rsa'",
  ])("%s：ask、不可记住、不交审核", async (c) => {
    expect(decide(await cmdAct(c), ctx())).toEqual({
      verdict: "ask",
      remember: null,
      reviewable: false,
    });
  });

  test("无法分析的 shell 包装：不放行、不可记住", async () => {
    expect(decide(await cmdAct("bash -c 'cat $F'"), ctx())).toEqual({
      verdict: "ask",
      remember: null,
      reviewable: false,
    });
  });
});

describe("R6 记住规则", () => {
  const f = path.join(outside, "secret.txt");
  test("读规则只放行读，写规则放行读写", () => {
    const read = ctx({ pathRules: [{ access: "read", value: outside }] });
    const write = ctx({ pathRules: [{ access: "write", value: outside }] });
    expect(decide(pathAct(f, "read"), read).verdict).toBe("allow");
    expect(decide(pathAct(f, "write"), read).verdict).toBe("ask");
    expect(decide(pathAct(f, "read"), write).verdict).toBe("allow");
    expect(decide(pathAct(f, "write"), write).verdict).toBe("allow");
  });

  test("路径动作记住目标所在目录", () => {
    const d = decide(pathAct(f, "write"), ctx());
    expect(d).toMatchObject({
      verdict: "ask",
      remember: { kind: "path", access: "write", value: outside },
    });
  });

  test("命令规则仅完全相等", async () => {
    const c = ctx({ commandRules: ["npm test"] });
    expect(decide(await cmdAct("npm test"), c).verdict).toBe("allow");
    expect(decide(await cmdAct("npm   test"), c).verdict).toBe("allow");
    expect(decide(await cmdAct("npm test && rm -rf x"), c).verdict).toBe("ask");
    expect(decide(await cmdAct("npm test -u"), c).verdict).toBe("ask");
  });
});

describe("R5 只读白名单", () => {
  test.each([
    "ls -la",
    "cat a.txt | head -n 5",
    "git rev-parse HEAD && git ls-files",
    "git branch --show-current; pwd",
    "find . -name '*.ts'",
    "rg foo src",
    "sed -n 1,5p a.txt",
    'echo "hello world"',
  ])("放行 %s", async (c) => {
    expect(await isReadOnlyCommand(c)).toBe(true);
  });

  test.each([
    ["重定向", "echo x > f"],
    ["追加重定向", "echo x >> f"],
    ["命令替换", "echo $(whoami)"],
    ["反引号", "echo `whoami`"],
    ["变量展开", "echo $HOME"],
    ["双引号内展开", 'echo "$HOME"'],
    ["子 shell", "(ls)"],
    ["后台符", "ls &"],
    ["换行", "ls\nrm -rf x"],
    ["find -exec", "find . -exec rm {} ;"],
    ["find -delete", "find . -delete"],
    ["git --output", "git diff --output=x"],
    ["git -c", "git -c core.pager=sh log"],
    ["git branch 创建", "git branch newbranch"],
    ["git push", "git push"],
    ["sort -o", "sort -o out in"],
    ["sed -i", "sed -i s/a/b/ f"],
    ["rg --pre", "rg --pre=sh x"],
    ["未知命令", "rm -rf x"],
    ["语法错误", "ls &&"],
    ["空", ""],
    ["转义", "ls a\\ b"],
    ["管道接危险命令", "ls | sh"],
    ["here-doc", "cat <<EOF"],
  ])("不放行：%s", async (_n, c) => {
    expect(await isReadOnlyCommand(c)).toBe(false);
  });
});

describe("R7 不可记住", () => {
  test.each([
    "bash -c ls",
    "sh x.sh",
    "env FOO=1 ls",
    "sudo ls",
    "ls && sudo rm x",
    "eval x",
    "xargs rm",
    "nohup x",
    "echo $(x)",
    "ls &&",
  ])("%s", async (c) => {
    expect(await rememberable(c)).toBe(false);
  });
  test("普通命令可记住并规范化", async () => {
    expect(await rememberable("npm   test")).toBe(true);
    expect(await normalizeCommand("npm   test  &&  ls")).toBe("npm test && ls");
    expect(await normalizeCommand("echo 'a b'")).toBe("echo 'a b'");
    expect(await normalizeCommand("echo $x")).toBeNull();
  });
});

describe("decide 其余", () => {
  test("命令规则外：可记住时附规则，sudo 不可审核", async () => {
    expect(decide(await cmdAct("npm test"), ctx())).toEqual({
      verdict: "ask",
      remember: { kind: "command", access: null, value: "npm test" },
      reviewable: true,
    });
    expect(decide(await cmdAct("sudo ls"), ctx())).toEqual({
      verdict: "ask",
      remember: null,
      reviewable: false,
    });
  });
});
