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
import {
  type HostKeyStore,
  hostKeyFingerprint,
  SshConnection,
} from "./connection.js";

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

// 评审 M1#3：accept-new 主机密钥校验。每个 startSshd 都生成独立的主机密钥，拿第二个实例模拟换密钥。
describe.skipIf(!hasSshd)("SshConnection 主机密钥（真实 sshd）", () => {
  let a: TestSshd;
  let b: TestSshd;
  let dir: string;
  let db: Db;
  let secrets: SecretStore;

  beforeAll(async () => {
    a = await startSshd();
    b = await startSshd();
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "yuanshu-ssh-hk-"));
    db = openDatabase(dir);
    secrets = new SecretStore(db, loadMasterKey(dir));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const store = (initial: string | null = null) => {
    const saved: string[] = [];
    let fp = initial;
    const hostKeys: HostKeyStore = {
      get: () => fp,
      save: (v) => {
        saved.push(v);
        fp = v;
      },
    };
    return { hostKeys, saved, current: () => fp };
  };
  const open = (sshd: TestSshd, hostKeys?: HostKeyStore) => {
    const key = secrets.create(`k${Math.random()}`, "ssh_key", sshd.privateKey);
    return new SshConnection(
      {
        host: "127.0.0.1",
        port: sshd.port,
        username: sshd.user,
        secretId: key?.id ?? null,
      },
      secrets,
      hostKeys,
    );
  };

  test("首次连接记录指纹，再次连接同一服务器通过", async () => {
    const hk = store();
    const first = open(a, hk.hostKeys);
    await first.connect();
    first.close();
    expect(hk.saved).toHaveLength(1);
    expect(hk.current()).toMatch(/^ssh-ed25519:[0-9a-f]{64}$/);

    const second = open(a, hk.hostKeys);
    await second.connect();
    second.close();
    expect(hk.saved).toHaveLength(1); // 已有记录不再写
  });

  test("服务器换了密钥：拒绝连接，错误里有记录与实际两个指纹，且不覆盖记录", async () => {
    const hk = store();
    const first = open(a, hk.hostKeys);
    await first.connect();
    first.close();
    const recorded = hk.current();

    const imposter = open(b, hk.hostKeys);
    await expect(imposter.connect()).rejects.toThrow(/主机密钥与记录不符/);
    await expect(open(b, hk.hostKeys).connect()).rejects.toThrow(
      new RegExp(`记录 ${recorded}`),
    );
    expect(hk.current()).toBe(recorded);
    expect(hk.saved).toHaveLength(1);
  });

  test("清除记录后重新学习新指纹", async () => {
    const hk = store();
    const first = open(a, hk.hostKeys);
    await first.connect();
    first.close();

    const cleared = store();
    const again = open(b, cleared.hostKeys);
    await again.connect();
    again.close();
    expect(cleared.current()).not.toBe(hk.current());
  });

  test("没有传入存取器时也按连接对象记忆，同一对象不会换密钥", async () => {
    const conn = open(a);
    await conn.connect();
    conn.close();
    await conn.connect(); // 同一服务器仍能重连
    conn.close();
  });

  test("hostKeyFingerprint 取线格式里的算法名与整段公钥的 sha256", () => {
    const algo = Buffer.from("ssh-ed25519");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(algo.length);
    const wire = Buffer.concat([len, algo, Buffer.alloc(36, 7)]);
    expect(hostKeyFingerprint(wire)).toMatch(/^ssh-ed25519:[0-9a-f]{64}$/);
  });
});
