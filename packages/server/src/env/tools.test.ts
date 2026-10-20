import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { hasSshd, startSshd, type TestSshd } from "../../test/support/sshd.js";
import { SshConnection } from "../ssh/connection.js";
import { type Db, openDatabase } from "../store/db.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { LocalEnv } from "./local.js";
import { SshEnv } from "./ssh.js";
import { grepScript, routedToolsExtension, type Where } from "./tools.js";
import type { ExecEnv } from "./types.js";

interface Tool {
  name: string;
  execute: (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: object,
  ) => Promise<{ content: { type: string; text?: string }[] }>;
}

async function load(
  where: () => Where,
  variables?: () => ReadonlyMap<string, string>,
) {
  const tools = new Map<string, Tool>();
  await routedToolsExtension(
    where,
    variables,
  )({
    registerTool: (t: Tool) => tools.set(t.name, t),
  } as never);
  return async (name: string, params: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    // bash 工具会向 ctx.sessionManager 取会话信息注入环境变量。
    const ctx = {
      sessionManager: {
        getSessionId: () => "test-session",
        getSessionFile: () => undefined,
      },
    };
    const r = await tool.execute("t", params, undefined, undefined, ctx);
    return r.content.map((c) => c.text ?? "").join("");
  };
}

// 含引号、$、空格、通配符、换行：值不进命令文本，所以都不应破坏命令。
const VALUE = `s3cr3t-"q'$x y*\nz`;
// 逐个读本机所有进程的命令行（不依赖 ps）。
const SCAN_PROCS =
  "for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < $f; echo; done 2>/dev/null";

// 输出会被遮罩，所以不直接回显真值：用字节数证明命令拿到了值，
// 再数进程命令行里出现变量名与真值片段的行数（真值片段应为 0）；
// 片段写成 [t] 是为了不匹配到探测命令自身。
const PROBE = [
  "printf %s @tok | wc -c",
  `out=$(${SCAN_PROCS})`,
  `printf %s "$out" | grep -c 'YUANSHU_VAR_to[k]'`,
  `printf %s "$out" | grep -c 's3cr3[t]-'`,
].join("; ");

// 变量名出现在命令行只对本机成立：ssh 的命令文本不经远端 argv。
function expectInjectedNotInArgv(out: string, nameInArgv: boolean) {
  const [bytes, named, leaked] = out.trim().split("\n").map(Number);
  expect(bytes).toBe(Buffer.byteLength(VALUE));
  if (nameInArgv) expect(named).toBeGreaterThanOrEqual(1);
  expect(leaked).toBe(0);
}

// 记录经过环境原语的调用：本机应为空（走 SDK 原样），ssh 必须有。
function spy(env: ExecEnv) {
  const calls: string[] = [];
  const proxy = new Proxy(env, {
    get(target, key) {
      const v = Reflect.get(target, key);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        calls.push(String(key));
        return v.apply(target, a);
      };
    },
  });
  return { env: proxy, calls };
}

describe("本机环境的工具", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "yuanshu-tools-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("不经过环境原语，行为与 SDK 一致", async () => {
    const s = spy(new LocalEnv());
    const call = await load(() => ({ env: s.env, cwd: dir }));
    await call("write", { path: "a.txt", content: "hi" });
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("hi");
    expect(await call("read", { path: "a.txt" })).toContain("hi");
    expect(await call("bash", { command: "pwd" })).toContain(dir);
    expect(s.calls).toEqual([]);
  });

  test("隐私变量：命令拿到真值，但值不在命令行里，也不留在后续调用的环境", async () => {
    const call = await load(
      () => ({ env: new LocalEnv(), cwd: dir }),
      () => new Map([["tok", VALUE]]),
    );
    expectInjectedNotInArgv(await call("bash", { command: PROBE }), true);
    expect(
      await call("bash", { command: 'printf %s "${YUANSHU_VAR_tok-unset}"' }),
    ).toBe("unset");
  });

  test("隐私变量：命令回显的真值在进入工具结果前换回占位符", async () => {
    const call = await load(
      () => ({ env: new LocalEnv(), cwd: dir }),
      () => new Map([["tok", VALUE]]),
    );
    const out = await call("bash", { command: "printf 'a:%s:b' @tok" });
    expect(out).toBe("a:@tok:b");
    // 命令出错时的错误文本同样不含真值。
    const failed = await call("bash", {
      command: "printf '%s' @tok >&2; exit 3",
    }).catch((e: Error) => e.message);
    expect(failed).not.toContain(VALUE);
    expect(failed).toContain("@tok");
  });

  test("未登记的 @xxx、邮箱、scope 包名原样不动", async () => {
    const call = await load(
      () => ({ env: new LocalEnv(), cwd: dir }),
      () => new Map([["tok", VALUE]]),
    );
    expect(
      await call("bash", { command: "echo a@tok.com @scope/pkg @nope" }),
    ).toBe("a@tok.com @scope/pkg @nope\n");
  });
});

