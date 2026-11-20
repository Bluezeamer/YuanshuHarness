// 待处理下载清单：挂起上限、每页隔离、暂存复用与并发、失败即丢弃、超时、结算与清理。
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { HttpError } from "../../lib/http-error.js";
import type { PageDownload } from "../engine/types.js";
import type { PendingDownloadView } from "../pages/types.js";
import { createPendingDownloads } from "./pending.js";

/** 假下载：saveTo 把 bytes 写到 dest；可让它失败、慢下来，并记下调用次数与取消原因。 */
function fakeDownload(
  name = "a.zip",
  opts: { bytes?: Buffer; fail?: string; delayMs?: number } = {},
) {
  const bytes = opts.bytes ?? Buffer.from([0, 255, 10, 13]);
  const cancelled: string[] = [];
  const saved: string[] = [];
  const d: PageDownload = {
    filename: name,
    url: `https://x.test/${encodeURIComponent(name)}`,
    async saveTo(dest) {
      saved.push(dest);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw new Error(opts.fail);
      await writeFile(dest, bytes);
      return bytes.length;
    },
    async cancel(reason) {
      cancelled.push(reason);
    },
  };
  return { d, cancelled, saved, bytes };
}

function setup(ttlMs?: number) {
  const root = makeTmpDir("yuanshu-browser-pending-");
  const views: Array<{ pageId: string; items: PendingDownloadView[] }> = [];
  const pending = createPendingDownloads({
    root,
    onChange: (pageId, items) => void views.push({ pageId, items }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  const last = (pageId: string) =>
    views
      .filter((v) => v.pageId === pageId)
      .at(-1)
      ?.items.map((i) => i.id) ?? [];
  return { root, pending, views, last };
}

/** 暂存目录里的全部条目（每项一个随机子目录）。 */
const entries = async (root: string): Promise<string[]> =>
  readdir(root).catch(() => []);

const exists = async (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

/** 异步收尾（暂存目录删除）用的轮询：条件成立就返回，否则 2 秒后失败。 */
async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > 2000) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("清单", () => {
  test("add / list：每页最多 3 个，第 4 个返回 false", () => {
    const { pending, views, last } = setup();
    const list = [1, 2, 3, 4].map((n) => fakeDownload(`${n}.zip`).d);
    expect(pending.add("p1", list[0] as PageDownload)).toBe(true);
    expect(pending.add("p1", list[1] as PageDownload)).toBe(true);
    expect(pending.add("p1", list[2] as PageDownload)).toBe(true);
    expect(pending.add("p1", list[3] as PageDownload)).toBe(false);
    expect(pending.list("p1").map((i) => i.filename)).toEqual([
      "1.zip",
      "2.zip",
      "3.zip",
    ]);
    // 每页各自算：别的页面还能加
    expect(pending.add("p2", list[3] as PageDownload)).toBe(true);
    expect(pending.list("p2")).toHaveLength(1);
    // 每次变化都收到最新清单（最后一条是当前的）
    expect(last("p1")).toEqual(pending.list("p1").map((i) => i.id));
    expect(views.map((v) => v.pageId)).toEqual(["p1", "p1", "p1", "p2"]);
  });
});

describe("暂存", () => {
  test("首次调用真的写进根目录下，字节一致，目录 0700", async () => {
    const { root, pending } = setup();
    const { d, bytes } = fakeDownload("报告.zip");
    pending.add("p1", d);
    const id = pending.list("p1")[0]?.id as string;

    const staged = await pending.stage("p1", id, 1024);
    expect(staged.filename).toBe("报告.zip");
    expect(staged.size).toBe(bytes.length);
    expect([...((await readFile(staged.path)) as Buffer)]).toEqual([...bytes]);
    // 落在空的暂存根下（根目录里只有它这一项）
    expect((await entries(root)).length).toBe(1);
    expect(path.dirname(path.dirname(staged.path))).toBe(root);
    const mode = (await stat(path.dirname(staged.path))).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("并发两次只调一次 saveTo", async () => {
    const { pending } = setup();
    const { d, saved } = fakeDownload("big.zip", { delayMs: 20 });
    pending.add("p1", d);
    const id = pending.list("p1")[0]?.id as string;
    const [a, b] = await Promise.all([
      pending.stage("p1", id, 1024),
      pending.stage("p1", id, 1024),
    ]);
    expect(saved).toHaveLength(1);
    expect(a).toEqual(b);
  });

  test("再调一次直接复用，不再 saveTo", async () => {
    const { pending } = setup();
    const { d, saved } = fakeDownload();
    pending.add("p1", d);
    const id = pending.list("p1")[0]?.id as string;
    const first = await pending.stage("p1", id, 1024);
    const second = await pending.stage("p1", id, 1024);
    expect(saved).toHaveLength(1);
    expect(second).toEqual(first);
  });

  test("暂存失败：这一项从清单消失，报 502 download_failed", async () => {
    const { pending } = setup();
    const { d, cancelled } = fakeDownload("huge.zip", {
      fail: "文件太大（2 GB，上限 100 MB）",
    });
    pending.add("p1", d);
    const id = pending.list("p1")[0]?.id as string;

    const err = await pending.stage("p1", id, 1024).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe("download_failed");
    expect((err as HttpError).status).toBe(502);
    expect((err as HttpError).message).toBe("文件太大（2 GB，上限 100 MB）");
    expect(pending.list("p1")).toEqual([]);
    // saveTo 失败时已经自己取消 / 删掉了文件，这里不再 cancel 一次
    expect(cancelled).toEqual([]);
  });

  test("不存在（或已结算）的项报 404 not_found", async () => {
    const { pending } = setup();
    pending.add("p1", fakeDownload().d);
    const id = pending.list("p1")[0]?.id as string;
    await pending.settle("p1", id, "用户丢弃");
    const err = await pending.stage("p1", id, 1024).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe("not_found");
    expect((err as HttpError).status).toBe(404);
  });
});

describe("结算", () => {
  test("没暂存的：调 cancel(reason)，清单里消失", async () => {
    const { pending } = setup();
    const { d, cancelled } = fakeDownload();
    pending.add("p1", d);
    const id = pending.list("p1")[0]?.id as string;
    expect(await pending.settle("p1", id, "用户丢弃")).toBe(true);
    expect(cancelled).toEqual(["用户丢弃"]);
    expect(pending.list("p1")).toEqual([]);
  });

  test("已暂存的：删暂存文件，不再 cancel", async () => {
    const { root, pending } = setup();
    const { d, cancelled } = fakeDownload();
    pending.add("p1", d);
    const id = pending.list("p1")[0]?.id as string;
    const staged = await pending.stage("p1", id, 1024);

    expect(await pending.settle("p1", id, "已放进工作区目录")).toBe(true);
    // 删除不卡结算（GET 可能正在读这个大文件），等它落地
    await until(async () => !(await exists(staged.path)), "暂存目录被删");
    expect(await entries(root)).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  test("幂等：第二次返回 false，不再 cancel", async () => {
    const { pending } = setup();
    const { d, cancelled } = fakeDownload();
    pending.add("p1", d);
    const id = pending.list("p1")[0]?.id as string;
    expect(await pending.settle("p1", id, "用户丢弃")).toBe(true);
    expect(await pending.settle("p1", id, "用户丢弃")).toBe(false);
    expect(cancelled).toEqual(["用户丢弃"]);
  });

  test("页面 id 对不上时当作不存在（别的页面的项不动）", async () => {
    const { pending } = setup();
    const { d, cancelled } = fakeDownload();
    pending.add("p1", d);
    const id = pending.list("p1")[0]?.id as string;
    expect(await pending.settle("p2", id, "用户丢弃")).toBe(false);
    expect(cancelled).toEqual([]);
    expect(pending.list("p1")).toHaveLength(1);
  });

  test("超时自动结算（ttlMs 调小），清单跟着变空", async () => {
    const { pending, last } = setup(30);
    const { d, cancelled } = fakeDownload();
    pending.add("p1", d);
    const id = pending.list("p1")[0]?.id as string;
    await until(async () => cancelled.length === 1, "超时取消");
    expect(cancelled[0]).toContain("已取消");
    expect(pending.list("p1")).toEqual([]);
    expect(last("p1")).toEqual([]);
    expect(await pending.settle("p1", id, "用户丢弃")).toBe(false);
  });

  test("dropPage 只清这一页", async () => {
    const { pending } = setup();
    const a = fakeDownload("a.zip");
    const b = fakeDownload("b.zip");
    pending.add("p1", a.d);
    pending.add("p1", fakeDownload("a2.zip").d);
    pending.add("p2", b.d);
    await pending.dropPage("p1");
    expect(pending.list("p1")).toEqual([]);
    expect(pending.list("p2").map((i) => i.filename)).toEqual(["b.zip"]);
    expect(a.cancelled).toEqual(["页面已关闭"]);
    expect(b.cancelled).toEqual([]);
  });
});

describe("清理", () => {
  test("sweep 清掉残留；目录不存在不报错", async () => {
    const { root, pending } = setup();
    const leftover = path.join(root, "leftover");
    await mkdir(leftover, { recursive: true });
    await chmod(leftover, 0o700);
    await writeFile(path.join(leftover, "file"), "x");
    await pending.sweep();
    expect(await entries(root)).toEqual([]);
    await expect(pending.sweep()).resolves.toBeUndefined();
  });
});
