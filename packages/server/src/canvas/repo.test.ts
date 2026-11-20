import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv, ExecOptions } from "../env/types.js";
import { CanvasConflict, CanvasError, CanvasRepo } from "./repo.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 临时项目目录（不是 git 仓库，验证 ensure 自己处理）。 */
function project(): string {
  const d = mkdtempSync(path.join(tmpdir(), "yuanshu-canvas-"));
  dirs.push(d);
  return d;
}

const repoOf = (dir: string, opts: { commitDelayMs?: number } = {}) =>
  new CanvasRepo(new LocalEnv(), dir, { commitDelayMs: 50, ...opts });

/** 还没有提交时 `git log` 失败，这里当空列表。 */
const gitLogSoft = (dir: string): string[] => {
  try {
    return gitLog(dir);
  } catch {
    return [];
  }
};

const gitLog = (dir: string): string[] =>
  execFileSync("git", ["-C", path.join(dir, ".canvas"), "log", "--format=%s"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .trim()
    .split("\n")
    .filter(Boolean);

/** git 不可用的环境：命令一律失败。 */
class NoGitEnv extends LocalEnv {
  override async exec(_command: string, _cwd: string, _o: ExecOptions) {
    return { exitCode: 127 };
  }
}

describe("CanvasRepo：读", () => {
  test("纯读不建任何东西", async () => {
    const dir = project();
    const repo = repoOf(dir);
    expect(await repo.status()).toEqual({ ready: false, git: "missing" });
    expect(await repo.listBoards()).toEqual([]);
    expect(await repo.history()).toEqual([]);
    expect(existsSync(path.join(dir, ".canvas"))).toBe(false);
  });

  test("第一次写才建 .canvas/ 与 git 仓库", async () => {
    const dir = project();
    const repo = repoOf(dir);
    const name = await repo.createBoard("产品想法");
    expect(name).toBe("产品想法");
    expect(existsSync(path.join(dir, ".canvas", "产品想法.canvas"))).toBe(true);
    expect(existsSync(path.join(dir, ".canvas", "产品想法.cards"))).toBe(true);
    expect(existsSync(path.join(dir, ".canvas", ".git"))).toBe(true);
    expect(await repo.status()).toEqual({ ready: true, git: "ok" });
  });

  test("createBoard 清洗名字、空名用时间、重名加序号", async () => {
    const dir = project();
    const repo = repoOf(dir);
    expect(await repo.createBoard("想 法*一")).toBe("想 法一");
    expect(await repo.createBoard("想 法*一")).toBe("想 法一 (2)");
    expect(await repo.createBoard("   ")).toMatch(/^\d{8}-\d{6}$/);
    // 名字留空但选了文件夹：以斜杠结尾，在那个文件夹里用时间命名
    expect(await repo.createBoard("产品/")).toMatch(/^产品\/\d{8}-\d{6}$/);
    expect(await repo.createBoard("产品/")).toMatch(
      /^产品\/\d{8}-\d{6}( \(2\))?$/,
    );
  });

  test("画布可以在子目录里，旧布局 boards/ 下的也认；卡片跟在画布旁边；改名只改最后一段", async () => {
    const dir = project();
    const repo = repoOf(dir);
    expect(await repo.createBoard("产品/时间线")).toBe("产品/时间线");
    mkdirSync(path.join(dir, ".canvas", "boards"), { recursive: true });
    writeFileSync(
      path.join(dir, ".canvas", "boards", "旧.canvas"),
      '{"nodes":[],"edges":[]}',
    );
    expect((await repo.listBoards()).map((b) => b.name)).toEqual([
      "boards/旧",
      "产品/时间线",
    ]);
    const made = await repo.createCard("产品/时间线", { name: "a", text: "x" });
    expect(made.path).toBe("产品/时间线.cards/a.md");
    expect(await repo.renameBoard("产品/时间线", "路线图")).toBe("产品/路线图");
    expect(
      existsSync(path.join(dir, ".canvas", "产品", "路线图.cards", "a.md")),
    ).toBe(true);
    await repo.deleteBoard("产品/路线图");
    expect((await repo.listBoards()).map((b) => b.name)).toEqual(["boards/旧"]);
  });

  test("笔记改名 / 画布改名：别的笔记（和它自己）里指向它的 [[…]] 跟着改，写没写扩展名、别名都照原样，代码里的与不相干的不动；画布上的节点也跟着", async () => {
    const dir = project();
    const repo = repoOf(dir);
    const root = path.join(dir, ".canvas");
    await repo.createBoard("板");
    await repo.createNote("目录/甲.md", "自指 [[目录/甲]]，见 [[乙]]");
    await repo.createNote(
      "乙.md",
      "[[目录/甲.md|甲]] [[板.canvas]] [[板]] `[[目录/甲]]` [[丙]]",
    );
    await repo.createNote("丙.md", "没有链接");
    const { doc, baseline } = await repo.readBoard("板");
    doc.nodes.push({
      id: "n1",
      type: "file",
      file: "目录/甲.md",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    await repo.saveBoard("板", doc, baseline);

    await repo.moveNote("目录/甲.md", "归档/甲2.md");
    expect(readFileSync(path.join(root, "归档", "甲2.md"), "utf8")).toBe(
      "自指 [[归档/甲2]]，见 [[乙]]",
    );
    expect(readFileSync(path.join(root, "乙.md"), "utf8")).toBe(
      "[[归档/甲2.md|甲]] [[板.canvas]] [[板]] `[[目录/甲]]` [[丙]]",
    );
    expect((await repo.readBoard("板")).doc.nodes[0]?.file).toBe("归档/甲2.md");

    expect(await repo.renameBoard("板", "新板")).toBe("新板");
    expect(readFileSync(path.join(root, "乙.md"), "utf8")).toBe(
      "[[归档/甲2.md|甲]] [[新板.canvas]] [[新板]] `[[目录/甲]]` [[丙]]",
    );
    expect(readFileSync(path.join(root, "丙.md"), "utf8")).toBe("没有链接");
  });

  /** 把一个文件节点放进画布（测试用）。 */
  const put = async (repo: CanvasRepo, board: string, file: string) => {
    const { doc, baseline } = await repo.readBoard(board);
    doc.nodes.push({
      id: `n${doc.nodes.length}${file.length}`,
      type: "file",
      file,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    await repo.saveBoard(board, doc, baseline);
  };

  test("moveBoard：画布连同卡片与资源文件夹挪到别的文件夹，节点路径与笔记里的 [[画布]] 都跟着改；重名、非法名字、不存在都报错", async () => {
    const dir = project();
    const repo = repoOf(dir);
    const root = path.join(dir, ".canvas");
    await repo.createBoard("板");
    await repo.createCard("板", { name: "卡", text: "x" });
    await repo.createNote("笔.md", "见 [[板]] 与 [[板.canvas]]");
    expect(await repo.moveBoard("板", "产品/新板")).toBe("产品/新板");
    expect(existsSync(path.join(root, "产品", "新板.canvas"))).toBe(true);
    expect(existsSync(path.join(root, "产品", "新板.cards", "卡.md"))).toBe(
      true,
    );
    expect(existsSync(path.join(root, "板.canvas"))).toBe(false);
    expect(existsSync(path.join(root, "板.cards"))).toBe(false);
    expect((await repo.readBoard("产品/新板")).doc.nodes[0]?.file).toBe(
      "产品/新板.cards/卡.md",
    );
    expect(readFileSync(path.join(root, "笔.md"), "utf8")).toBe(
      "见 [[产品/新板]] 与 [[产品/新板.canvas]]",
    );

    await repo.createBoard("另一块");
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: CanvasError) => e.code,
      );
    expect(await code(repo.moveBoard("另一块", "产品/新板"))).toBe("exists");
    expect(await code(repo.moveBoard("另一块", "../x"))).toBe("invalid_path");
    expect(await code(repo.moveBoard("另一块", "a.cards/x"))).toBe(
      "invalid_path",
    );
    expect(await code(repo.moveBoard("不存在", "x"))).toBe("not_found");
    expect(await repo.moveBoard("另一块", "另一块")).toBe("另一块");
  });

  test("文件夹：新建（空的也在树里）、挪动（里面的画布与笔记、节点引用、[[链接]] 一起改）、不能挪进自己、目标已存在报错；删除连带去掉别的画布上的笔记节点", async () => {
    const dir = project();
    const repo = repoOf(dir);
    const root = path.join(dir, ".canvas");
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: CanvasError) => e.code,
      );
    await repo.createFolder("空");
    expect((await repo.listTree()).folders).toEqual(["空"]);
    expect(await code(repo.createFolder("空"))).toBe("exists");
    expect(await code(repo.createFolder("a.cards"))).toBe("invalid_path");
    expect(await code(repo.createFolder("a.md"))).toBe("invalid_path");
    expect(await code(repo.createFolder("x/b.canvas"))).toBe("invalid_path");

    await repo.createBoard("项/图");
    await repo.createCard("项/图", { name: "卡", text: "c" });
    await repo.createNote("项/记.md", "内");
    await repo.createNote("外.md", "[[项/记]] [[项/图]]");
    await repo.createBoard("外板");
    await put(repo, "项/图", "项/记.md");
    await put(repo, "外板", "项/记.md");

    await repo.moveFolder("项", "归/新项");
    const tree = await repo.listTree();
    expect(tree.folders).toEqual(["归", "归/新项", "空"]);
    expect(tree.boards.map((b) => b.name)).toEqual(["外板", "归/新项/图"]);
    expect(tree.notes).toEqual(["外.md", "归/新项/记.md"]);
    const inner = (await repo.readBoard("归/新项/图")).doc.nodes.map(
      (n) => n.file,
    );
    expect(inner).toEqual(["归/新项/图.cards/卡.md", "归/新项/记.md"]);
    expect((await repo.readBoard("外板")).doc.nodes[0]?.file).toBe(
      "归/新项/记.md",
    );
    expect(readFileSync(path.join(root, "外.md"), "utf8")).toBe(
      "[[归/新项/记]] [[归/新项/图]]",
    );

    expect(await code(repo.moveFolder("归", "归/内"))).toBe("invalid");
    await repo.createFolder("占");
    expect(await code(repo.moveFolder("归", "占"))).toBe("exists");
    expect(await code(repo.moveFolder("没有", "x"))).toBe("not_found");
    expect(await code(repo.moveFolder("归", "b.assets"))).toBe("invalid_path");

    await repo.deleteFolder("归/新项");
    expect((await repo.readBoard("外板")).doc.nodes).toEqual([]);
    expect((await repo.listTree()).notes).toEqual(["外.md"]);
    expect(existsSync(path.join(root, "归", "新项"))).toBe(false);
    expect(await code(repo.deleteFolder("归/新项"))).toBe("not_found");
  });

  test("referrers：哪些画布放着这篇笔记、哪些笔记的 [[链接]] 指向它（画布只看笔记）；不存在 / 不是笔记画布报错", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("甲板");
    await repo.createBoard("乙板");
    await repo.createNote("目标.md", "x");
    await repo.createNote("链.md", "见 [[目标]] 与 [[甲板]]");
    await repo.createNote("无关.md", "[[别的]]");
    await put(repo, "甲板", "目标.md");
    expect(await repo.referrers("目标.md")).toEqual({
      boards: ["甲板"],
      notes: ["链.md"],
    });
    expect(await repo.referrers("甲板.canvas")).toEqual({
      boards: [],
      notes: ["链.md"],
    });
    for (const bad of ["没有.md", "甲板.cards/x.md", "../x.md"])
      await expect(repo.referrers(bad)).rejects.toBeInstanceOf(CanvasError);
  });

  test("readBoard 给出文档、基线与每个引用文件的 FileInfo", async () => {
    const dir = project();
    writeFileSync(path.join(dir, "design.md"), "# 设计\n\n正文");
    writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0, 1]));
    const repo = repoOf(dir);
    await repo.createBoard("b");
    const { path: cardPath } = await repo.createCard("b", {
      name: "风险",
      text: "第一行\n第二行",
    });
    const { doc, baseline } = await repo.readBoard("b");
    expect(doc.nodes).toHaveLength(1);
    expect(typeof baseline.sha256).toBe("string");
    expect(baseline.mtimeMs).toBeGreaterThan(0);
    const read = await repo.readCard(cardPath);
    expect(read.text).toBe("第一行\n第二行");

    // 资源文件夹里的卡片是 card；项目文件引用只给存在与大小（.md 顺带给预览）
    const files = (await repo.readBoard("b")).files;
    expect(files[cardPath]).toMatchObject({
      exists: true,
      kind: "card",
      preview: "第一行\n第二行",
    });
    expect(files["../logo.png"]).toBeUndefined();
    const withRefs = await repo.readBoard("b");
    expect(Object.keys(withRefs.files)).toEqual([cardPath]);
  });

  test("别的主机上的引用：用那台主机的环境读信息，连不上是 unreachable 而不是缺失；索引里不为它们查远端", async () => {
    const dir = project();
    const other = project();
    writeFileSync(path.join(other, "notes.md"), "# 远端笔记\n\n正文");
    writeFileSync(path.join(other, "pic.png"), Buffer.alloc(64, 1));
    const asked: string[] = [];
    const broken = new LocalEnv();
    broken.stat = async () => {
      throw new Error("connection lost");
    };
    const envs: Record<string, ExecEnv> = { remote: new LocalEnv(), broken };
    const main = new LocalEnv();
    const statted: string[] = [];
    const stat = main.stat.bind(main);
    main.stat = async (p) => {
      statted.push(p);
      return stat(p);
    };
    const repo = new CanvasRepo(main, dir, {
      commitDelayMs: 50,
      envOf: (id) => {
        asked.push(id);
        return envs[id] ?? null;
      },
      hostLabel: (id) => (id === "remote" ? "dev-01" : id),
    });
    await repo.createBoard("b");
    const { doc, baseline } = await repo.readBoard("b");
    const at = (id: string, file: string, host: string, x: number) => ({
      id,
      type: "file",
      file,
      host,
      x,
      y: 0,
      width: 260,
      height: 160,
    });
    const md = path.join(other, "notes.md");
    doc.nodes.push(
      at("r1", md, "remote", 0),
      at("r2", path.join(other, "pic.png"), "remote", 300),
      at("r3", path.join(other, "none.md"), "remote", 600),
      at("r4", md, "ghost", 900),
      at("r5", md, "broken", 1200),
    );
    await repo.saveBoard("b", doc, baseline);
    await repo.settle();

    asked.length = 0;
    const { files } = await repo.readBoard("b");
    expect(files[`remote:${md}`]).toMatchObject({
      exists: true,
      kind: "ref",
      preview: "# 远端笔记\n\n正文",
    });
    expect(files[`remote:${path.join(other, "pic.png")}`]).toMatchObject({
      exists: true,
      size: 64,
    });
    expect(files[`remote:${path.join(other, "none.md")}`]).toEqual({
      exists: false,
      kind: "ref",
    });
    // 主机取不到（没连上 / 已删）与连接中途断开：都是 unreachable，不是缺失
    expect(files[`ghost:${md}`]).toEqual({
      exists: false,
      kind: "ref",
      unreachable: true,
    });
    expect(files[`broken:${md}`]).toMatchObject({ unreachable: true });
    // 同一路径在不同主机上是两条信息
    expect(
      Object.keys(files).filter((k) => k.endsWith("notes.md")),
    ).toHaveLength(3);

    // probeRemote：是文件 / 不存在 / 连不上
    expect(await repo.probeRemote("remote", md)).toBe("file");
    expect(await repo.probeRemote("remote", other)).toBe("missing");
    expect(await repo.probeRemote("ghost", md)).toBe("unreachable");
    expect(await repo.probeRemote("broken", md)).toBe("unreachable");

    // 索引里写主机名与路径，生成索引时不去问那些主机
    const again = await repo.readBoard("b");
    asked.length = 0;
    statted.length = 0;
    await repo.saveBoard("b", again.doc, again.baseline);
    await repo.settle();
    // 生成索引时也不会拿本机去查那些远端路径
    expect(statted.filter((p) => p.startsWith(other))).toEqual([]);
    const index = readFileSync(path.join(dir, ".canvas", "index.md"), "utf8");
    expect(index).toContain(`ref  dev-01:${md}`);
    expect(asked).toEqual([]);
  });

  test("FileInfo：非 md 的引用带 mtimeMs；长卡片带 truncated", async () => {
    const dir = project();
    writeFileSync(path.join(dir, "logo.png"), Buffer.alloc(1024, 1));
    const repo = repoOf(dir);
    await repo.createBoard("b");
    const { path: rel } = await repo.createCard("b", {
      name: "长",
      text: "字".repeat(5000),
    });
    const { doc } = await repo.readBoard("b");
    doc.nodes.push({
      id: "n1",
      type: "file",
      file: "../logo.png",
      x: 400,
      y: 0,
      width: 260,
      height: 160,
    });
    await repo.saveBoard("b", doc);
    const files = (await repo.readBoard("b")).files;
    // 前端拼图片 URL 的 v 参数要用它
    expect(files["../logo.png"]).toMatchObject({
      exists: true,
      kind: "ref",
      size: 1024,
    });
    expect(files["../logo.png"]?.mtimeMs).toBeGreaterThan(0);
    expect(files["../logo.png"]?.preview).toBeUndefined();
    expect(files[rel]?.preview).toHaveLength(4000);
    expect(files[rel]?.truncated).toBe(true);
  });

  test("FileInfo：短卡片不带 truncated", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    const { path: rel } = await repo.createCard("b", { name: "短", text: "x" });
    const files = (await repo.readBoard("b")).files;
    expect(files[rel]).toMatchObject({
      exists: true,
      kind: "card",
      preview: "x",
    });
    expect(files[rel]?.truncated).toBeUndefined();
  });

  test("画布文件坏掉时抛 format 错误", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    writeFileSync(path.join(dir, ".canvas", "b.canvas"), "{oops");
    await expect(repo.readBoard("b")).rejects.toMatchObject({ code: "format" });
  });

  test("readCard 只接受 *.cards/*.md", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await expect(repo.readCard("../x.md")).rejects.toMatchObject({
      code: "invalid_path",
    });
    await expect(repo.readCard("b.canvas")).rejects.toMatchObject({
      code: "invalid_path",
    });
    await expect(repo.readCard("b.cards/gone.md")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("CanvasRepo：写", () => {
  test("saveCard 原子写：不留临时文件，基线跟着变", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    const { path: rel } = await repo.createCard("b", { text: "old" });
    const before = await repo.readCard(rel);
    const after = await repo.saveCard(rel, "new", before.baseline);
    expect(after.sha256).not.toBe(before.baseline.sha256);
    expect(readFileSync(path.join(dir, ".canvas", rel), "utf8")).toBe("new");
    const names = readdirSync(path.join(dir, ".canvas", "b.cards"));
    expect(names.filter((n) => n.endsWith(".part"))).toEqual([]);
  });

  test("基线不符抛 CanvasConflict，current 带磁盘上的当前值", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    const { path: rel } = await repo.createCard("b", { text: "old" });
    const stale = { mtimeMs: 1, sha256: "0".repeat(64) };
    const err = await repo.saveCard(rel, "new", stale).catch((e) => e);
    expect(err).toBeInstanceOf(CanvasConflict);
    const conflict = err as CanvasConflict;
    expect(conflict.current.sha256).toBe(
      (await repo.readCard(rel)).baseline.sha256,
    );
    expect(readFileSync(path.join(dir, ".canvas", rel), "utf8")).toBe("old");
  });

  test("saveBoard 同样按基线判冲突，序列化保留未知字段", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    const { doc, baseline } = await repo.readBoard("b");
    doc.color = "5";
    doc.nodes.push({
      id: "n1",
      type: "text",
      text: "手写",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    await repo.saveBoard("b", doc, baseline);
    const again = await repo.readBoard("b");
    expect(again.doc.color).toBe("5");
    expect(again.doc.nodes[0]?.text).toBe("手写");
    await expect(repo.saveBoard("b", doc, baseline)).rejects.toBeInstanceOf(
      CanvasConflict,
    );
  });

  describe("saveBatch：一次保存画布、改过的卡片与新卡片", () => {
    const fileNode = (id: string, file: string, x = 0) => ({
      id,
      type: "file",
      file,
      x,
      y: 0,
      width: 260,
      height: 160,
    });

    test("改过的卡片、两张新卡片（一张是空的）与文档一次写好：新卡片的节点指向建出来的文件，只提交一次", async () => {
      const dir = project();
      const repo = repoOf(dir, { commitDelayMs: 10_000 });
      await repo.createBoard("b");
      const { path: old } = await repo.createCard("b", { text: "旧" });
      const read = await repo.readBoard("b");
      const card = await repo.readCard(old);
      await repo.settle();
      const logBefore = gitLog(dir).length;

      const doc = read.doc;
      doc.nodes.push(
        fileNode("n1", "::new:1", 300),
        fileNode("n2", "::new:2", 600),
      );
      const r = await repo.saveBatch("b", {
        doc,
        expect: read.baseline,
        edits: [{ path: old, text: "新", expect: card.baseline }],
        created: [
          { nodeId: "n1", text: "第一张" },
          { nodeId: "n2", text: "" },
        ],
      });

      expect(r.conflicts).toEqual([]);
      expect(r.edits.map((e) => e.path)).toEqual([old]);
      expect(r.created.map((c) => c.nodeId)).toEqual(["n1", "n2"]);
      // 两张新卡片同一秒建出来也不重名
      expect(new Set(r.created.map((c) => c.path)).size).toBe(2);
      const abs = (rel: string) => path.join(dir, ".canvas", rel);
      expect(readFileSync(abs(old), "utf8")).toBe("新");
      expect(readFileSync(abs(r.created[0]?.path as string), "utf8")).toBe(
        "第一张",
      );
      expect(readFileSync(abs(r.created[1]?.path as string), "utf8")).toBe("");
      const after = await repo.readBoard("b");
      expect(after.doc.nodes.map((n) => n.file)).toEqual([
        old,
        r.created[0]?.path,
        r.created[1]?.path,
      ]);
      // 返回的基线就是磁盘上的基线，不用再读一遍
      expect(r.baseline).toEqual(after.baseline);
      expect(r.edits[0]?.baseline).toEqual((await repo.readCard(old)).baseline);
      expect(r.created[0]?.baseline).toEqual(
        (await repo.readCard(r.created[0]?.path as string)).baseline,
      );
      // 一次保存只生成一次提交，来源是用户
      await repo.settle();
      const log = gitLog(dir);
      expect(log).toHaveLength(logBefore + 1);
      expect(log[0]?.startsWith("user ")).toBe(true);
      expect(readFileSync(abs("index.md"), "utf8")).toContain("第一张");
    });

    test("文档基线过期：整批拒绝，卡片没改、新卡片没建", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createBoard("b");
      const { path: old } = await repo.createCard("b", { text: "旧" });
      const read = await repo.readBoard("b");
      const card = await repo.readCard(old);
      read.doc.nodes.push(fileNode("n1", "::new:1"));
      const stale = { mtimeMs: 1, sha256: "0".repeat(64) };
      await expect(
        repo.saveBatch("b", {
          doc: read.doc,
          expect: stale,
          edits: [{ path: old, text: "新", expect: card.baseline }],
          created: [{ nodeId: "n1", text: "x" }],
        }),
      ).rejects.toBeInstanceOf(CanvasConflict);
      expect(readFileSync(path.join(dir, ".canvas", old), "utf8")).toBe("旧");
      expect(readdirSync(path.join(dir, ".canvas", "b.cards"))).toHaveLength(1);
    });

    test("某张卡片被别处改过：只跳过它并列出来，其余照常写", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createBoard("b");
      const { path: a } = await repo.createCard("b", { name: "a", text: "a0" });
      const { path: b } = await repo.createCard("b", { name: "b", text: "b0" });
      const baseA = (await repo.readCard(a)).baseline;
      const baseB = (await repo.readCard(b)).baseline;
      await repo.saveCard(a, "别处改的");
      const r = await repo.saveBatch("b", {
        edits: [
          { path: a, text: "我的a", expect: baseA },
          { path: b, text: "我的b", expect: baseB },
        ],
        created: [],
      });
      expect(r.conflicts).toEqual([a]);
      expect(r.edits.map((e) => e.path)).toEqual([b]);
      expect(readFileSync(path.join(dir, ".canvas", a), "utf8")).toBe(
        "别处改的",
      );
      expect(readFileSync(path.join(dir, ".canvas", b), "utf8")).toBe("我的b");
    });

    test("只改卡片正文时不碰画布文档", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createBoard("b");
      const { path: a } = await repo.createCard("b", { text: "0" });
      const docBefore = await repo.readBoard("b");
      const r = await repo.saveBatch("b", {
        edits: [{ path: a, text: "1" }],
        created: [],
      });
      expect(r.baseline).toBeNull();
      expect((await repo.readBoard("b")).baseline).toEqual(docBefore.baseline);
    });

    test("卡片不存在、新卡片要的节点不在文档里、新卡片没带文档、卡片属于别的画布：整批拒绝，什么都不写", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createBoard("b");
      await repo.createBoard("c");
      const { path: a } = await repo.createCard("b", { text: "0" });
      const { path: other } = await repo.createCard("c", { text: "x" });
      const read = await repo.readBoard("b");
      const code = async (p: Promise<unknown>) =>
        ((await p.catch((e) => e)) as CanvasError).code;

      expect(
        await code(
          repo.saveBatch("b", {
            edits: [
              { path: a, text: "1" },
              { path: "b.cards/没有.md", text: "1" },
            ],
            created: [],
          }),
        ),
      ).toBe("not_found");
      expect(
        await code(
          repo.saveBatch("b", {
            doc: read.doc,
            edits: [],
            created: [{ nodeId: "不存在", text: "" }],
          }),
        ),
      ).toBe("invalid");
      expect(
        await code(
          repo.saveBatch("b", {
            edits: [],
            created: [{ nodeId: "n", text: "" }],
          }),
        ),
      ).toBe("invalid");
      expect(
        await code(
          repo.saveBatch("b", {
            edits: [{ path: other, text: "1" }],
            created: [],
          }),
        ),
      ).toBe("invalid_path");
      // 前面的卡片 a 也没被写
      expect(readFileSync(path.join(dir, ".canvas", a), "utf8")).toBe("0");
    });
  });

  describe("笔记里的图片（<文件夹>/.assets/<笔记名>/）", () => {
    const abs = (dir: string, rel: string) => path.join(dir, ".canvas", rel);
    const upload = async (
      repo: CanvasRepo,
      note: string,
      name: string,
      bytes: Buffer,
      gitMaxBytes = 1024,
    ) => {
      const { tmp } = await repo.startNoteAsset(note);
      writeFileSync(tmp, bytes);
      return repo.finishNoteAsset(note, tmp, {
        name,
        size: bytes.length,
        gitMaxBytes,
      });
    };

    test("存进笔记所在文件夹的 .assets/<笔记名>/（根目录的笔记在 .canvas/.assets/<笔记名>/）；重名加 (2)；大的进 _large/（不进画布的 git）；不改任何画布文档、不加节点", async () => {
      const dir = project();
      const repo = repoOf(dir, { commitDelayMs: 10_000 });
      await repo.createBoard("板");
      await repo.createNote("产品/访谈.md", "x");
      await repo.createNote("总览.md", "x");
      const boardBefore = readFileSync(abs(dir, "板.canvas"), "utf8");
      const a = await upload(
        repo,
        "产品/访谈.md",
        "图.PNG",
        Buffer.alloc(10, 1),
      );
      expect(a).toEqual({ path: "产品/.assets/访谈/图.png", large: false });
      const b = await upload(
        repo,
        "产品/访谈.md",
        "图.png",
        Buffer.alloc(10, 2),
      );
      expect(b.path).toBe("产品/.assets/访谈/图 (2).png");
      const big = await upload(
        repo,
        "产品/访谈.md",
        "clip.mp4",
        Buffer.alloc(5000, 3),
      );
      expect(big).toEqual({
        path: "产品/.assets/访谈/_large/clip.mp4",
        large: true,
      });
      const root = await upload(repo, "总览.md", "x.png", Buffer.alloc(10, 4));
      expect(root.path).toBe(".assets/总览/x.png");
      expect(readFileSync(abs(dir, a.path)).length).toBe(10);
      expect(readFileSync(abs(dir, "板.canvas"), "utf8")).toBe(boardBefore);
      await repo.settle();
      const tracked = execFileSync(
        "git",
        ["-C", abs(dir, ""), "-c", "core.quotepath=off", "ls-files"],
        { encoding: "utf8" },
      );
      expect(tracked).toContain("产品/.assets/访谈/图.png");
      expect(tracked).toContain(".assets/总览/x.png");
      expect(tracked).not.toContain("clip.mp4");
    });

    test("资源夹是隐藏的：不出现在树里（文件夹、笔记都不算）", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createNote("产品/访谈.md", "x");
      await upload(repo, "产品/访谈.md", "a.png", Buffer.alloc(5));
      const tree = await repo.listTree();
      expect(tree.folders).toEqual(["产品"]);
      expect(tree.notes).toEqual(["产品/访谈.md"]);
    });

    test("笔记不存在 404；不是笔记路径 400；discardAsset 删掉临时文件", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await expect(repo.startNoteAsset("没有.md")).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(repo.startNoteAsset("板.canvas")).rejects.toMatchObject({
        code: "invalid_path",
      });
      await repo.createNote("甲.md", "x");
      const { tmp } = await repo.startNoteAsset("甲.md");
      writeFileSync(tmp, "half");
      await repo.discardAsset(tmp);
      expect(existsSync(tmp)).toBe(false);
    });

    test("笔记改名：资源夹跟着改名，正文里指向它的相对链接（含编码的）改到新名；挪到别的文件夹（名字不变）：资源夹跟着走、链接不用改，原来的空 .assets/ 收掉", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createNote(
        "访谈 一.md",
        "![](./.assets/访谈%20一/a%20b.png)\n[[别的]] ![](./.assets/别的/z.png)",
      );
      await upload(repo, "访谈 一.md", "a b.png", Buffer.alloc(10, 1));
      await repo.moveNote("访谈 一.md", "总结.md");
      expect(existsSync(abs(dir, ".assets/访谈 一"))).toBe(false);
      expect(existsSync(abs(dir, ".assets/总结/a b.png"))).toBe(true);
      expect(readFileSync(abs(dir, "总结.md"), "utf8")).toBe(
        "![](./.assets/总结/a%20b.png)\n[[别的]] ![](./.assets/别的/z.png)",
      );
      await repo.moveNote("总结.md", "归档/总结.md");
      expect(existsSync(abs(dir, "归档/.assets/总结/a b.png"))).toBe(true);
      expect(existsSync(abs(dir, ".assets"))).toBe(false);
      expect(readFileSync(abs(dir, "归档/总结.md"), "utf8")).toContain(
        "![](./.assets/总结/a%20b.png)",
      );
    });

    test("同一个 .assets/ 里还有别的笔记的图片：只挪自己的，不动别人的", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createNote("甲.md", "x");
      await repo.createNote("乙.md", "x");
      await upload(repo, "甲.md", "a.png", Buffer.alloc(5));
      await upload(repo, "乙.md", "b.png", Buffer.alloc(5));
      await repo.moveNote("甲.md", "丙.md");
      expect(existsSync(abs(dir, ".assets/丙/a.png"))).toBe(true);
      expect(existsSync(abs(dir, ".assets/乙/b.png"))).toBe(true);
      expect(existsSync(abs(dir, ".assets/甲"))).toBe(false);
    });

    test("目标位置已有同名资源夹：报 exists，什么都没挪；没有资源夹的笔记照常改名", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createNote("甲.md", "x");
      await upload(repo, "甲.md", "a.png", Buffer.alloc(5));
      mkdirSync(abs(dir, ".assets/乙"), { recursive: true });
      await expect(repo.moveNote("甲.md", "乙.md")).rejects.toMatchObject({
        code: "exists",
      });
      expect(existsSync(abs(dir, "甲.md"))).toBe(true);
      expect(existsSync(abs(dir, ".assets/甲/a.png"))).toBe(true);
      await repo.createNote("丙.md", "无图");
      await repo.moveNote("丙.md", "丁.md");
      expect(existsSync(abs(dir, "丁.md"))).toBe(true);
    });

    test("删除笔记：它的资源夹一起删，删空了的 .assets/ 也收掉；别的笔记的图片留着；同名画布互不相干", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createNote("甲.md", "x");
      await upload(repo, "甲.md", "a.png", Buffer.alloc(5));
      await repo.deleteNote("甲.md");
      expect(existsSync(abs(dir, ".assets"))).toBe(false);

      await repo.createNote("乙.md", "x");
      await repo.createNote("丙.md", "x");
      await upload(repo, "乙.md", "b.png", Buffer.alloc(5));
      await upload(repo, "丙.md", "c.png", Buffer.alloc(5));
      await repo.deleteNote("乙.md");
      expect(existsSync(abs(dir, ".assets/乙"))).toBe(false);
      expect(existsSync(abs(dir, ".assets/丙/c.png"))).toBe(true);

      // 同名画布的资源夹是 <画布>.assets/，与笔记的 .assets/<笔记名>/ 不是一个地方
      await repo.createBoard("丙");
      await repo.deleteNote("丙.md");
      expect(existsSync(abs(dir, ".assets"))).toBe(false);
      expect(existsSync(abs(dir, "丙.canvas"))).toBe(true);
    });

    test("整个文件夹挪走 / 删除：里面笔记的资源夹跟着（本来就在文件夹里）", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createFolder("产品");
      await repo.createNote("产品/甲.md", "![](./.assets/甲/a.png)");
      await upload(repo, "产品/甲.md", "a.png", Buffer.alloc(5));
      await repo.moveFolder("产品", "归档");
      expect(existsSync(abs(dir, "归档/.assets/甲/a.png"))).toBe(true);
      await repo.deleteFolder("归档");
      expect(existsSync(abs(dir, "归档"))).toBe(false);
    });
  });

  describe("资源（粘贴 / 拖进画布的文件）", () => {
    /** 把 bytes 当作上传完的内容放进画布，返回结果 */
    const upload = async (
      repo: CanvasRepo,
      board: string,
      name: string,
      bytes: Buffer,
      over: { gitMaxBytes?: number; at?: { x: number; y: number } } = {},
    ) => {
      const { tmp } = await repo.startAsset(board);
      writeFileSync(tmp, bytes);
      return repo.finishAsset(board, tmp, {
        name,
        size: bytes.length,
        gitMaxBytes: over.gitMaxBytes ?? 1024,
        ...(over.at ? { at: over.at } : {}),
      });
    };
    const abs = (dir: string, rel: string) => path.join(dir, ".canvas", rel);

    test("小文件放进资源文件夹并带节点；大文件放进 _large/ 且不进画布的 git；重名加序号、保留扩展名", async () => {
      const dir = project();
      const repo = repoOf(dir, { commitDelayMs: 10_000 });
      await repo.createBoard("b");
      const small = await upload(repo, "b", "Photo.PNG", Buffer.alloc(100, 1), {
        at: { x: 40, y: 50 },
      });
      expect(small).toMatchObject({
        path: "b.assets/Photo.png",
        large: false,
      });
      const again = await upload(repo, "b", "Photo.png", Buffer.alloc(100, 2));
      expect(again.path).toBe("b.assets/Photo (2).png");
      const big = await upload(repo, "b", "clip.mp4", Buffer.alloc(5000, 3));
      expect(big).toMatchObject({
        path: "b.assets/_large/clip.mp4",
        large: true,
      });
      // 与小文件文件夹里的同名也要避让
      const dup = await upload(repo, "b", "photo.png", Buffer.alloc(5000, 4));
      expect(dup.path).toBe("b.assets/_large/photo (3).png");

      const { doc } = await repo.readBoard("b");
      expect(doc.nodes.map((n) => n.file)).toEqual([
        small.path,
        again.path,
        big.path,
        dup.path,
      ]);
      expect(doc.nodes[0]).toMatchObject({ id: small.nodeId, x: 40, y: 50 });
      expect(readFileSync(abs(dir, big.path)).length).toBe(5000);
      // 没有留下临时文件
      for (const d of ["b.assets", "b.assets/_large"])
        expect(
          readdirSync(abs(dir, d)).filter((n) => n.endsWith(".part")),
        ).toEqual([]);

      // 提交后：小文件在历史里，大文件不在（也不会被报成「有未提交的改动」）
      await repo.settle();
      const tracked = execFileSync(
        "git",
        ["-C", path.join(dir, ".canvas"), "ls-files"],
        { encoding: "utf8" },
      );
      expect(tracked).toContain("b.assets/Photo.png");
      expect(tracked).not.toContain("_large");
      expect(await repo.isClean()).toBe(true);
    });

    test("同名只存在于 _large/ 里也要避让（不能覆盖旧文件）；恰好等于上限的算小文件（只有「超过」才不进历史）", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createBoard("b");
      const first = await upload(repo, "b", "x.mp4", Buffer.alloc(5000, 1));
      const second = await upload(repo, "b", "x.mp4", Buffer.alloc(5000, 2));
      expect(first.path).toBe("b.assets/_large/x.mp4");
      expect(second.path).toBe("b.assets/_large/x (2).mp4");
      expect(readFileSync(abs(dir, first.path))[0]).toBe(1);
      expect(readFileSync(abs(dir, second.path))[0]).toBe(2);

      const edge = await upload(repo, "b", "edge.bin", Buffer.alloc(1024, 3), {
        gitMaxBytes: 1024,
      });
      expect(edge).toMatchObject({ large: false });
      const over = await upload(repo, "b", "over.bin", Buffer.alloc(1025, 3), {
        gitMaxBytes: 1024,
      });
      expect(over).toMatchObject({ large: true });
    });

    test("文件名清洗：路径分隔符、非法字符去掉，名字清洗后是空就用时间；没有扩展名也行", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createBoard("b");
      const a = await upload(repo, "b", "a/b\\c:d.txt", Buffer.alloc(1, 1));
      expect(a.path).toMatch(/^b\.assets\/[^/]+\.txt$/);
      expect(a.path).not.toMatch(/[\\:]/);
      const noExt = await upload(repo, "b", "README", Buffer.alloc(1, 1));
      expect(noExt.path).toBe("b.assets/README");
      const blank = await upload(repo, "b", "...png", Buffer.alloc(1, 1));
      expect(blank.path).toMatch(/^b\.assets\/\d{8}-\d{6}/);
    });

    test("画布不存在时 startAsset 报 404；discardAsset 删掉临时文件", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await expect(repo.startAsset("没有")).rejects.toMatchObject({
        code: "not_found",
      });
      await repo.createBoard("b");
      const { tmp } = await repo.startAsset("b");
      writeFileSync(tmp, "x");
      await repo.discardAsset(tmp);
      expect(existsSync(tmp)).toBe(false);
      await repo.discardAsset(tmp); // 再删一次不报错
    });

    test("改名画布：资源文件夹与节点路径一起改，_large 里的也跟着，git 规则仍然排除它", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createBoard("b");
      const a = await upload(repo, "b", "a.png", Buffer.alloc(10, 1));
      const big = await upload(repo, "b", "v.mp4", Buffer.alloc(5000, 1));
      const final = await repo.renameBoard("b", "新名");
      expect(final).toBe("新名");
      const { doc } = await repo.readBoard("新名");
      expect(doc.nodes.map((n) => n.file)).toEqual([
        "新名.assets/a.png",
        "新名.assets/_large/v.mp4",
      ]);
      expect(existsSync(abs(dir, "新名.assets/a.png"))).toBe(true);
      expect(existsSync(abs(dir, "新名.assets/_large/v.mp4"))).toBe(true);
      expect(existsSync(abs(dir, "b.assets"))).toBe(false);
      void a;
      void big;
      await repo.settle();
      const tracked = execFileSync(
        "git",
        [
          "-c",
          "core.quotepath=off",
          "-C",
          path.join(dir, ".canvas"),
          "ls-files",
        ],
        { encoding: "utf8" },
      );
      expect(tracked).toContain("新名.assets/a.png");
      expect(tracked).not.toContain("_large");
    });

    test("删画布连资源文件夹一起删；deleteAsset 删文件与节点（连边），只认资源路径", async () => {
      const dir = project();
      const repo = repoOf(dir);
      await repo.createBoard("b");
      const a = await upload(repo, "b", "a.png", Buffer.alloc(10, 1));
      const b = await upload(repo, "b", "b.png", Buffer.alloc(10, 1));
      const read = await repo.readBoard("b");
      read.doc.edges.push({ id: "e1", fromNode: a.nodeId, toNode: b.nodeId });
      await repo.saveBoard("b", read.doc);

      await repo.deleteAsset(a.path);
      const after = await repo.readBoard("b");
      expect(after.doc.nodes.map((n) => n.file)).toEqual([b.path]);
      expect(after.doc.edges).toEqual([]);
      expect(existsSync(abs(dir, a.path))).toBe(false);
      await expect(repo.deleteAsset(a.path)).rejects.toMatchObject({
        code: "not_found",
      });
      for (const bad of ["b.cards/x.md", "b.canvas", "../x"])
        await expect(repo.deleteAsset(bad)).rejects.toMatchObject({
          code: "invalid_path",
        });

      await repo.deleteBoard("b");
      expect(existsSync(abs(dir, "b.assets"))).toBe(false);
    });
  });

  test("renameBoard 连带改资源文件夹与卡片节点路径", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("旧名");
    const { path: rel } = await repo.createCard("旧名", {
      name: "卡",
      text: "x",
    });
    expect(await repo.renameBoard("旧名", "新名")).toBe("新名");
    expect(existsSync(path.join(dir, ".canvas", "旧名.canvas"))).toBe(false);
    expect(existsSync(path.join(dir, ".canvas", "新名.cards", "卡.md"))).toBe(
      true,
    );
    expect(existsSync(path.join(dir, ".canvas", rel))).toBe(false);
    const { doc } = await repo.readBoard("新名");
    expect(doc.nodes[0]?.file).toBe("新名.cards/卡.md");
    expect((await repo.listBoards()).map((b) => b.name)).toEqual(["新名"]);
  });

  test("deleteBoard 连同资源文件夹一起删", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    await repo.createCard("b", { name: "卡", text: "x" });
    await repo.deleteBoard("b");
    expect(existsSync(path.join(dir, ".canvas", "b.cards"))).toBe(false);
    expect(await repo.listBoards()).toEqual([]);
    await expect(repo.deleteBoard("b")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("createCard 避让重名并加节点；renameCard / deleteCard 同步节点与边", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    const a = await repo.createCard("b", { name: "卡", text: "a" });
    expect(a.path).toBe("b.cards/卡.md");
    const b = await repo.createCard("b", { name: "卡", text: "b" });
    expect(b.path).toBe("b.cards/卡 (2).md");
    const { doc } = await repo.readBoard("b");
    expect(doc.nodes).toHaveLength(2);
    expect(doc.nodes[0]?.id).toBe(a.nodeId);

    const next = await repo.renameCard(a.path, "改名");
    expect(next).toBe("b.cards/改名.md");
    expect((await repo.readBoard("b")).doc.nodes[0]?.file).toBe(next);

    await repo.deleteCard(next);
    const after = await repo.readBoard("b");
    expect(after.doc.nodes.map((n) => n.file)).toEqual(["b.cards/卡 (2).md"]);
    expect(existsSync(path.join(dir, ".canvas", next))).toBe(false);
  });

  test("createCard 给了 at 就按给定坐标放", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    await repo.createCard("b", { name: "卡", at: { x: 12.5, y: -8 } });
    const { doc } = await repo.readBoard("b");
    expect(doc.nodes[0]).toMatchObject({ x: 12.5, y: -8 });
  });

  test("写操作拒绝逃出 .canvas/ 的路径", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    await expect(repo.saveCard("../evil.md", "x")).rejects.toMatchObject({
      code: "invalid_path",
    });
    await expect(repo.deleteCard("../../etc/passwd")).rejects.toMatchObject({
      code: "invalid_path",
    });
  });
});

