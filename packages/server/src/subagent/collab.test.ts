import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { COLLAB_ENV_ID } from "../store/environments.js";
import { CollabArea } from "./collab.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "yuanshu-collab-"));
  dirs.push(d);
  return d;
};

test("同树可读，子代理只写自己的子目录，根会话不写", () => {
  const area = new CollabArea(path.join(tmp(), "collab"));
  const own = area.ownDir("r1", "c1");
  const other = area.ownDir("r1", "c2");
  // 读：整棵树
  expect(area.allows("r1", "c1", "read", path.join(other, "a.md"))).toBe(true);
  expect(area.allows("r1", null, "read", path.join(own, "a.md"))).toBe(true);
  // 写：只有自己的子目录
  expect(area.allows("r1", "c1", "write", path.join(own, "sub", "a.md"))).toBe(
    true,
  );
  expect(area.allows("r1", "c1", "write", path.join(other, "a.md"))).toBe(
    false,
  );
  expect(area.allows("r1", "c1", "write", area.treeDir("r1"))).toBe(false);
  expect(area.allows("r1", null, "write", path.join(own, "a.md"))).toBe(false);
  // 别的树一律不行；前缀相同的兄弟目录也不行
  expect(
    area.allows("r1", "c1", "read", path.join(area.treeDir("r2"), "x")),
  ).toBe(false);
  expect(area.allows("r1", "c1", "read", `${area.treeDir("r1")}-evil/x`)).toBe(
    false,
  );
  expect(area.allows("r1", "c1", "write", `${own}-evil/x`)).toBe(false);
});

test("路径按真实位置比较：数据目录在符号链接下也成立；目录没建好时不去创建", () => {
  const base = tmp();
  const real = path.join(base, "real");
  mkdirSync(real);
  symlinkSync(real, path.join(base, "link"));
  const area = new CollabArea(path.join(base, "link", "collab"));
  expect(area.ownDir("r", "c").startsWith(path.join(real, "collab"))).toBe(
    true,
  );
  expect(() => readFileSync(path.join(real, "collab"))).toThrow();
});

test("公告板：同树可读，成员不能写；lead 只在成员全部停止时能改它，且只放行这一个文件", () => {
  let idle = false;
  const area = new CollabArea(path.join(tmp(), "collab"), () => idle);
  const board = area.boardPath("r1");
  expect(board).toBe(path.join(area.treeDir("r1"), "board.md"));
  expect(area.allows("r1", "c1", "read", board)).toBe(true);
  expect(area.allows("r1", "c1", "write", board)).toBe(false);
  expect(area.allows("r1", null, "write", board)).toBe(false);
  idle = true;
  expect(area.allows("r1", null, "write", board)).toBe(true);
  expect(area.allows("r1", "c1", "write", board)).toBe(false);
  const other = path.join(area.ownDir("r1", "c1"), "a.md");
  expect(area.allows("r1", null, "write", other)).toBe(false);
});

test("报告写进自己的子目录；根会话删除时整棵树一起清掉", () => {
  const area = new CollabArea(path.join(tmp(), "collab"));
  const r = area.writeReport("r1", "c1", "# 报告\n正文");
  expect(r.path).toBe(path.join(area.ownDir("r1", "c1"), "report.md"));
  expect(r.bytes).toBeGreaterThan(0);
  expect(readFileSync(r.path, "utf8")).toContain("正文");
  area.remove("r1");
  expect(() => readFileSync(r.path)).toThrow();
  expect(() => area.remove("r1")).not.toThrow();
});

test("虚拟主机 collab：env 是它的虚拟环境，真实路径换算成 `/` 开头的树内路径", () => {
  const area = new CollabArea(path.join(tmp(), "collab"));
  expect(area.env.id).toBe(COLLAB_ENV_ID);
  expect(area.env.kind).toBe("virtual");
  // 树根与自己的子目录
  expect(area.virtualPath("r1", area.treeDir("r1"))).toBe("/");
  expect(area.virtualPath("r1", area.ownDir("r1", "c1"))).toBe("/c1");
  expect(area.virtualPath("r1", area.boardPath("r1"))).toBe("/board.md");
});

test("子代理启动时把自己的子目录建出来", () => {
  const area = new CollabArea(path.join(tmp(), "collab"));
  const own = area.ownDir("r1", "c1");
  expect(() => readFileSync(path.join(own, "x"))).toThrow();
  area.ensureOwn("r1", "c1");
  const st = statSync(own);
  expect(st.isDirectory()).toBe(true);
});
