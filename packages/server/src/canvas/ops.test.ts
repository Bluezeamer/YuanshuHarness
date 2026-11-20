import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv } from "../env/types.js";
import {
  applyOps,
  isCanvasOp,
  loadWorld,
  type OpsWorld,
  parseHostPath,
  planOps,
} from "./ops.js";
import { CanvasRepo } from "./repo.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const d = mkdtempSync(path.join(tmpdir(), "yuanshu-canvas-ops-"));
  dirs.push(d);
  return d;
}

/** 纯试算用的空世界。 */
const world = (over: Partial<OpsWorld> = {}): OpsWorld => ({
  boards: new Map(),
  cards: new Map(),
  notes: new Map(),
  cardNames: new Map(),
  projectFile: () => false,
  remoteFile: () => "missing",
  ...over,
});

const seed = (w: OpsWorld, board: string): void => {
  w.boards.set(board, { nodes: [], edges: [] });
  w.cardNames.set(board, new Set());
};

const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("did not throw");
};

describe("isCanvasOp", () => {
  test("认得每个 op 的形状，其余一律不认", () => {
    expect(isCanvasOp({ op: "create_canvas", name: "b" })).toBe(true);
    expect(isCanvasOp({ op: "create_card", canvas: "b", text: "" })).toBe(true);
    expect(isCanvasOp({ op: "create_card", canvas: "b" })).toBe(false);
    expect(
      isCanvasOp({
        op: "update",
        path: "b.cards/a.md",
        old: "a",
        new: "b",
      }),
    ).toBe(true);
    expect(isCanvasOp({ op: "update", path: 1 })).toBe(false);
    expect(isCanvasOp({ op: "rename", path: "p", name: "n" })).toBe(true);
    expect(isCanvasOp({ op: "delete", path: "p" })).toBe(true);
    expect(isCanvasOp({ op: "place", canvas: "b", file: "docs/a.md" })).toBe(
      true,
    );
    expect(isCanvasOp({ op: "unplace", canvas: "b" })).toBe(false);
    expect(isCanvasOp({ op: "create_note", path: "a", text: "x" })).toBe(true);
    expect(
      isCanvasOp({ op: "create_note", path: "a", text: "x", canvas: "b" }),
    ).toBe(true);
    expect(isCanvasOp({ op: "create_note", path: "a" })).toBe(false);
    expect(isCanvasOp({ op: "promote", path: "b.cards/a.md" })).toBe(true);
    expect(isCanvasOp({ op: "promote", path: "b.cards/a.md", to: 1 })).toBe(
      false,
    );
    expect(isCanvasOp({ op: "connect", canvas: "b" })).toBe(false);
    expect(isCanvasOp(null)).toBe(false);
    expect(isCanvasOp([{ op: "delete", path: "p" }])).toBe(false);
  });
});