describe("CanvasRepo：提交节奏", () => {
  test("用户连续编辑去抖合并成一次提交，来源是 user", async () => {
    const dir = project();
    const repo = repoOf(dir, { commitDelayMs: 10_000 });
    await repo.createBoard("b");
    const { path: rel } = await repo.createCard("b", { text: "0" });
    await repo.saveCard(rel, "1");
    await repo.saveCard(rel, "2");
    await repo.saveCard(rel, "3");
    expect(existsSync(path.join(dir, ".canvas", ".git", "refs"))).toBe(true);
    // 还没到点：没有提交
    expect(gitLogSoft(dir)).toEqual([]);
    await repo.settle();
    const log = gitLog(dir);
    expect(log).toHaveLength(1);
    expect(log[0]?.startsWith("user ")).toBe(true);
    expect(readFileSync(path.join(dir, ".canvas", rel), "utf8")).toBe("3");
  });

  test("外部改动惰性记入历史：来源 external", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    await repo.settle();
    expect(gitLog(dir)).toHaveLength(1);
    // 人绕过界面直接改文件
    writeFileSync(
      path.join(dir, ".canvas", "b.canvas"),
      '{"nodes":[],"edges":["x"]}',
    );
    await repo.settle();
    const log = gitLog(dir);
    expect(log[0]).toBe("external");
    expect(log).toHaveLength(2);
  });

  test("每次写完之后都会重生成 index.md，且 index.md 不在卡片里", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    const { path: rel } = await repo.createCard("b", {
      name: "风险",
      text: "# 标题\n正文",
    });
    await repo.settle();
    const index = readFileSync(path.join(dir, ".canvas", "index.md"), "utf8");
    expect(index).toContain("generated - do not edit");
    expect(index).toContain(`card  ${rel}  "标题"  `);
    expect((await repo.listBoards())[0]?.cards).toBe(1);
    expect(gitLog(dir)[0]?.startsWith("user ")).toBe(true);
  });

  test("index.md 列出笔记：树里任意位置的 .md（含子目录），不含 index.md、卡片与点开头的目录；链接与出现在哪块画布都进索引", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("板");
    await repo.createCard("板", { name: "卡", text: "c" });
    const root = path.join(dir, ".canvas");
    mkdirSync(path.join(root, "笔记"), { recursive: true });
    mkdirSync(path.join(root, ".hidden"), { recursive: true });
    writeFileSync(path.join(root, "笔记", "设计.md"), "# 设计\n见 [[板]]");
    writeFileSync(path.join(root, "总述.md"), "总述");
    writeFileSync(path.join(root, ".hidden", "x.md"), "不算");
    const { doc, baseline } = await repo.readBoard("板");
    doc.nodes.push({
      id: "n1234567890",
      type: "file",
      file: "笔记/设计.md",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    await repo.saveBoard("板", doc, baseline);
    await repo.settle();
    const index = readFileSync(path.join(root, "index.md"), "utf8");
    const notes = index.slice(index.indexOf("## notes"));
    expect(notes).toContain('no1  总述.md  "总述"  6 B');
    expect(notes).toContain('no2  笔记/设计.md  "设计"');
    expect(notes).toContain("  appears-in: b1\n  links-to: [[板.canvas]]");
    expect(notes).not.toContain("index.md");
    expect(notes).not.toContain("板.cards");
    expect(notes).not.toContain("不算");
    expect(index).toContain('b1  板.canvas  "板"\n  linked-from: no2');
    expect(index).toContain('n1234567  note  笔记/设计.md  "设计"');
    expect(index).toContain("笔记/\n  设计.md");
  });

  test("没有 git 时照常读写，历史为空", async () => {
    const dir = project();
    const repo = new CanvasRepo(new NoGitEnv(), dir, { commitDelayMs: 10 });
    expect(await repo.createBoard("b")).toBe("b");
    const { path: rel } = await repo.createCard("b", { text: "x" });
    await repo.settle();
    expect(readFileSync(path.join(dir, ".canvas", rel), "utf8")).toBe("x");
    expect(await repo.status()).toEqual({ ready: true, git: "missing" });
    expect(await repo.history()).toEqual([]);
    await expect(repo.version("abcdef1", rel)).rejects.toMatchObject({
      code: "git_missing",
    });
    await expect(repo.restore(rel, "abcdef1")).rejects.toMatchObject({
      code: "git_missing",
    });
    await expect(repo.undoLastAgent()).rejects.toMatchObject({
      code: "git_missing",
    });
  });
});

