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
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { SshConnection } from "../ssh/connection.js";
import { type Db, openDatabase } from "../store/db.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { LocalEnv } from "./local.js";
import { SshEnv } from "./ssh.js";
import {
  assertReadableFile,
  grepScript,
  routedToolsExtension,
  type Where,
} from "./tools.js";
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

/**
 * 位置解析的替身：`<名字>` 这一档主机按 map 换成另一个环境（用来证明 host 真的换了执行环境），
 * 其余规则照真的解析器：host 缺省按当前目录，`host:目录名` 下的相对路径从那个目录起。
 */
function locateFor(
  where: () => Where,
  hosts: Record<string, { env: ExecEnv; cwd: string }> = {},
) {
  return async (host: string | undefined, raw: string | undefined) => {
    const { env, cwd } = where();
    const pm = env.kind === "ssh" ? path.posix : path;
    const expand = async (e: ExecEnv, p: string) =>
      p === "~" || p.startsWith("~/")
        ? pm.join(await e.homedir(), p.slice(1))
        : p;
    const name = (host ?? "").trim();
    const at = async (e: ExecEnv, base: string) => {
      const text = (raw ?? "").replace(/^@/, "");
      const p =
        text === ""
          ? base
          : pm.isAbsolute(text) || text.startsWith("~")
            ? await expand(e, text)
            : pm.resolve(base, text);
      return {
        env: e,
        path: p,
        cwd: base,
        at: {
          host: name.split(":")[0] || "local",
          shown: `${name.split(":")[0] || "local"}:${p}`,
          env: e,
          path: p,
          directory: {} as never,
        } as never,
      };
    };
    if (name === "") return at(env, cwd);
    const hit = hosts[name];
    if (hit) return at(hit.env, hit.cwd);
    const [hostName, dirName] = name.split(":", 2) as [string, string?];
    if (hostName.toLowerCase() !== "local")
      throw new Error(`Unknown host "${hostName}".`);
    return at(env, dirName === undefined ? cwd : path.join(cwd, dirName));
  };
}

/**
 * bash 的目录解析替身：只收 `<host>:<目录名>`，其余照真的解析器：
 * 缺省 = 当前目录，`<名字>` 按 map 换成另一个环境，`local:<名字>` 落在当前目录下的子目录。
 */
function dirFor(
  where: () => Where,
  hosts: Record<string, { env: ExecEnv; cwd: string }> = {},
) {
  return async (ref: string | undefined) => {
    const { env, cwd } = where();
    const text = (ref ?? "").trim();
    if (text === "") return { env, cwd };
    const colon = text.indexOf(":");
    if (colon < 0)
      throw new Error(
        `A directory is written <host>:<name>, for example local:proj.`,
      );
    const hostName = text.slice(0, colon);
    const dirName = text.slice(colon + 1);
    const hit = hosts[text];
    if (hit) return hit;
    if (hostName.toLowerCase() !== "local")
      throw new Error(`Unknown host "${hostName}".`);
    return { env, cwd: path.join(cwd, dirName) };
  };
}

