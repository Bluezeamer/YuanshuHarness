import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { type Db, openDatabase } from "../store/db.js";
import { DirectoryStore } from "../store/directories.js";
import {
  DirectoryInputError,
  DirectoryResolver,
} from "./directory-resolver.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "yuanshu-dirresolver-"));
  dirs.push(d);
  return d;
};

// 只用到 getSsh；远程分支在这里不做（真实 sshd 在 api/directories.test.ts 里覆盖）。
// 名字去重要查库，所以每个用例一个内存库。
const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const store = (): DirectoryStore => {
  const db = openDatabase(makeTmpDir("yuanshu-dirresolver-db-"));
  opened.push(db);
  return new DirectoryStore(db);
};
const resolver = (directories: DirectoryStore) =>
  new DirectoryResolver({
    hub: { getSsh: () => null } as never,
    directories,
  });

test("本机：合法目录解析为真实路径，名称缺省取末段", async () => {
  const base = tmp();
  mkdirSync(path.join(base, "proj"));
  const r = await resolver(store()).resolve({ path: path.join(base, "proj") });
  expect(r).toEqual({
    environmentId: "local",
    path: path.join(base, "proj"),
    name: "proj",
  });
  expect(
    await resolver(store()).resolve({
      path: path.join(base, "proj"),
      name: "  别名  ",
    }),
  ).toMatchObject({ name: "别名" });
});

test("本机：相对路径、文件、不存在的路径都是 invalid_path", async () => {
  const base = tmp();
  const file = path.join(base, "f.txt");
  writeFileSync(file, "x");
  for (const p of ["rel/dir", file, path.join(base, "nope"), undefined, 5]) {
    const err = await resolver(store())
      .resolve({ path: p })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DirectoryInputError);
    expect(err).toMatchObject({ code: "invalid_path", status: 400 });
  }
});

test("未知环境与非字符串环境都是 invalid_environment", async () => {
  for (const environmentId of ["nope", 5, null]) {
    const err = await resolver(store())
      .resolve({ path: "/tmp", environmentId })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "invalid_environment", status: 400 });
  }
});

test("默认名去重：同一主机上重名时取 -2、-3，删掉中间那个之后再补位", async () => {
  const base = tmp();
  const a = path.join(base, "app");
  const b = path.join(base, "other", "app");
  const c = path.join(base, "third", "app");
  for (const p of [a, b, c]) mkdirSync(p, { recursive: true });
  const dirs = store();
  const r = resolver(dirs);
  const names: string[] = [];
  for (const p of [a, b, c]) {
    const got = await r.resolve({ path: p });
    names.push(got.name);
    dirs.create(got.name, got.path, new Date(), got.environmentId);
  }
  expect(names).toEqual(["app", "app-2", "app-3"]);
  // 显式给重名：409
  const err = await r.resolve({ path: c, name: "app" }).catch((e) => e);
  expect(err).toMatchObject({ code: "name_exists", status: 409 });
  // 显式给不重名的名字照常
  expect(await r.resolve({ path: c, name: "另一个" })).toMatchObject({
    name: "另一个",
  });
});

test("名称清洗：空串与超长都是 invalid_name", async () => {
  const base = tmp();
  const p = path.join(base, "x");
  mkdirSync(p);
  for (const name of ["   ", "x".repeat(101), 5]) {
    const err = await resolver(store())
      .resolve({ path: p, name })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "invalid_name" });
  }
});
