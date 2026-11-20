import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  afterAll,
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
import { TransferError, transfer } from "./transfer.js";
import type { ExecEnv } from "./types.js";

let root: string;
let db: Db;
let sshd: TestSshd | null = null;
let ssh: SshEnv | null = null;
const local = new LocalEnv();

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "yuanshu-transfer-"));
  if (!hasSshd) return;
  sshd = await startSshd();
  db = openDatabase(root);
  const secrets = new SecretStore(db, loadMasterKey(root));
  const key = secrets.create("k", "ssh_key", sshd.privateKey);
  ssh = new SshEnv(
    "env-ssh",
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
});
afterAll(async () => {
  ssh?.close();
  await sshd?.close();
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

const pairs: [string, () => ExecEnv, () => ExecEnv, boolean][] = [
  ["本机 → 本机", () => local, () => local, true],
  ["本机 → ssh", () => local, () => ssh as ExecEnv, hasSshd],
  ["ssh → 本机", () => ssh as ExecEnv, () => local, hasSshd],
];

describe.each(pairs)("传输 %s", (_name, srcEnv, dstEnv, enabled) => {
  let src: string;
  let dst: string;
  beforeEach(() => {
    const d = mkdtempSync(path.join(root, "case-"));
    src = path.join(d, "src");
    dst = path.join(d, "dst");
    mkdirSync(path.join(src, "sub"), { recursive: true });
    mkdirSync(dst);
    writeFileSync(path.join(src, "a.bin"), Buffer.from([0, 255, 10, 13]));
    writeFileSync(path.join(src, "sub", "b.txt"), "hello");
  });
  const end = (env: ExecEnv, p: string) => ({ env, path: p });
  const run = (from: string, to: string, opts?: { overwrite?: boolean }) =>
    transfer(end(srcEnv(), from), end(dstEnv(), to), opts);

  test.skipIf(!enabled)("单个文件按给定路径落地，二进制不变", async () => {
    const r = await run(path.join(src, "a.bin"), path.join(dst, "new.bin"));
    expect(r).toEqual({ files: 1, bytes: 4, skippedLinks: 0 });
    expect([...readFileSync(path.join(dst, "new.bin"))]).toEqual([
      0, 255, 10, 13,
    ]);
  });

  test.skipIf(!enabled)("目标是已存在目录时放进去并保留文件名", async () => {
    await run(path.join(src, "a.bin"), dst);
    expect(readFileSync(path.join(dst, "a.bin")).length).toBe(4);
  });

  test.skipIf(!enabled)("目录递归复制并跳过符号链接", async () => {
    symlinkSync("/etc/passwd", path.join(src, "link"));
    const r = await run(src, path.join(dst, "tree"));
    expect(r).toEqual({ files: 2, bytes: 9, skippedLinks: 1 });
    expect(readFileSync(path.join(dst, "tree", "sub", "b.txt"), "utf8")).toBe(
      "hello",
    );
  });

  test.skipIf(!enabled)("冲突时一个文件都不写，overwrite 才覆盖", async () => {
    writeFileSync(path.join(dst, "a.bin"), "old");
    const err = await run(src, dst).catch((e) => e);
    expect(err).toBeInstanceOf(TransferError);
    expect(err.code).toBe("conflict");
    expect(() => readFileSync(path.join(dst, "sub", "b.txt"))).toThrow();
    await run(src, dst, { overwrite: true });
    expect(readFileSync(path.join(dst, "a.bin")).length).toBe(4);
  });

  test.skipIf(!enabled)("源不存在报 src_missing", async () => {
    const err = await run(path.join(src, "nope"), dst).catch((e) => e);
    expect(err.code).toBe("src_missing");
  });

  // 评审 M1#5：顶层源与目标不跟随符号链接
  test.skipIf(!enabled)("顶层源是符号链接：拒绝，不跟随", async () => {
    symlinkSync(path.join(src, "a.bin"), path.join(src, "ln"));
    const err = await run(path.join(src, "ln"), dst).catch((e) => e);
    expect(err).toBeInstanceOf(TransferError);
    expect(err.code).toBe("bad_request");
    expect(readdirSync(dst)).toEqual([]);
  });

  test.skipIf(!enabled)(
    "目标根是指向别处的链接：拒绝，别处不被写入",
    async () => {
      const elsewhere = path.join(path.dirname(dst), "elsewhere");
      mkdirSync(elsewhere);
      const out = path.join(dst, "out");
      symlinkSync(elsewhere, out);
      const err = await run(src, out).catch((e) => e);
      expect(err.code).toBe("conflict");
      expect(readdirSync(elsewhere)).toEqual([]);
    },
  );

  test.skipIf(!enabled)(
    "overwrite 时最终文件是链接：拒绝，链接目标不变",
    async () => {
      const victim = path.join(path.dirname(dst), "victim.txt");
      writeFileSync(victim, "keep");
      symlinkSync(victim, path.join(dst, "a.bin"));
      const err = await run(src, dst, { overwrite: true }).catch((e) => e);
      expect(err.code).toBe("conflict");
      expect(readFileSync(victim, "utf8")).toBe("keep");
    },
  );

  // 评审 M1#7：权限位随源
  test.skipIf(!enabled)("文件与新建目录的权限位随源", async () => {
    chmodSync(path.join(src, "a.bin"), 0o700);
    chmodSync(path.join(src, "sub", "b.txt"), 0o600);
    chmodSync(path.join(src, "sub"), 0o750);
    await run(src, path.join(dst, "tree"));
    const mode = (...p: string[]) =>
      statSync(path.join(dst, "tree", ...p)).mode & 0o777;
    expect(mode("a.bin")).toBe(0o700);
    expect(mode("sub", "b.txt")).toBe(0o600);
    expect(mode("sub")).toBe(0o750);
  });

  test.skipIf(!enabled)("覆盖已有文件后权限位也随源", async () => {
    writeFileSync(path.join(dst, "a.bin"), "old");
    chmodSync(path.join(dst, "a.bin"), 0o644);
    chmodSync(path.join(src, "a.bin"), 0o600);
    await run(path.join(src, "a.bin"), path.join(dst, "a.bin"), {
      overwrite: true,
    });
    expect(statSync(path.join(dst, "a.bin")).mode & 0o777).toBe(0o600);
  });

  // 评审 M1#6：覆盖失败时旧文件原样，不留临时文件
  test.skipIf(!enabled)("覆盖时源读失败：旧文件原样且无残留", async () => {
    writeFileSync(path.join(dst, "a.bin"), "old");
    const broken: ExecEnv = Object.create(srcEnv());
    broken.readStream = async () =>
      Readable.from(
        (async function* () {
          yield Buffer.from("x");
          throw new Error("boom");
        })(),
      );
    const err = await transfer(
      end(broken, path.join(src, "a.bin")),
      end(dstEnv(), path.join(dst, "a.bin")),
      { overwrite: true },
    ).catch((e) => e);
    expect(err.code).toBe("copy_failed");
    expect(readFileSync(path.join(dst, "a.bin"), "utf8")).toBe("old");
    expect(readdirSync(dst)).toEqual(["a.bin"]);
  });

  test.skipIf(!enabled)(
    "不覆盖时预检后被抢先创建：不截断，报 copy_failed",
    async () => {
      const racing: ExecEnv = Object.create(dstEnv());
      const real = dstEnv();
      racing.writeStream = async (p, o) => {
        writeFileSync(p, "winner"); // 模拟预检与写入之间别人建了同名文件
        return real.writeStream(p, o);
      };
      const err = await transfer(
        end(srcEnv(), path.join(src, "a.bin")),
        end(racing, path.join(dst, "race.bin")),
      ).catch((e) => e);
      expect(err.code).toBe("copy_failed");
      expect(readFileSync(path.join(dst, "race.bin"), "utf8")).toBe("winner");
    },
  );

  test.skipIf(!enabled)(
    "目录传输中途失败：不回滚，错误里列出已完成项",
    async () => {
      const flaky: ExecEnv = Object.create(srcEnv());
      const real = srcEnv();
      flaky.readStream = async (p, r) => {
        if (p.endsWith("b.txt")) throw new Error("boom");
        return real.readStream(p, r);
      };
      const err = await transfer(end(flaky, src), end(dstEnv(), dst)).catch(
        (e) => e,
      );
      expect(err.code).toBe("copy_failed");
      expect(err.completed).toEqual([path.join(dst, "a.bin")]);
      expect(err.message).toContain("未回滚");
      expect(readdirSync(path.join(dst, "sub"))).toEqual([]);
    },
  );
});
