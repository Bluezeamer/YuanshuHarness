import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
});
