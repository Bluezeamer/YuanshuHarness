// 只读白名单的表驱动补充测试：对照 Codex 清单补入的命令与被拒参数（见 bash.ts 顶部署名）。
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import {
  analyzeCommand,
  isReadOnlyCommand,
  normalizeCommand,
  operandsInside,
} from "./bash.js";
import { isSensitive } from "./paths.js";

describe("Codex 清单：补入的只读命令", () => {
  test.each([
    "expr 1 + 2",
    "paste a.txt b.txt",
    "rev a.txt",
    "seq 1 10",
    "base64 a.txt",
    "base64 -d a.b64",
    "git branch",
    "git rev-parse HEAD",
    "git ls-files",
    "git branch --show-current",
    "git branch -a -v",
    "git branch --list",
    "git branch '--format=%(refname)'",
    "rg foo -n",
    'rg -g"*.py" foo',
    "find . -name file.txt",
    "sed -n 10p a.txt",
    "nl -nrz Cargo.toml",
    ...(process.platform === "linux" ? ["numfmt 1000", "tac a.txt"] : []),
  ])("放行 %s", async (c) => {
    expect(await isReadOnlyCommand(c)).toBe(true);
  });

  test.each([
    // base64 写文件
    "base64 -o out.bin a",
    "base64 --output out.bin a",
    "base64 --output=out.bin a",
    "base64 -ob64.txt a",
    // git 白名单收窄：只留 rev-parse/ls-files/branch，status/diff/log/show/blame 取消
    "git status",
    "git log",
    "git diff",
    "git show",
    "git blame",
    // git branch 改分支
    "git branch -d feature",
    "git branch -D feature",
    "git branch -m old new",
    "git branch -c old new",
    "git branch --set-upstream-to=origin/x",
    "git branch --delete x",
    "git branch --list foo",
    "git branch newbranch",
    // git 外部程序/写文件
    "git diff --ext-diff",
    "git diff --textconv",
    "git show --output=x",
    "git log --exec=sh",
    "git --exec-path=/x log",
    "git -C /tmp log",
    "git --git-dir=/x log",
    "git --paginate log",
    "git -p log",
    "git --work-tree=/x status",
    // rg 外部程序
    "rg --pre sh x",
    "rg --pre=sh x",
    "rg --hostname-bin sh x",
    "rg --hostname-bin=sh x",
    "rg --search-zip x",
    "rg -z x",
    "rg -nz x",
    // find
    "find . -ok rm {} ;",
    "find . -execdir sh {} ;",
    "find . -okdir sh {} ;",
    "find . -fls /etc/x",
    "find . -fprint /etc/x",
    "find . -fprint0 /etc/x",
    "find . -fprintf /x %p",
    // sed 形式
    "sed -n xp a.txt",
    "sed -n 1,2,3p a.txt",
    "sed -n 1,5p a.txt b.txt",
    "sed 1p a.txt",
    // 本项目额外命令的危险参数
    "sort --compress-program=sh a",
    "sort --output=x a",
    "date -s 2020-01-01",
    "date --set=2020-01-01",
    // 未知命令
    "cargo check",
    "numfmt_x 1",
  ])("不放行 %s", async (c) => {
    expect(await isReadOnlyCommand(c)).toBe(false);
  });
});

describe("解析：字面词规则（对照 Codex is_literal_word_or_number）", () => {
  test.each([
    ["通配符", "ls *.ts"],
    ["问号", "ls a?"],
    ["花括号", "echo {a,b}"],
    ["波浪线", "ls ~"],
    ["等号开头（zsh 展开）", "ls =ls"],
    ["方括号", "ls [ab]"],
    ["脱字符", "ls ^a"],
    ["拼接内含变量", "ls a$HOME"],
    ["拼接内含裸通配", "rg -g*.py foo"],
    ["引号内转义", 'echo "a\\$b"'],
  ])("只读判定不放行：%s", async (_n, c) => {
    expect(await isReadOnlyCommand(c)).toBe(false);
  });

  test("带引号的通配符与拼接仍放行", async () => {
    expect(await isReadOnlyCommand("ls '*.ts'")).toBe(true);
    expect(await isReadOnlyCommand('ls "a b"')).toBe(true);
  });

  test("非只读场景（规则/记住）不受 strict 影响，且支持拼接", async () => {
    expect(await normalizeCommand("npm   run  *.ts")).toBe("npm run '*.ts'");
    expect(await normalizeCommand('rg -g"*.py" foo')).toBe("rg '-g*.py' foo");
  });
});

describe("uniq 第二个位置参数是输出文件", () => {
  test("单个输入参数放行，带输出参数不放行", async () => {
    expect(await isReadOnlyCommand("uniq a.txt")).toBe(true);
    expect(await isReadOnlyCommand("uniq -c a.txt")).toBe(true);
    expect(await isReadOnlyCommand("uniq a.txt /tmp/out.txt")).toBe(false);
    expect(await isReadOnlyCommand("uniq -c a.txt out.txt")).toBe(false);
  });
});

