// 用户页上的待处理文件选择：每页只一个、新的顶掉旧的、校验失败不动清单、交成功才结算、超时丢弃。
import { describe, expect, test } from "vitest";
import { HttpError } from "../../lib/http-error.js";
import type { PageFileChooser } from "../engine/types.js";
import type { PendingUploadView } from "../pages/types.js";
import { createPendingUploads } from "./pending.js";

const MB = 1024 * 1024;

/** 假选择器：记下 setFiles 收到的文件；可让它失败。 */
function fakeChooser(opts: { multiple?: boolean; fail?: string } = {}) {
  const calls: { name: string; buffer: Buffer }[][] = [];
  const c: PageFileChooser = {
    multiple: opts.multiple ?? true,
    async setFiles(files) {
      // 只拷贝真缓冲：冒充大文件的 { length } 形状要原样过，不在测试里申请 60 MB。
      calls.push(
        files.map((f) => ({
          name: f.name,
          buffer: Buffer.isBuffer(f.buffer) ? Buffer.from(f.buffer) : f.buffer,
        })),
      );
      if (opts.fail) throw new Error(opts.fail);
    },
  };
  return { c, calls };
}

function setup(ttlMs?: number) {
  const views: Array<{ pageId: string; item: PendingUploadView | null }> = [];
  const pending = createPendingUploads({
    onChange: (pageId, item) => void views.push({ pageId, item }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  /** 这一页最后一次报给 service 的值。 */
  const last = (pageId: string) =>
    views.filter((v) => v.pageId === pageId).at(-1)?.item ?? null;
  return { pending, views, last };
}

const bytes = (text: string) => Buffer.from(text);
const file = (name: string, text = `${name}-内容`) => ({
  name,
  buffer: bytes(text),
});

/** 异步收尾（超时丢弃）用的轮询：条件成立就返回，否则 2 秒后失败。 */
async function until(cond: () => boolean, what: string) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 2000) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("清单", () => {
  test("add：报给 service 的是 id 与 multiple", () => {
    const { pending, last } = setup();
    const { c } = fakeChooser({ multiple: false });
    pending.add("p1", c);
    expect(last("p1")).toMatchObject({ multiple: false });
    expect(last("p1")?.id).toMatch(/^[0-9a-f]{12}$/);
  });

  test("新的顶掉旧的：旧 id 交不上、新 id 正常", async () => {
    const { pending, last } = setup();
    const old = fakeChooser();
    const fresh = fakeChooser();
    pending.add("p1", old.c);
    const oldId = last("p1")?.id as string;
    pending.add("p1", fresh.c);
    const newId = last("p1")?.id as string;
    expect(newId).not.toBe(oldId);

    const gone = await pending
      .fill("p1", oldId, [file("a.txt")], MB)
      .catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(HttpError);
    expect((gone as HttpError).code).toBe("not_found");
    expect((gone as HttpError).status).toBe(404);
    expect(old.calls).toEqual([]);

    await pending.fill("p1", newId, [file("a.txt")], MB);
    expect(fresh.calls).toHaveLength(1);
    expect(old.calls).toEqual([]);
  });

  test("每页各自算：p2 的挂起不影响 p1", async () => {
    const { pending, last } = setup();
    pending.add("p1", fakeChooser().c);
    pending.add("p2", fakeChooser().c);
    expect(last("p1")?.id).not.toBe(last("p2")?.id);
  });
});

describe("交文件", () => {
  test("成功：setFiles 收到名字与逐字节相同的内容，清单清空", async () => {
    const { pending, last } = setup();
    const { c, calls } = fakeChooser();
    pending.add("p1", c);
    const id = last("p1")?.id as string;
    const files = [file("报告.txt"), file("说明.txt", "第二份")];
    await pending.fill("p1", id, files, MB);
    expect(calls[0]?.map((f) => f.name)).toEqual(["报告.txt", "说明.txt"]);
    expect(calls[0]?.[0]?.buffer.equals(bytes("报告.txt-内容"))).toBe(true);
    expect(calls[0]?.[1]?.buffer.equals(bytes("第二份"))).toBe(true);
    // 结算了：清单里没有了，再交一次 404
    expect(last("p1")).toBeNull();
    const again = await pending
      .fill("p1", id, [file("a.txt")], MB)
      .catch((e: unknown) => e);
    expect((again as HttpError).code).toBe("not_found");
  });

  const rejects = async (
    name: string,
    opts: Parameters<typeof fakeChooser>[0],
    files: { name: string; buffer: Buffer }[],
    maxBytes: number,
  ) => {
    const { pending, last } = setup();
    const { c, calls } = fakeChooser(opts);
    pending.add("p1", c);
    const id = last("p1")?.id as string;
    const err = (await pending
      .fill("p1", id, files, maxBytes)
      .catch((e) => e)) as HttpError;
    // 校验失败：不交文件，且这一项还留着（用户可以改选再来）
    expect(calls, name).toEqual([]);
    expect(last("p1")?.id, name).toBe(id);
    return err;
  };

  test("没有文件：400 bad_files", async () => {
    const err = await rejects("空", {}, [], MB);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.code).toBe("bad_files");
    expect(err.status).toBe(400);
    expect(err.message).toBe("没有收到文件");
  });

  test("只收一个的入口给了两个：400 too_many", async () => {
    const err = await rejects(
      "多个",
      { multiple: false },
      [file("a.txt"), file("b.txt")],
      MB,
    );
    expect(err.code).toBe("too_many");
    expect(err.status).toBe(400);
    expect(err.message).toBe("这个上传入口只接受一个文件");
  });

  test("单个文件超过上限：413 too_large 带大小与文件名", async () => {
    const big = { name: "大.bin", buffer: Buffer.alloc(3) };
    const err = await rejects("单文件超限", {}, [big], 2);
    expect(err.code).toBe("too_large");
    expect(err.status).toBe(413);
    expect(err.message).toBe("文件太大（3 B，上限 2 B）：大.bin");
  });

  test("合计超过 50 MB：413 too_large，消息用 checkUploadTotal 的", async () => {
    const files = [
      { name: "a.bin", buffer: { length: 40 * MB } as Buffer },
      { name: "b.bin", buffer: { length: 20 * MB } as Buffer },
    ];
    // 单文件都在上限内，只有合计超
    const err = await rejects("合计超限", {}, files, 50 * MB);
    expect(err.code).toBe("too_large");
    expect(err.status).toBe(413);
    expect(err.message).toContain("60 MB");
    expect(err.message).toContain("少传几个");
  });

  test("并发两次 fill（双击「上传」）：只交一次，第二次得 404", async () => {
    const { pending, last } = setup();
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const calls: number[] = [];
    pending.add("p1", {
      multiple: true,
      async setFiles() {
        calls.push(1);
        await gate;
      },
    });
    const id = last("p1")?.id as string;
    const file = { name: "a.txt", buffer: Buffer.from("x") };
    const first = pending.fill("p1", id, [file], MB);
    const second = pending.fill("p1", id, [file], MB);
    open();
    await first;
    await expect(second).rejects.toMatchObject({ status: 404 });
    expect(calls.length).toBe(1);
  });

  test("setFiles 抛错：502 upload_failed 带原消息，这一项作废", async () => {
    const { pending, last } = setup();
    const { c } = fakeChooser({ fail: "这个文件选择已经不在了" });
    pending.add("p1", c);
    const id = last("p1")?.id as string;
    const err = (await pending
      .fill("p1", id, [file("a.txt")], MB)
      .catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.code).toBe("upload_failed");
    expect(err.status).toBe(502);
    expect(err.message).toBe("这个文件选择已经不在了");
    expect(last("p1")).toBeNull();
  });

  test("opts 里的页面 id 对不上：当作不存在，别的页面的项不动", async () => {
    const { pending, last } = setup();
    const { c, calls } = fakeChooser();
    pending.add("p1", c);
    const id = last("p1")?.id as string;
    const err = (await pending
      .fill("p2", id, [file("a.txt")], MB)
      .catch((e: unknown) => e)) as HttpError;
    expect(err.code).toBe("not_found");
    expect(calls).toEqual([]);
    expect(last("p1")?.id).toBe(id);
  });
});

describe("取消与清理", () => {
  test("cancel：不交文件，清单清空；再取消返回 false", () => {
    const { pending, last } = setup();
    const { c, calls } = fakeChooser();
    pending.add("p1", c);
    const id = last("p1")?.id as string;
    expect(pending.cancel("p1", id)).toBe(true);
    expect(calls).toEqual([]);
    expect(last("p1")).toBeNull();
    expect(pending.cancel("p1", id)).toBe(false);
    expect(pending.cancel("p2", id)).toBe(false);
  });

  test("超时自动丢弃（ttlMs 调小），不交文件", async () => {
    const { pending, last } = setup(30);
    const { c, calls } = fakeChooser();
    pending.add("p1", c);
    const id = last("p1")?.id as string;
    await until(() => last("p1") === null, "超时丢弃");
    expect(calls).toEqual([]);
    const err = (await pending
      .fill("p1", id, [file("a.txt")], MB)
      .catch((e: unknown) => e)) as HttpError;
    expect(err.code).toBe("not_found");
  });

  test("dropPage：只清这一页", async () => {
    const { pending, last } = setup();
    const a = fakeChooser();
    const b = fakeChooser();
    pending.add("p1", a.c);
    pending.add("p2", b.c);
    const idB = last("p2")?.id as string;
    pending.dropPage("p1");
    expect(last("p1")).toBeNull();
    expect(last("p2")?.id).toBe(idB);
    expect(a.calls).toEqual([]);
  });

  test("每次变化报最新值：顶掉时依次报旧、新，最终是新项", () => {
    const { pending, views, last } = setup();
    pending.add("p1", fakeChooser().c);
    const first = last("p1")?.id;
    pending.add("p1", fakeChooser().c);
    const second = last("p1")?.id;
    expect(
      views.filter((v) => v.pageId === "p1").map((v) => v.item?.id),
    ).toEqual([first, second]);
    expect(second).not.toBe(first);
  });
});