describe("planOps：整批试算", () => {
  test("先 create_canvas 再 create_card：后一条看得到前一条的结果", () => {
    const w = world();
    const { steps } = planOps(w, [
      { op: "create_canvas", name: "新画布" },
      { op: "create_card", canvas: "新画布", name: "卡", text: "正文" },
    ]);
    expect(steps.map((s) => s.kind)).toEqual(["create_canvas", "create_card"]);
    expect(w.boards.get("新画布")?.nodes).toHaveLength(1);
  });

  test("create_card 重名加序号，空名用时间", () => {
    const w = world();
    seed(w, "b");
    w.cardNames.get("b")?.add("卡");
    const { steps } = planOps(w, [
      { op: "create_card", canvas: "b", name: "卡", text: "1" },
      { op: "create_card", canvas: "b", text: "2" },
    ]);
    expect(steps[0]).toMatchObject({ kind: "create_card", name: "卡 (2)" });
    expect(steps[1]).toMatchObject({ kind: "create_card" });
    expect((steps[1] as { name: string }).name).toMatch(/^\d{8}-\d{6}$/);
  });

  test("update 的 old/new：出现 0 次与多次都报错，恰好一次才改", () => {
    const w = world();
    seed(w, "b");
    w.cards.set("b.cards/a.md", "x x y");
    w.cardNames.get("b")?.add("a");
    const path0 = "b.cards/a.md";
    expect(
      message(() =>
        planOps(w, [{ op: "update", path: path0, old: "zzz", new: "q" }]),
      ),
    ).toContain("0 times");
    expect(
      message(() =>
        planOps(w, [{ op: "update", path: path0, old: "x", new: "q" }]),
      ),
    ).toContain("2 times");
    const { steps } = planOps(w, [
      { op: "update", path: path0, old: "y", new: "z" },
    ]);
    expect(steps[0]).toMatchObject({ kind: "write_card", text: "x x z" });
    expect(w.cards.get(path0)).toBe("x x z");
  });

  test("update 的 text 与 old/new 二选一", () => {
    const w = world();
    seed(w, "b");
    w.cards.set("b.cards/a.md", "内容");
    expect(
      message(() =>
        planOps(w, [
          {
            op: "update",
            path: "b.cards/a.md",
            text: "t",
            old: "a",
            new: "b",
          },
        ]),
      ),
    ).toContain("not both");
    expect(
      message(() => planOps(w, [{ op: "update", path: "b.cards/a.md" }])),
    ).toContain("give text");
  });

  test("路径护栏：index.md 只读、项目文件引用与 notes/ 不能被这几个 op 碰", () => {
    const w = world();
    seed(w, "b");
    expect(
      message(() => planOps(w, [{ op: "delete", path: "index.md" }])),
    ).toContain("read-only");
    expect(
      message(() => planOps(w, [{ op: "delete", path: "../docs/a.md" }])),
    ).toContain("project file reference");
    expect(
      message(() => planOps(w, [{ op: "delete", path: "notes/a.txt" }])),
    ).toContain("not a canvas, a card or a note");
    expect(
      message(() => planOps(w, [{ op: "delete", path: "../../etc/passwd" }])),
    ).toContain("project file reference");
    expect(
      message(() =>
        planOps(w, [{ op: "update", path: "b.canvas", text: "x" }]),
      ),
    ).toContain("update works on cards and notes only");
  });

  test("create_note：路径逐段清洗、缺 .md 补上；index.md、卡片与资源文件夹里、已存在的都拒绝；可同时放上画布", () => {
    const w = world();
    seed(w, "b");
    const { steps, summaries } = planOps(w, [
      { op: "create_note", path: "产品/用户:研究", text: "x" },
      {
        op: "create_note",
        path: ".canvas/设计原则.md",
        text: "y",
        canvas: "b",
      },
    ]);
    expect(steps).toEqual([
      { kind: "create_note", path: "产品/用户研究.md", text: "x" },
      { kind: "create_note", path: "设计原则.md", text: "y" },
      { kind: "place", canvas: "b", file: "设计原则.md" },
    ]);
    expect(summaries).toEqual([
      "create note 产品/用户研究.md",
      "create note 设计原则.md",
      "place 设计原则.md on b",
    ]);
    expect(w.boards.get("b")?.nodes.map((n) => n.file)).toEqual([
      "设计原则.md",
    ]);
    const fresh = () => {
      const x = world();
      seed(x, "b");
      x.notes.set("a.md", "旧");
      return x;
    };
    const bad = (path: string) =>
      message(() => planOps(fresh(), [{ op: "create_note", path, text: "" }]));
    expect(bad("index")).toContain("read-only");
    expect(bad("b.cards/x")).toContain("inside a card or asset folder");
    expect(bad("b.assets/x")).toContain("inside a card or asset folder");
    expect(bad("a")).toContain("already exists");
    expect(bad("///")).toContain("empty note path");
    expect(
      message(() =>
        planOps(fresh(), [
          { op: "create_note", path: "n", text: "", canvas: "没有" },
        ]),
      ),
    ).toContain('canvas "没有" does not exist');
  });

  test("笔记：update（text 与 old/new）、rename（只改最后一段、引用跟着改、重名拒绝）、delete（所有画布上的引用清掉）", () => {
    const w = world();
    seed(w, "b");
    seed(w, "c");
    w.notes.set("a/n.md", "一二一");
    w.notes.set("a/m.md", "m");
    for (const board of ["b", "c"])
      w.boards.get(board)?.nodes.push({
        id: `n-${board}`,
        type: "file",
        file: "a/n.md",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      });
    const plan = planOps(w, [
      { op: "update", path: "a/n.md", old: "二", new: "2" },
      { op: "rename", path: "a/n.md", name: "新名.md" },
    ]);
    expect(plan.steps).toEqual([
      { kind: "write_note", path: "a/n.md", text: "一2一" },
      { kind: "rename_note", path: "a/n.md", to: "a/新名.md" },
    ]);
    expect(w.notes.get("a/新名.md")).toBe("一2一");
    expect(w.notes.has("a/n.md")).toBe(false);
    expect(w.boards.get("c")?.nodes[0]?.file).toBe("a/新名.md");
    expect(
      message(() =>
        planOps(w, [{ op: "rename", path: "a/新名.md", name: "m" }]),
      ),
    ).toContain("already exists");

    planOps(w, [{ op: "delete", path: "a/新名.md" }]);
    expect(w.notes.has("a/新名.md")).toBe(false);
    expect(w.boards.get("b")?.nodes).toEqual([]);
    expect(w.boards.get("c")?.nodes).toEqual([]);
    expect(
      message(() => planOps(w, [{ op: "delete", path: "a/新名.md" }])),
    ).toContain("does not exist");
  });

  test("promote：卡片变成笔记，节点留在画布上指向新路径；默认放在 .canvas/ 根、可指定子目录；目标已存在拒绝", () => {
    const w = world();
    seed(w, "b");
    w.cards.set("b.cards/想法.md", "# 想法");
    w.cardNames.set("b", new Set(["想法"]));
    w.boards.get("b")?.nodes.push({
      id: "n1",
      type: "file",
      file: "b.cards/想法.md",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    w.notes.set("想法.md", "占着");
    expect(
      message(() => planOps(w, [{ op: "promote", path: "b.cards/想法.md" }])),
    ).toContain("already exists");
    const plan = planOps(w, [
      { op: "promote", path: "b.cards/想法.md", to: "产品/已定想法" },
    ]);
    expect(plan.steps).toEqual([
      { kind: "promote", path: "b.cards/想法.md", to: "产品/已定想法.md" },
    ]);
    expect(w.cards.size).toBe(0);
    expect(w.notes.get("产品/已定想法.md")).toBe("# 想法");
    expect(w.boards.get("b")?.nodes[0]?.file).toBe("产品/已定想法.md");
    expect(
      message(() => planOps(w, [{ op: "promote", path: "b.canvas" }])),
    ).toContain("idea cards only");
  });

  test("place / unplace 树里的笔记：file 写成 .canvas/<相对路径>；不是笔记（卡片、不存在）报错；不重复", () => {
    const w = world();
    seed(w, "b");
    w.notes.set("n.md", "x");
    const plan = planOps(w, [
      { op: "place", canvas: "b", file: ".canvas/n.md" },
    ]);
    expect(plan.steps).toEqual([{ kind: "place", canvas: "b", file: "n.md" }]);
    expect(
      message(() =>
        planOps(w, [{ op: "place", canvas: "b", file: ".canvas/n.md" }]),
      ),
    ).toContain("already on canvas");
    expect(
      message(() =>
        planOps(w, [
          { op: "place", canvas: "b", file: ".canvas/b.cards/x.md" },
        ]),
      ),
    ).toContain("is not a note");
    planOps(w, [{ op: "unplace", canvas: "b", file: ".canvas/n.md" }]);
    expect(w.boards.get("b")?.nodes).toEqual([]);
    expect(
      message(() =>
        planOps(w, [{ op: "unplace", canvas: "b", file: ".canvas/n.md" }]),
      ),
    ).toContain("is not on canvas");
  });

  test("按旧名找不到文件时附带 index 提示", () => {
    const w = world();
    seed(w, "b");
    expect(
      message(() => planOps(w, [{ op: "delete", path: "b.cards/旧名.md" }])),
    ).toContain("Read .canvas/index.md for the current paths.");
  });

  test("place 要求项目文件存在且不重复；unplace 只去掉引用，对卡片报错", () => {
    const w = world();
    seed(w, "b");
    w.projectFile = (rel) => rel === "docs/design.md";
    expect(
      message(() =>
        planOps(w, [{ op: "place", canvas: "b", file: "docs/missing.md" }]),
      ),
    ).toContain("file not found");
    const { steps } = planOps(w, [
      { op: "place", canvas: "b", file: "docs/design.md" },
    ]);
    expect(steps[0]).toMatchObject({
      kind: "place",
      file: "../docs/design.md",
    });
    expect(
      message(() =>
        planOps(w, [{ op: "place", canvas: "b", file: "docs/design.md" }]),
      ),
    ).toContain("already on canvas");
    planOps(w, [{ op: "unplace", canvas: "b", file: "docs/design.md" }]);
    expect(w.boards.get("b")?.nodes).toHaveLength(0);
    w.cards.set("b.cards/a.md", "");
    w.cardNames.get("b")?.add("a");
    planOps(w, [{ op: "create_card", canvas: "b", name: "卡", text: "" }]);
    expect(
      message(() =>
        planOps(w, [{ op: "unplace", canvas: "b", file: "b.cards/a.md" }]),
      ),
    ).toContain("use delete");
  });

  test("place / unplace 别的主机上的文件：要求文件在、主机连得上、不重复；同一路径在不同主机上是两个文件", () => {
    const w = world({
      remoteFile: (host, abs) =>
        host === "down"
          ? "unreachable"
          : abs === "/srv/a.md"
            ? "file"
            : "missing",
    });
    seed(w, "b");
    const place = (host: string, file: string) =>
      planOps(w, [{ op: "place", canvas: "b", file, host }]);
    expect(message(() => place("dev", "/srv/none.md"))).toContain(
      'file not found on host "dev"',
    );
    expect(message(() => place("down", "/srv/a.md"))).toContain(
      'host "down" is not reachable',
    );
    expect(place("dev", "/srv/a.md").steps).toEqual([
      { kind: "place", canvas: "b", file: "/srv/a.md", host: "dev" },
    ]);
    expect(w.boards.get("b")?.nodes[0]).toMatchObject({
      type: "file",
      file: "/srv/a.md",
      host: "dev",
    });
    expect(message(() => place("dev", "/srv/a.md"))).toContain("already on");
    // 别的主机上的同一路径可以再放一个
    place("dev2", "/srv/a.md");
    expect(w.boards.get("b")?.nodes).toHaveLength(2);
    // unplace 只认主机与路径都对得上的
    expect(
      message(() =>
        planOps(w, [
          { op: "unplace", canvas: "b", file: "/srv/a.md", host: "other" },
        ]),
      ),
    ).toContain("is not on canvas");
    planOps(w, [
      { op: "unplace", canvas: "b", file: "/srv/a.md", host: "dev" },
    ]);
    expect(w.boards.get("b")?.nodes.map((n) => n.host)).toEqual(["dev2"]);
    // 项目内同名的相对路径引用不受影响
    const w2 = world({ projectFile: () => true, remoteFile: () => "file" });
    seed(w2, "b");
    planOps(w2, [{ op: "place", canvas: "b", file: "srv/a.md" }]);
    planOps(w2, [{ op: "place", canvas: "b", file: "/srv/a.md", host: "dev" }]);
    expect(w2.boards.get("b")?.nodes).toHaveLength(2);
  });

  test("rename 画布连带改卡片路径，卡片改名避让重名", () => {
    const w = world();
    seed(w, "旧");
    w.cards.set("旧.cards/a.md", "x");
    w.cardNames.get("旧")?.add("a");
    w.boards.get("旧")?.nodes.push({
      id: "n",
      type: "file",
      file: "旧.cards/a.md",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    const { steps } = planOps(w, [
      { op: "rename", path: "旧.canvas", name: "新" },
      { op: "update", path: "新.cards/a.md", old: "x", new: "y" },
    ]);
    expect(steps[0]).toEqual({ kind: "rename_canvas", from: "旧", name: "新" });
    expect(w.cards.get("新.cards/a.md")).toBe("y");
    expect(w.boards.get("新")?.nodes[0]?.file).toBe("新.cards/a.md");
  });

  test("delete 画布把它的卡片从快照里一并清掉", () => {
    const w = world();
    seed(w, "b");
    w.cards.set("b.cards/a.md", "");
    const { steps } = planOps(w, [{ op: "delete", path: "b.canvas" }]);
    expect(steps[0]).toEqual({ kind: "delete_canvas", name: "b" });
    expect(w.cards.size).toBe(0);
    expect(w.boards.has("b")).toBe(false);
  });

  test("错误带序号与操作名，由 applyOps 拼成 Operation <n> (<op>): …", () => {
    const w = world();
    const err = message(() =>
      planOps(w, [
        { op: "create_canvas", name: "b" },
        { op: "create_canvas", name: "b" },
      ]),
    );
    expect(err).toContain("already exists");
  });
});

/** 让第 n 次 writeFile 抛错：用来验证落盘中途失败会整批回滚。 */
class FlakyEnv extends LocalEnv {
  writes = 0;
  failAt = -1;
  constructor() {
    super();
    const inner = this.writeFile.bind(this);
    this.writeFile = async (p: string, data: Buffer | string) => {
      this.writes++;
      if (this.writes === this.failAt) throw new Error("disk full");
      return inner(p, data);
    };
  }
}

describe("parseHostPath", () => {
  test("主机名:绝对路径（POSIX 或盘符）才算；项目相对路径、盘符路径本身都不算", () => {
    expect(parseHostPath("dev-01:/home/u/a.md")).toEqual({
      host: "dev-01",
      abs: "/home/u/a.md",
    });
    expect(parseHostPath("我的主机:C:\\Users\\a.md")).toEqual({
      host: "我的主机",
      abs: "C:\\Users\\a.md",
    });
    expect(parseHostPath("win:C:/x/a.md")).toEqual({
      host: "win",
      abs: "C:/x/a.md",
    });
    for (const raw of [
      "docs/design.md",
      "C:\\x\\a.md",
      "/abs/a.md",
      "dev:relative/a.md",
      ":/a.md",
      "",
    ])
      expect(parseHostPath(raw)).toBeNull();
  });
});

describe("applyOps：落盘", () => {
  const repoOf = (env: ExecEnv, dir: string) =>
    new CanvasRepo(env, dir, { commitDelayMs: 10_000 });

  test("一批合法操作全落盘，并立即提交一次 agent 提交", async () => {
    const dir = project();
    writeFileSync(path.join(dir, "design.md"), "# 设计");
    const repo = repoOf(new LocalEnv(), dir);
    await repo.createBoard("b");
    await repo.settle();

    const lines = await applyOps(
      repo,
      [
        { op: "create_card", canvas: "b", name: "风险", text: "# 风险\n内容" },
        { op: "place", canvas: "b", file: "design.md" },
      ],
      { kind: "agent", session: "s1" },
    );
    expect(lines).toEqual([
      "create card b.cards/风险.md",
      "place design.md on b",
    ]);

    const { doc } = await repo.readBoard("b");
    expect(doc.nodes.map((n) => n.file)).toEqual([
      "b.cards/风险.md",
      "../design.md",
    ]);
    const history = await repo.history();
    expect(history[0]).toMatchObject({ source: "agent", session: "s1" });
    expect(history[0]?.summary).toContain("create card b.cards/风险.md");
    // 整批只提交一次：之前的建画布提交之外没有多出来的 user 提交
    expect(history.map((c) => c.source)).toEqual(["agent", "user"]);
    expect(
      readFileSync(path.join(dir, ".canvas", "index.md"), "utf8"),
    ).toContain("b.cards/风险.md");
  });

  test("笔记整批落盘：新建（可顺带放上画布）、改、改名、升格、删；画布上的引用与索引跟着变", async () => {
    const dir = project();
    const repo = repoOf(new LocalEnv(), dir);
    await repo.createBoard("b");
    await repo.createCard("b", { name: "想法", text: "# 想法\n正文" });
    await repo.settle();

    await applyOps(
      repo,
      [
        {
          op: "create_note",
          path: "设计原则",
          text: "# 原则\n见 [[b]]",
          canvas: "b",
        },
        { op: "update", path: "设计原则.md", old: "原则", new: "设计原则" },
        { op: "rename", path: "设计原则.md", name: "原则集" },
        { op: "promote", path: "b.cards/想法.md", to: "产品/想法" },
      ],
      { kind: "agent", session: "s1" },
    );
    const root = path.join(dir, ".canvas");
    expect(readFileSync(path.join(root, "原则集.md"), "utf8")).toBe(
      "# 设计原则\n见 [[b]]",
    );
    expect(existsSync(path.join(root, "设计原则.md"))).toBe(false);
    expect(existsSync(path.join(root, "产品", "想法.md"))).toBe(true);
    expect(existsSync(path.join(root, "b.cards", "想法.md"))).toBe(false);
    const { doc } = await repo.readBoard("b");
    expect(doc.nodes.map((n) => n.file).sort()).toEqual([
      "产品/想法.md",
      "原则集.md",
    ]);
    const index = readFileSync(path.join(root, "index.md"), "utf8");
    expect(index).toContain("no2  原则集.md");
    expect(index).toContain("appears-in: b1\n  links-to: [[b.canvas]]");

    await applyOps(repo, [{ op: "delete", path: "原则集.md" }], {
      kind: "agent",
      session: "s1",
    });
    expect(existsSync(path.join(root, "原则集.md"))).toBe(false);
    expect((await repo.readBoard("b")).doc.nodes.map((n) => n.file)).toEqual([
      "产品/想法.md",
    ]);
  });

  test("改名笔记：别的笔记里的 [[链接]] 跟着改；同一批里先改某篇再改名、先改名再改某篇，结果一样（不会把链接写回旧样子）", async () => {
    for (const order of ["edit-first", "rename-first"] as const) {
      const dir = project();
      const repo = repoOf(new LocalEnv(), dir);
      await repo.createBoard("b");
      await repo.createNote("甲.md", "甲");
      await repo.createNote("乙.md", "乙 见 [[甲]] 与 [[b.canvas]]");
      await repo.settle();
      const edit = {
        op: "update",
        path: "乙.md",
        old: "乙",
        new: "乙乙",
      } as const;
      const rename = { op: "rename", path: "甲.md", name: "甲2" } as const;
      await applyOps(
        repo,
        order === "edit-first" ? [edit, rename] : [rename, edit],
        {
          kind: "agent",
          session: "s1",
        },
      );
      expect(readFileSync(path.join(dir, ".canvas", "乙.md"), "utf8")).toBe(
        "乙乙 见 [[甲2]] 与 [[b.canvas]]",
      );
      // 画布改名同理
      await applyOps(repo, [{ op: "rename", path: "b.canvas", name: "c" }], {
        kind: "agent",
        session: "s1",
      });
      expect(readFileSync(path.join(dir, ".canvas", "乙.md"), "utf8")).toBe(
        "乙乙 见 [[甲2]] 与 [[c.canvas]]",
      );
    }
  });

  test("整批校验失败时什么都不落盘", async () => {
    const dir = project();
    const repo = repoOf(new LocalEnv(), dir);
    await repo.createBoard("b");
    await repo.settle();
    const before = readFileSync(path.join(dir, ".canvas", "b.canvas"), "utf8");
    const err = await applyOps(
      repo,
      [
        { op: "create_card", canvas: "b", name: "新卡", text: "x" },
        { op: "delete", path: "b.cards/不存在.md" },
      ],
      { kind: "agent", session: "s1" },
    ).catch((e) => e);
    expect(err).toMatchObject({ code: "invalid" });
    expect((err as Error).message).toContain("Operation 2 (delete):");
    expect(existsSync(path.join(dir, ".canvas", "b.cards", "新卡.md"))).toBe(
      false,
    );
    expect(readFileSync(path.join(dir, ".canvas", "b.canvas"), "utf8")).toBe(
      before,
    );
  });

  test("落盘中途失败时回滚，工作区回到开始前的样子", async () => {
    const dir = project();
    const env = new FlakyEnv();
    const repo = repoOf(env, dir);
    await repo.createBoard("b");
    await repo.settle();
    const before = readFileSync(path.join(dir, ".canvas", "b.canvas"), "utf8");

    // 每张卡各写一次卡片文件与一次画布：第 3 次写（第二张卡）抛错
    env.writes = 0;
    env.failAt = 4;
    await expect(
      applyOps(
        repo,
        [
          { op: "create_card", canvas: "b", name: "一", text: "1" },
          { op: "create_card", canvas: "b", name: "二", text: "2" },
        ],
        { kind: "agent", session: "s1" },
      ),
    ).rejects.toThrow("disk full");

    expect(readFileSync(path.join(dir, ".canvas", "b.canvas"), "utf8")).toBe(
      before,
    );
    const cards = await repo.listCardFiles("b");
    expect(cards).toEqual([]);
    expect(await repo.isClean()).toBe(true);
  });

  test("项目本身是仓库且有未提交改动：画布回滚只动 .canvas/，项目里的改动原样还在", async () => {
    const dir = project();
    const sh = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    sh("init", "-q");
    writeFileSync(path.join(dir, "mine.txt"), "我的未提交改动");
    const env = new FlakyEnv();
    const repo = repoOf(env, dir);
    await repo.createBoard("b");
    await repo.settle();

    env.writes = 0;
    env.failAt = 2;
    await expect(
      applyOps(
        repo,
        [{ op: "create_card", canvas: "b", name: "一", text: "1" }],
        { kind: "agent", session: "s1" },
      ),
    ).rejects.toThrow("disk full");

    expect(readFileSync(path.join(dir, "mine.txt"), "utf8")).toBe(
      "我的未提交改动",
    );
    expect(sh("status", "--porcelain").trim()).toBe("?? mine.txt");
  });

  test("开始时工作区有外部改动：先按 external 记进历史，再照常落盘", async () => {
    const dir = project();
    const repo = repoOf(new LocalEnv(), dir);
    await repo.createBoard("b");
    await repo.settle();
    writeFileSync(path.join(dir, ".canvas", "notes.md"), "外部写的");
    const lines = await applyOps(
      repo,
      [{ op: "create_card", canvas: "b", name: "卡", text: "x" }],
      { kind: "agent", session: "s1" },
    );
    expect(lines).toHaveLength(1);
    const log = execFileSync(
      "git",
      ["-C", path.join(dir, ".canvas"), "log", "--format=%s"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .trim()
      .split("\n");
    expect(log[1]).toBe("external");
    expect(log[0]?.startsWith("agent:s1 ")).toBe(true);
  });

  test("loadWorld 读出所有画布与卡片文本", async () => {
    const dir = project();
    const repo = repoOf(new LocalEnv(), dir);
    await repo.createBoard("b");
    await repo.createCard("b", { name: "卡", text: "正文" });
    const w = await loadWorld(repo, new Set(["docs/a.md"]));
    expect([...w.boards.keys()]).toEqual(["b"]);
    expect(w.cards.get("b.cards/卡.md")).toBe("正文");
    expect(w.cardNames.get("b")?.has("卡")).toBe(true);
    expect(w.projectFile("docs/a.md")).toBe(true);
    expect(w.projectFile("docs/b.md")).toBe(false);
  });
});
