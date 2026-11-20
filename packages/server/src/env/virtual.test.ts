import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { AttachmentDirectories } from "../session/attachments.js";
import { type Db, openDatabase } from "../store/db.js";
import { DirectoryStore } from "../store/directories.js";
import {
  ATTACHMENT_ENV_ID,
  COLLAB_ENV_ID,
  EnvironmentStore,
} from "../store/environments.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { EnvHub } from "./hub.js";
import { VirtualEnv } from "./virtual.js";

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "yuanshu-virtual-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("VirtualEnv：文件原语落在本机，homedir 是附件根，exec 直接抛错", async () => {
  const root = tempDir();
  const env = new VirtualEnv(root);
  expect(env.id).toBe(ATTACHMENT_ENV_ID);
  expect(env.kind).toBe("virtual");
  expect(await env.homedir()).toBe(root);

  const file = path.join(root, "sub", "a.txt");
  await env.mkdirp(path.dirname(file));
  await writeFile(file, "hello");
  expect((await env.stat(file))?.isFile).toBe(true);
  expect((await env.lstat(file))?.size).toBe(5);
  expect(
    (await env.readdir(path.join(root, "sub"))).map((e) => e.name),
  ).toEqual(["a.txt"]);
  expect(await env.realpath(file)).toBe(file);
  expect((await env.readFile(file)).toString()).toBe("hello");

  // 写流 + rename 也是本机语义
  const tmp = path.join(root, "sub", "b.tmp");
  const out = await env.writeStream(tmp, { mode: 0o600 });
  out.end("world");
  await once(out, "close");
  await env.rename(tmp, path.join(root, "sub", "b.txt"));
  expect((await readFile(path.join(root, "sub", "b.txt"))).toString()).toBe(
    "world",
  );

  await expect(env.exec("echo hi", root, { onData: () => {} })).rejects.toThrow(
    /不提供命令执行/,
  );
});

test("EnvHub：attachment 是虚拟环境，不进环境列表；本机与未知环境行为不变", () => {
  const dataDir = tempDir();
  const db: Db = openDatabase(dataDir);
  try {
    const environments = new EnvironmentStore(db);
    const secrets = new SecretStore(db, loadMasterKey(dataDir));
    const directories = new DirectoryStore(db);
    const attachments = new AttachmentDirectories(directories, dataDir);
    const hub = new EnvHub(
      environments,
      secrets,
      undefined,
      undefined,
      attachments.env,
    );
    expect(hub.get(ATTACHMENT_ENV_ID)).toBe(attachments.env);
    expect(hub.status(ATTACHMENT_ENV_ID)).toEqual({
      id: ATTACHMENT_ENV_ID,
      state: "virtual",
    });
    expect(hub.get("local")?.kind).toBe("local");
    expect(hub.get("nope")).toBeNull();
    // 虚拟环境不登记进表，所以环境列表里不会出现
    expect(environments.list().map((e) => e.id)).not.toContain(
      ATTACHMENT_ENV_ID,
    );
  } finally {
    db.close();
  }
});

test("VirtualEnv：id 可以换（协作区也是虚拟主机），其余不变", async () => {
  const root = tempDir();
  const env = new VirtualEnv(root, COLLAB_ENV_ID);
  expect(env.id).toBe(COLLAB_ENV_ID);
  expect(env.kind).toBe("virtual");
  expect(await env.homedir()).toBe(root);
  await expect(env.exec("echo hi", root, { onData: () => {} })).rejects.toThrow(
    /不提供命令执行/,
  );
});

test("EnvHub：collab 也是虚拟环境，同样不进环境列表", () => {
  const dataDir = tempDir();
  const db: Db = openDatabase(dataDir);
  try {
    const environments = new EnvironmentStore(db);
    const secrets = new SecretStore(db, loadMasterKey(dataDir));
    const attachments = new AttachmentDirectories(
      new DirectoryStore(db),
      dataDir,
    );
    const collabEnv = new VirtualEnv(
      path.join(dataDir, "collab"),
      COLLAB_ENV_ID,
    );
    const hub = new EnvHub(
      environments,
      secrets,
      undefined,
      undefined,
      attachments.env,
      collabEnv,
    );
    expect(hub.get(COLLAB_ENV_ID)).toBe(collabEnv);
    expect(hub.status(COLLAB_ENV_ID)).toEqual({
      id: COLLAB_ENV_ID,
      state: "virtual",
    });
    // 没接协作区时它就不是一台可用的主机
    const bare = new EnvHub(environments, secrets);
    expect(bare.get(COLLAB_ENV_ID)).toBeNull();
    expect(bare.status(COLLAB_ENV_ID)).toBeNull();
    expect(environments.list().map((e) => e.id)).not.toContain(COLLAB_ENV_ID);
  } finally {
    db.close();
  }
});

test("DirectoryStore：attachment directory 不出现在用户可见列表与默认 directory 里", async () => {
  const dataDir = tempDir();
  const db = openDatabase(dataDir);
  try {
    const directories = new DirectoryStore(db);
    const normal = directories.create("normal", dataDir);
    const attachments = new AttachmentDirectories(directories, dataDir);
    const ws = await attachments.ensure("session-1");
    expect(ws.environmentId).toBe(ATTACHMENT_ENV_ID);
    expect(ws.path).toBe(path.join(dataDir, "attachments", "session-1"));
    await writeFile(path.join(ws.path, "x.txt"), "x");
    // 同一会话并发/重复 ensure 拿到同一行
    expect((await attachments.ensure("session-1")).id).toBe(ws.id);
    expect(attachments.get("session-1")?.id).toBe(ws.id);
    expect(attachments.get("session-2")).toBeUndefined();

    expect(directories.list().map((w) => w.id)).toEqual([normal?.id]);
    expect(directories.getDefault()?.id).toBe(normal?.id);
  } finally {
    db.close();
  }
});