async function load(
  where: () => Where,
  variables?: () => ReadonlyMap<string, string>,
  ports?: { note(envId: string, port: number): void },
  hosts: Record<string, { env: ExecEnv; cwd: string }> = {},
) {
  const tools = new Map<string, Tool>();
  await routedToolsExtension(
    dirFor(where, hosts),
    variables,
    undefined,
    ports,
    locateFor(where, hosts),
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

  test("绝对路径：六个文件工具都按真实路径读写，不当成相对路径", async () => {
    const other = mkdtempSync(path.join(tmpdir(), "yuanshu-tools-other-"));
    try {
      const call = await load(() => ({ env: new LocalEnv(), cwd: dir }));
      const at = path.join(other, "n.txt");
      await call("write", { host: "local", path: at, content: "hello needle" });
      expect(readFileSync(at, "utf8")).toBe("hello needle");
      expect(await call("read", { path: at })).toContain("hello needle");
      await call("edit", {
        path: at,
        edits: [{ oldText: "hello", newText: "bye" }],
      });
      expect(readFileSync(at, "utf8")).toBe("bye needle");
      expect(await call("ls", { path: other })).toContain("n.txt");
      expect(await call("find", { pattern: "*.txt", path: other })).toContain(
        "n.txt",
      );
      expect(await call("grep", { pattern: "needle", path: other })).toContain(
        "n.txt",
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("host 与 path 分开：host 真的换了执行环境与目录（两个不同 id / cwd 的替身）", async () => {
    const other = mkdtempSync(path.join(tmpdir(), "yuanshu-tools-other-"));
    try {
      const here = spy(new LocalEnv());
      // 另一台主机：路径方言与访问方式同本机，只是 id / kind 不同（走环境原语才看得见）
      const there = spy(
        new Proxy(new LocalEnv(), {
          get: (t, k) =>
            k === "id" ? "e1" : k === "kind" ? "ssh" : Reflect.get(t, k, t),
        }) as unknown as ExecEnv,
      );
      const call = await load(
        () => ({ env: here.env, cwd: dir }),
        undefined,
        undefined,
        { dev1: { env: there.env, cwd: other } },
      );
      const at = path.join(other, "x.txt");
      await call("write", { host: "dev1", path: at, content: "hi" });
      expect(readFileSync(at, "utf8")).toBe("hi");
      // 读走的是 dev1 那个环境的原语，不是当前目录的
      const before = here.calls.length;
      expect(await call("read", { host: "dev1", path: at })).toContain("hi");
      expect(there.calls).toContain("readFile");
      expect(here.calls.length).toBe(before);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("找不到文件 / 目录：错误后面补一行解析出的位置", async () => {
    const call = await load(() => ({ env: new LocalEnv(), cwd: dir }));
    const at = path.join(dir, "nope.txt");
    const err = (await call("read", { path: at }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain(`(on local:${at})`);
    const lsErr = (await call("ls", { path: path.join(dir, "nodir") }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(lsErr.message).toContain(`(on local:${path.join(dir, "nodir")})`);
  });

  test("缺省 path：ls / find / grep 作用于 host 给的目录", async () => {
    const other = mkdtempSync(path.join(tmpdir(), "yuanshu-tools-other-"));
    try {
      writeFileSync(path.join(other, "a.txt"), "needle");
      const call = await load(
        () => ({ env: new LocalEnv(), cwd: dir }),
        undefined,
        undefined,
        { dev1: { env: new LocalEnv(), cwd: other } },
      );
      expect(await call("ls", { host: "dev1" })).toContain("a.txt");
      expect(await call("find", { pattern: "*.txt", host: "dev1" })).toContain(
        "a.txt",
      );
      expect(await call("grep", { pattern: "needle", host: "dev1" })).toContain(
        "a.txt",
      );
      // 点名目录（路径也写绝对）时同样作用于它
      expect(await call("ls", { host: "local", path: other })).toContain(
        "a.txt",
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("声明：六个文件工具都有 host，path 的描述照抄，SDK 原 schema 的其余部分还在", async () => {
    const tools = new Map<string, { parameters: any }>();
    await routedToolsExtension(
      dirFor(() => ({ env: new LocalEnv(), cwd: dir })),
      undefined,
      undefined,
      undefined,
      locateFor(() => ({ env: new LocalEnv(), cwd: dir })),
    )({
      registerTool: (t: { name: string; parameters: any }) =>
        tools.set(t.name, t),
    } as never);
    const PATHS = {
      read: "Path of the file to read: relative to the base set by host, or absolute",
      write:
        "Path of the file to write: relative to the base set by host, or absolute",
      edit: "Path of the file to edit: relative to the base set by host, or absolute",
      ls: "Directory to list (default: the base set by host)",
      find: "Directory to search in (default: the base set by host)",
      grep: "Directory or file to search (default: the base set by host)",
    } as const;
    for (const [name, description] of Object.entries(PATHS)) {
      const p = tools.get(name)?.parameters;
      expect(p.properties.host).toMatchObject({ type: "string" });
      expect(p.properties.host.description).toContain("host:directory");
      expect(p.properties.path.description).toBe(description);
      // SDK 原来的其余部分还在
      expect(p.type).toBe("object");
      expect(Object.keys(p.properties)).toContain("path");
    }
    expect(tools.get("read")?.parameters.required).toEqual(["path"]);
    expect(Object.keys(tools.get("edit")?.parameters.properties ?? {})).toEqual(
      expect.arrayContaining(["path", "edits", "host"]),
    );
    // bash 多了 host（只收 <host>:<name>），其余照旧
    expect(Object.keys(tools.get("bash")?.parameters.properties ?? {})).toEqual(
      ["command", "host", "remind_after"],
    );
    expect(tools.get("bash")?.parameters.required).toEqual(["command"]);
  });

  test("bash 的 host 声明原文：只收 <host>:<name>，required 仍只有 command", async () => {
    const tools = new Map<string, { parameters: any }>();
    await routedToolsExtension(
      dirFor(() => ({ env: new LocalEnv(), cwd: dir })),
      undefined,
      undefined,
      undefined,
      locateFor(() => ({ env: new LocalEnv(), cwd: dir })),
    )({
      registerTool: (t: { name: string; parameters: any }) =>
        tools.set(t.name, t),
    } as never);
    expect(tools.get("bash")?.parameters.properties.host).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Where to run: a directory written <host>:<name> (see list_directories), e.g. dev1:train. It is the working directory of this command only; the current directory does not change. A host on its own is not accepted. Omit to run in the current directory.",
    });
    expect(tools.get("bash")?.parameters.required).toEqual(["command"]);
  });

  test("bash 带 host：真的在目标环境与目录里运行（两个不同 id / cwd 的替身）", async () => {
    const other = makeTmpDir("yuanshu-tools-other-");
    {
      const here = spy(new LocalEnv());
      // 另一台主机：路径方言与访问方式同本机，只是 id / kind 不同（走环境原语才看得见）
      const there = spy(
        new Proxy(new LocalEnv(), {
          get: (t, k) =>
            k === "id" ? "e1" : k === "kind" ? "ssh" : Reflect.get(t, k, t),
        }) as unknown as ExecEnv,
      );
      const call = await load(
        () => ({ env: here.env, cwd: dir }),
        undefined,
        undefined,
        { "dev1:train": { env: there.env, cwd: other } },
      );
      const out = await call("bash", {
        host: "dev1:train",
        command: "pwd; echo hi > made.txt",
      });
      expect(out).toContain(other);
      expect(readFileSync(path.join(other, "made.txt"), "utf8")).toBe("hi\n");
      // 走的是目标环境的原语，不是当前目录那个
      expect(there.calls).toContain("exec");
      expect(here.calls).toEqual([]);
      // host 只是路由参数，不进这条命令的进程环境
      expect(
        await call("bash", {
          host: "dev1:train",
          command: 'printf %s "${host-unset}"',
        }),
      ).toBe("unset");
    }
  });

  test("bash 不带 host：仍在当前目录，与原来一致", async () => {
    const call = await load(() => ({ env: new LocalEnv(), cwd: dir }));
    expect(await call("bash", { command: "pwd" })).toContain(dir);
  });

  test("端口发现：带 host 时记的是目标环境", async () => {
    const other = makeTmpDir("yuanshu-tools-other-");
    {
      const noted: Array<[string, number]> = [];
      const named = (id: string) =>
        new Proxy(new LocalEnv(), {
          get: (t, k) => (k === "id" ? id : Reflect.get(t, k, t)),
        });
      const here = named("e9");
      const there = named("e7");
      const call = await load(
        () => ({ env: here, cwd: dir }),
        undefined,
        { note: (envId, port) => void noted.push([envId, port]) },
        { "dev1:train": { env: there, cwd: other } },
      );
      expect(
        await call("bash", {
          host: "dev1:train",
          command: "echo 'ready on localhost:3000'",
        }),
      ).toContain("localhost:3000");
      expect(noted).toEqual([["e7", 3000]]);
    }
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
    expect(out).toBe("a:{{@tok}}:b");
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

  test("端口发现：bash 输出里的本机端口被记在当前目录所在的环境上", async () => {
    const noted: Array<[string, number]> = [];
    // 换一个不是 local 的环境 id，能看出记的是当前目录所在的环境
    const real = new LocalEnv();
    const env = new Proxy(real, {
      get: (t, k) => (k === "id" ? "e9" : Reflect.get(t, k, t)),
    });
    const call = await load(() => ({ env, cwd: dir }), undefined, {
      note: (envId, port) => void noted.push([envId, port]),
    });
    const out = await call("bash", {
      command: "echo 'ready on localhost:3000'; echo 'see 0.0.0.0:5173'",
    });
    // 输出原样交给模型
    expect(out).toBe("ready on localhost:3000\nsee 0.0.0.0:5173\n");
    expect(noted).toEqual([
      ["e9", 3000],
      ["e9", 5173],
    ]);
  });

  test("端口发现：命令跑到一半会话切到了别的环境，端口仍记在启动命令的那个环境上", async () => {
    const noted: Array<[string, number]> = [];
    const named = (id: string) =>
      new Proxy(new LocalEnv(), {
        get: (t, k) => (k === "id" ? id : Reflect.get(t, k, t)),
      });
    const first = named("e9");
    const second = named("e8");
    let current = first;
    const call = await load(() => ({ env: current, cwd: dir }), undefined, {
      note: (envId, port) => void noted.push([envId, port]),
    });
    const running = call("bash", {
      command: "echo start; sleep 0.5; echo ready on localhost:3000",
    });
    await new Promise((r) => setTimeout(r, 200));
    current = second;
    await running;
    expect(noted).toEqual([["e9", 3000]]);
  });

  test("不传 ports 时行为不变，不报错", async () => {
    const s = spy(new LocalEnv());
    const call = await load(() => ({ env: s.env, cwd: dir }));
    expect(await call("bash", { command: "echo localhost:3000" })).toContain(
      "localhost:3000",
    );
    // 本机仍不经过环境原语
    expect(s.calls).toEqual([]);
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

  test("按调用时的 directory 路由：同一组工具先 ssh 后本机", async () => {
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

test("read 围栏：gif 直接拒绝并提示，其他图片类型放行", () => {
  expect(() => assertReadableFile("/tmp/a.gif")).toThrow(/gif/i);
  expect(() => assertReadableFile("/tmp/a.GIF")).toThrow(/gif/i);
  expect(() => assertReadableFile("/tmp/a.png")).not.toThrow();
  expect(() => assertReadableFile(undefined)).not.toThrow();
});
