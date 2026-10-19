import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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
import { SshEnv } from "../env/ssh.js";
import { SshConnection } from "../ssh/connection.js";
import { type Db, openDatabase } from "../store/db.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import {
  findSensitiveBelow,
  isInside,
  type PathEnv,
  resolveTarget,
} from "./paths.js";

// 记录经过环境原语的调用，确认判定读的是环境的文件系统而不是 Server 本机。
function spy(env: PathEnv) {
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
  return { env: proxy as PathEnv, calls };
}

describe.skipIf(!hasSshd)("权限路径判定在 ssh 环境（真实 sshd）", () => {
  let sshd: TestSshd;
  let dir: string;
  let db: Db;
  let ssh: SshEnv;
  let cwd: string;
  let outside: string;

  beforeAll(async () => {
    sshd = await startSshd();
  });
  afterAll(() => sshd.close());

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "yuanshu-paths-ssh-"));
    db = openDatabase(dir);
    const secrets = new SecretStore(db, loadMasterKey(dir));
    const key = secrets.create("k", "ssh_key", sshd.privateKey);
    ssh = new SshEnv(
      "paths-test",
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
    cwd = path.join(realpathSync(dir), "proj");
    outside = path.join(realpathSync(dir), "outside");
    mkdirSync(path.join(cwd, "sub"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.txt"), "x");
    symlinkSync(outside, path.join(cwd, "link"));
    symlinkSync(path.join(outside, "new.txt"), path.join(cwd, "dangling"));
    symlinkSync(path.join(cwd, "loop2"), path.join(cwd, "loop1"));
    symlinkSync(path.join(cwd, "loop1"), path.join(cwd, "loop2"));
  });
  afterEach(() => {
    ssh.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("符号链接逃逸：解析到 cwd 外，且是经环境原语解析的", async () => {
    const s = spy(ssh);
    const r = await resolveTarget("link/secret.txt", cwd, s.env);
    expect(r).toBe(path.join(outside, "secret.txt"));
    expect(isInside(cwd, r as string)).toBe(false);
    expect(s.calls).toEqual(expect.arrayContaining(["lstat", "realpath"]));
  });

  test("cwd 内的普通路径与尚不存在的路径照常解析", async () => {
    expect(await resolveTarget("sub", cwd, ssh)).toBe(path.join(cwd, "sub"));
    expect(await resolveTarget("sub/a/b.txt", cwd, ssh)).toBe(
      path.join(cwd, "sub", "a", "b.txt"),
    );
  });

  test.each([
    ["悬空链接", "dangling"],
    ["悬空链接下的子路径", "dangling/x.txt"],
    ["循环链接", "loop1"],
  ])("无法可靠解析：%s 返回 null", async (_n, p) => {
    expect(await resolveTarget(p, cwd, ssh)).toBeNull();
  });

  test("~ 展开为环境的 home，而不是 Server 本机的", async () => {
    const s = spy(ssh);
    const r = await resolveTarget("~/", cwd, s.env);
    expect(s.calls).toContain("homedir");
    expect(r).toBe(realpathSync(await ssh.homedir()));
    // 本机与 sshd 同机时二者相同；这里只确认走了环境原语
    expect(r).toBe(realpathSync(homedir()));
  });

  test("目录树内的敏感文件由环境的 readdir 扫出", async () => {
    expect(await findSensitiveBelow(cwd, ssh)).toBeNull();
    writeFileSync(path.join(cwd, "sub", ".env"), "TOKEN=x");
    const s = spy(ssh);
    expect(await findSensitiveBelow(cwd, s.env)).toBe(".env");
    expect(s.calls).toContain("readdir");
  });
});
