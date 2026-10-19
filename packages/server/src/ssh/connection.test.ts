import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
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
import { type Db, openDatabase } from "../store/db.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { SshConnection } from "./connection.js";

describe.skipIf(!hasSshd)("SshConnection（真实 sshd）", () => {
  let sshd: TestSshd;
  let dir: string;
  let work: string;
  let db: Db;
  let secrets: SecretStore;
  let conn: SshConnection;

  beforeAll(async () => {
    sshd = await startSshd();
  });
  afterAll(() => sshd.close());

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "yuanshu-ssh-"));
    work = path.join(dir, "work");
    mkdirSync(work);
    db = openDatabase(dir);
    secrets = new SecretStore(db, loadMasterKey(dir));
    const key = secrets.create("k", "ssh_key", sshd.privateKey);
    conn = new SshConnection(
      {
        host: "127.0.0.1",
        port: sshd.port,
        username: sshd.user,
        secretId: key?.id ?? null,
      },
      secrets,
    );
    await conn.connect();
  });
  afterEach(() => {
    conn.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("exec 返回输出与退出码，stderr 分开", async () => {
    const r = await conn.exec("echo out; echo err >&2; exit 3");
    expect(r.exitCode).toBe(3);
    expect(r.stdout.toString()).toBe("out\n");
    expect(r.stderr.toString()).toBe("err\n");
  });

  test("exec 超时终止，exitCode 为 null", async () => {
    const r = await conn.exec("sleep 5", { timeoutMs: 300 });
    expect(r.exitCode).toBeNull();
  });

  test("exec 响应 AbortSignal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const started = Date.now();
    const r = await conn.exec("sleep 5", { signal: ac.signal });
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("写读往返，含二进制与中文", async () => {
    const f = path.join(work, "a.bin");
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0xe4, 0xb8, 0xad]);
    await conn.writeFile(f, bytes);
    expect((await conn.readFile(f)).equals(bytes)).toBe(true);
  });

  test("mkdirp 递归创建，重复调用不报错", async () => {
    const d = path.join(work, "x/y/z");
    await conn.mkdirp(d);
    await conn.mkdirp(d);
    expect(await conn.isDirectory(d)).toBe(true);
  });

  test("readdir / exists / isDirectory", async () => {
    writeFileSync(path.join(work, "f.txt"), "1");
    mkdirSync(path.join(work, "sub"));
    expect((await conn.readdir(work)).sort()).toEqual(["f.txt", "sub"]);
    expect(await conn.exists(path.join(work, "f.txt"))).toBe(true);
    expect(await conn.exists(path.join(work, "nope"))).toBe(false);
    expect(await conn.isDirectory(path.join(work, "sub"))).toBe(true);
    expect(await conn.isDirectory(path.join(work, "f.txt"))).toBe(false);
  });

  test("读不存在的文件抛错", async () => {
    await expect(conn.readFile(path.join(work, "nope"))).rejects.toThrow();
  });

  test("realpath 解析链接；悬空链接返回 null", async () => {
    const real = path.join(work, "real");
    mkdirSync(real);
    symlinkSync(real, path.join(work, "link"));
    symlinkSync(path.join(work, "gone"), path.join(work, "dangling"));
    expect(await conn.realpath(path.join(work, "link"))).toBe(real);
    expect(await conn.realpath(path.join(work, "dangling"))).toBeNull();
  });

  test("close 之后调用原语抛错", async () => {
    conn.close();
    await expect(conn.exec("true")).rejects.toThrow("未建立");
    await expect(conn.readFile("/etc/hostname")).rejects.toThrow("未建立");
  });

  test("引用的密码不存在时连接失败并说明原因", async () => {
    const bad = new SshConnection(
      {
        host: "127.0.0.1",
        port: sshd.port,
        username: sshd.user,
        secretId: "nope",
      },
      secrets,
    );
    await expect(bad.connect()).rejects.toThrow("密码不存在");
  });

  test("密钥错误时认证失败", async () => {
    const other = secrets.create("wrong", "password", "not-a-key");
    const bad = new SshConnection(
      {
        host: "127.0.0.1",
        port: sshd.port,
        username: sshd.user,
        secretId: other?.id ?? null,
      },
      secrets,
    );
    await expect(bad.connect()).rejects.toThrow();
  });
});