describe("CanvasRepo：历史", () => {
  test("history 带来源；version 给出那个版本的内容；restore 产生新提交", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    const { path: rel } = await repo.createCard("b", { text: "v1" });
    await repo.settle();
    await repo.saveCard(rel, "v2");
    await repo.settle();

    const history = await repo.history(rel);
    expect(history).toHaveLength(2);
    expect(history[0]?.source).toBe("user");
    const first = history[1];
    expect(first?.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await repo.version(first?.sha ?? "", rel)).toBe("v1");

    const sha = await repo.restore(rel, first?.sha ?? "");
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(readFileSync(path.join(dir, ".canvas", rel), "utf8")).toBe("v1");
    const after = await repo.history();
    expect(after[0]?.source).toBe("restore");
    expect(after).toHaveLength(3);
  });

  test("restore 那个版本里没有这个文件时报错", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    await repo.settle();
    const base = (await repo.history())[0]?.sha ?? "";
    const { path: rel } = await repo.createCard("b", { text: "x" });
    await repo.settle();
    await expect(repo.restore(rel, base)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("undoLastAgent 撤销最近一个 agent 提交；之后有别的提交就拒绝", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    await repo.settle();
    const { path: rel } = await repo.createCard("b", { text: "agent 写的" });
    await repo.commitAs({ kind: "agent", session: "s1" }, "create card");
    expect(readFileSync(path.join(dir, ".canvas", rel), "utf8")).toBe(
      "agent 写的",
    );
    const undone = await repo.undoLastAgent();
    expect(undone.ok).toBe(true);
    expect(existsSync(path.join(dir, ".canvas", rel))).toBe(false);
    expect((await repo.history())[0]?.source).toBe("undo");

    await repo.createCard("b", { name: "人写的", text: "y" });
    await repo.settle();
    const refused = await repo.undoLastAgent();
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain(
      "历史逐个文件恢复",
    );
  });

  test("history 的 path 过滤只认 .canvas/ 内的路径", async () => {
    const dir = project();
    const repo = repoOf(dir);
    await repo.createBoard("b");
    await repo.settle();
    await expect(repo.history("../x")).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  test("git 仓库还没建时 version / restore / undo 报 git_missing", async () => {
    const dir = project();
    const repo = new CanvasRepo(new NoGitEnv(), dir);
    await expect(repo.version("abcdef1", "b.cards/a.md")).rejects.toMatchObject(
      { code: "git_missing" },
    );
  });
});

describe("CanvasRepo：错误形状", () => {
  test("CanvasError 带状态码与错误码", async () => {
    const repo = repoOf(project());
    const err = await repo.readBoard("nope").catch((e) => e);
    expect(err).toBeInstanceOf(CanvasError);
    expect(err).toMatchObject({ code: "not_found", status: 404 });
  });

  test("项目目录还不存在时写操作会一路建出来", async () => {
    const dir = project();
    const nested = path.join(dir, "deep", "deeper");
    const repo = new CanvasRepo(new LocalEnv(), nested);
    await repo.createBoard("b");
    expect(statSync(path.join(nested, ".canvas")).isDirectory()).toBe(true);
  });
});