describe("通配符敏感词（保守判定）", () => {
  test.each([
    ".env*",
    ".en?",
    ".e[n]v",
    ".{env,x}",
    "sub/.ssh*/x",
    "*.pem",
    "id_r*",
    "id_rs?",
    ".env.x*",
    ".*",
  ])("%s 视为敏感", (w) => {
    expect(isSensitive(w)).toBe(true);
  });

  test.each(["*.md", "src/*.ts", "-g*.py", "a?"])("%s 不误判", (w) => {
    expect(isSensitive(w)).toBe(false);
  });
});

describe("shell 包装递归解析一层", () => {
  test.each([
    ["bash -c 'cat .env'", true, false],
    ["sh -c 'cat .env'", true, false],
    ["bash -lc 'cat .ssh/id_rsa'", true, false],
    ['eval "cat .env"', true, false],
    ["eval cat .env", true, false],
    ["bash -c 'ls .env*'", true, false],
    ["bash -c 'ls'", false, false],
    // 无法分析：变量展开、嵌套包装、无 -c 的脚本文件
    ["bash -c 'cat $F'", false, true],
    ["bash -c 'sh -c ls'", false, true],
    ["bash x.sh", false, true],
    ["eval $X", false, true],
    // 外层本身解析失败但含包装
    ["bash -c 'cat .env' > /dev/null", true, true],
  ])("%s", async (line, sensitive, opaque) => {
    const r = await analyzeCommand(line);
    expect(r.words.some(isSensitive)).toBe(sensitive);
    expect(r.opaque).toBe(opaque);
  });

  test("普通命令不是 opaque", async () => {
    expect((await analyzeCommand("npm test")).opaque).toBe(false);
    expect((await analyzeCommand("ls > out")).opaque).toBe(false);
  });
});

describe("评审 R2：printenv、sort 临时目录", () => {
  test("printenv 不在只读白名单（会泄露环境里的令牌）", async () => {
    expect(await isReadOnlyCommand("printenv")).toBe(false);
    expect(await isReadOnlyCommand("printenv YUANSHU_TOKEN")).toBe(false);
  });

  test.each([
    "sort -T /tmp a",
    "sort -T/tmp a",
    "sort -uT /tmp a",
    "sort -rnT /tmp a",
    "sort --temporary-directory=/tmp a",
    "sort --temporary-directory /tmp a",
    "sort --temp=/tmp a",
    "sort --tem=/tmp a",
    "sort --out=x a",
    "sort --compress-p=sh a",
  ])("sort 拒绝 %s", async (c) => {
    expect(await isReadOnlyCommand(c)).toBe(false);
  });

  test.each(["sort a.txt", "sort -u -r a.txt", "sort -n a"])(
    "sort 普通用法仍放行 %s",
    async (c) => {
      expect(await isReadOnlyCommand(c)).toBe(true);
    },
  );
});

describe("评审 R2：选项附值的敏感检查", () => {
  test.each([
    "grep --file=.env x",
    "grep -f.env x",
    "grep -nf.env x",
    "grep --file=a.txt,.env x",
    "grep --exclude-from=x:.ssh x",
    "dd if=.env",
    "cat --x=id_rsa",
    "grep -f.ssh/id_rsa x",
    "grep -fID_RSA x",
  ])("%s 视为敏感", async (c) => {
    const r = await analyzeCommand(c);
    expect(r.words.some(isSensitive)).toBe(true);
  });

  test.each(["grep -rn foo src", "ls -la", "grep --color=always x a.txt"])(
    "%s 不误判",
    async (c) => {
      const r = await analyzeCommand(c);
      expect(r.words.some(isSensitive)).toBe(false);
    },
  );
});

describe("评审 R2：operandsInside 的路径操作数", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-ops-")));
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));
  test.each([
    ["ls", true],
    ["cat a/b.txt", true],
    ["cat ../x", false],
    ["cat /etc/hosts", false],
    ["ls --files0-from=/x", false],
    ["ls -la && cat ../x", false],
    ["cat a\nb", false],
  ])("%s -> %s", async (c, ok) => {
    expect((await operandsInside(c, cwd, new LocalEnv())).inside).toBe(ok);
  });

  // 评审 M1#1：resolved 是解析符号链接后的真实路径，选项内嵌的值能解析就收集
  test("resolved：链接解析为真实路径，选项内嵌值也收集", async () => {
    writeFileSync(path.join(cwd, ".env"), "X=1");
    symlinkSync(path.join(cwd, ".env"), path.join(cwd, "public"));
    const env = new LocalEnv();
    const want = path.join(cwd, ".env");
    for (const c of [
      "cat public",
      "grep -f public x",
      "grep -fpublic x",
      "grep --file=public x",
      "dd if=public",
    ])
      expect((await operandsInside(c, cwd, env)).resolved, c).toContain(want);
    // 出界时 resolved 仍收集
    const out = await operandsInside("cat public ../x", cwd, env);
    expect(out.inside).toBe(false);
    expect(out.resolved).toContain(want);
  });
});