describe.skipIf(!hasSshd)("ssh 环境的工具（真实 sshd）", () => {
  let sshd: TestSshd;
  let dir: string;
  let work: string;
  let db: Db;
  let ssh: SshEnv;
  beforeAll(async () => {
    sshd = await startSshd();
  });
  afterAll(() => sshd.close());

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "yuanshu-tools-"));
    db = openDatabase(dir);
    const secrets = new SecretStore(db, loadMasterKey(dir));
    const key = secrets.create("k", "ssh_key", sshd.privateKey);
    ssh = new SshEnv(
      "tools-test",
      "posix",
      new SshConnection(
        {
          host: "127.0.0.1",
          port: sshd.port,
          username: sshd.user,
          secretId: key?.id ?? null,
        },
        secrets,
      ),
    );
    work = path.join(dir, "work");
    mkdirSync(path.join(work, "sub"), { recursive: true });
    writeFileSync(path.join(work, "x.txt"), "alpha\nneedle\nomega\n");
    writeFileSync(path.join(work, "y.md"), "needle in markdown\n");
    writeFileSync(path.join(work, "sub", "z.txt"), "nothing here\n");
  });
  afterEach(() => {
    ssh.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("bash 经 ssh 执行并在 cwd 内", async () => {
    const s = spy(ssh);
    const call = await load(() => ({ env: s.env, cwd: work }));
    const out = await call("bash", {
      command: 'pwd; echo "conn=$SSH_CONNECTION"',
    });
    expect(out).toContain(work);
    expect(out).toContain("conn=127.0.0.1");
    expect(s.calls).toContain("exec");
  });

  test("write → read → edit 往返，且都走环境原语", async () => {
    const s = spy(ssh);
    const call = await load(() => ({ env: s.env, cwd: work }));
    await call("write", { path: "sub/new.txt", content: "one two" });
    expect(readFileSync(path.join(work, "sub", "new.txt"), "utf8")).toBe(
      "one two",
    );
    expect(await call("read", { path: "sub/new.txt" })).toContain("one two");
    await call("edit", {
      path: "sub/new.txt",
      edits: [{ oldText: "two", newText: "2" }],
    });
    expect(readFileSync(path.join(work, "sub", "new.txt"), "utf8")).toBe(
      "one 2",
    );
    expect(s.calls).toEqual(expect.arrayContaining(["writeFile", "readFile"]));
  });

  test("ls 与 find 列出远程内容", async () => {
    const call = await load(() => ({ env: ssh, cwd: work }));
    const listing = await call("ls", {});
    expect(listing).toContain("x.txt");
    expect(listing).toContain("sub");
    const found = await call("find", { pattern: "*.txt" });
    expect(found).toContain("x.txt");
    expect(found).toContain("z.txt");
    expect(found).not.toContain("y.md");
  });

  test("grep 返回 文件:行号: 内容，glob 过滤生效，无匹配如实说明", async () => {
    const call = await load(() => ({ env: ssh, cwd: work }));
    const hit = await call("grep", { pattern: "needle" });
    expect(hit).toContain("x.txt:2: needle");
    expect(hit).toContain("y.md:1:");
    const onlyTxt = await call("grep", { pattern: "needle", glob: "*.txt" });
    expect(onlyTxt).toContain("x.txt:2:");
    expect(onlyTxt).not.toContain("y.md");
    expect(await call("grep", { pattern: "absent-token-xyz" })).toContain(
      "No matches found",
    );
  });

  // 评审 M1#4：无 .gitignore 时 rg 不会自己排除 node_modules，脚本必须显式排除。
  // 测试机的 sshd 会话里没有 rg 二进制，端到端只走得到 grep 回退；
  // rg 分支用脚本文本断言，其 `-g` 语义已另行用真实 rg 验证。
  test("grep 脚本的 rg 与 grep 两个分支都排除 node_modules", () => {
    const script = grepScript({ pattern: "p" }, "/w", 10);
    const [rgLine, grepLine] = script
      .split("\n")
      .filter((l) => l.startsWith("rg ") || l.startsWith("grep "));
    expect(rgLine).toContain("-g '!node_modules'");
    expect(rgLine).toContain("-g '!.git'");
    expect(grepLine).toContain("--exclude-dir=node_modules");
  });

  test("grep 默认不读 node_modules（无 .gitignore，ssh 端到端）", async () => {
    mkdirSync(path.join(work, "node_modules", "pkg"), { recursive: true });
    writeFileSync(
      path.join(work, "node_modules", "pkg", "id_rsa"),
      "needle-in-deps\n",
    );
    const call = await load(() => ({ env: ssh, cwd: work }));
    expect(await call("grep", { pattern: "needle-in-deps" })).toContain(
      "No matches found",
    );
    // 目录外的正常匹配不受影响
    expect(await call("grep", { pattern: "needle" })).toContain("x.txt:2:");
  });

  test("隐私变量：远端收到真值，远端任何进程的命令行里都没有", async () => {
    const call = await load(
      () => ({ env: ssh, cwd: work }),
      () => new Map([["tok", VALUE]]),
    );
    expectInjectedNotInArgv(await call("bash", { command: PROBE }), false);
    // 没有占位符时仍走原来的命令行路径。
    expect(await call("bash", { command: "echo plain" })).toBe("plain\n");
  });

  test("按调用时的 workspace 路由：同一组工具先 ssh 后本机", async () => {
    const remote = spy(ssh);
    const localSpy = spy(new LocalEnv());
    let current: Where = { env: remote.env, cwd: work };
    const call = await load(() => current);
    await call("read", { path: "x.txt" });
    expect(remote.calls).toContain("readFile");

    const before = remote.calls.length;
    current = { env: localSpy.env, cwd: work };
    expect(await call("read", { path: "x.txt" })).toContain("needle");
    expect(remote.calls.length).toBe(before);
    expect(localSpy.calls).toEqual([]);
  });
});
