import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Db, openDatabase } from "./db.js";
import {
  checkVariable,
  cleanGroup,
  loadMasterKey,
  SecretStore,
  type VariableInput,
} from "./secrets.js";

let dir: string;
let db: Db;
let secrets: SecretStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-secrets-"));
  db = openDatabase(dir);
  secrets = new SecretStore(db, loadMasterKey(dir));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = (over: Partial<VariableInput> = {}): VariableInput => ({
  name: "gitlab_token",
  purpose: "GitLab",
  scopeKind: "any",
  scopeTarget: null,
  tier: "rules",
  value: "glpat-abcdef123456",
  ...over,
});

// 测试只关心存的组名，创建失败的两种情况直接抛。
const add = (over: Partial<VariableInput> = {}) => {
  const v = secrets.createVariable(input(over));
  if (!v || v === "limit") throw new Error("create failed");
  return v;
};

const update = (id: string, patch: Partial<VariableInput>) => {
  const v = secrets.updateVariable(id, patch);
  if (!v || v === "limit") throw new Error("update failed");
  return v;
};

describe("变量组", () => {
  test("组名创建时保存、PATCH 时可改可清空", () => {
    const first = add({ group: "  部署  " });
    expect(first.group).toBe("部署");
    expect(add({ name: "other.token" }).group).toBeNull();
    expect(update(first.id, { group: "运维" }).group).toBe("运维");
    expect(update(first.id, { group: null }).group).toBeNull();
  });

  test("checkVariable 与 cleanGroup 的组名校验", () => {
    expect(cleanGroup(" a ")).toBe("a");
    expect(cleanGroup("x".repeat(32))).toHaveLength(32);
    for (const bad of ["", "   ", "x".repeat(33), "a\0b", 5, undefined])
      expect(cleanGroup(bad)).toBeNull();
    expect(checkVariable(input({ group: "部署" }), true)).toBeNull();
    expect(checkVariable(input({ group: null }), true)).toBeNull();
    expect(checkVariable(input({ group: "  " }), true)).toBe("invalid_group");
  });

  test("改名到已存在的组名就是合并；返回受影响行数，没成员不改", () => {
    for (const [name, group] of [
      ["a.token", "旧"],
      ["b.token", "旧"],
      ["c.token", "新"],
    ] as const)
      add({ name, group });
    expect(secrets.renameVariableGroup("旧", "新")).toBe(2);
    expect(
      secrets
        .listVariables()
        .map((v) => [v.name, v.group])
        .sort(),
    ).toEqual([
      ["a.token", "新"],
      ["b.token", "新"],
      ["c.token", "新"],
    ]);
    expect(secrets.renameVariableGroup("没有这个组", "新")).toBe(0);
    expect(() => secrets.renameVariableGroup("新", "   ")).toThrow(RangeError);
  });

  test("解散组：清空成员的组名，返回行数", () => {
    for (const [name, group] of [
      ["a.token", "部署"],
      ["b.token", "部署"],
      ["c.token", "运维"],
    ] as const)
      add({ name, group });
    expect(secrets.dissolveVariableGroup("部署")).toBe(2);
    expect(
      secrets
        .listVariables()
        .map((v) => v.group)
        .sort(),
    ).toEqual([null, null, "运维"]);
    expect(secrets.dissolveVariableGroup("部署")).toBe(0);
  });

  test("改组名与解散后读缓存立即失效", () => {
    const id = add({ group: "旧" }).id;
    expect(secrets.getVariable(id)?.group).toBe("旧");
    secrets.renameVariableGroup("旧", "新");
    expect(secrets.getVariable(id)?.group).toBe("新");
    expect(secrets.maskVars().length).toBe(1);
    secrets.dissolveVariableGroup("新");
    expect(secrets.getVariable(id)?.group).toBeNull();
  });

  test("凭据（kind != 'variable'）的组名不被改动", () => {
    secrets.create("api-key", "password", "key-value-12345");
    db.prepare(
      "UPDATE secrets SET var_group = '旧' WHERE name = 'api-key'",
    ).run();
    expect(secrets.renameVariableGroup("旧", "新")).toBe(0);
    expect(secrets.dissolveVariableGroup("新")).toBe(0);
  });
});
