import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  attachmentBlob,
  downloadAttachment,
  uploadAttachment,
} from "./attachments";

// 最小 XMLHttpRequest 假件：记录请求并在测试里手动喂进度 / 响应。
class FakeXHR {
  static last: FakeXHR | null = null;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = {
    onprogress: null,
  };

  constructor() {
    FakeXHR.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.body = body;
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded,
      total,
    } as ProgressEvent);
  }
}

const xhr = () => {
  const x = FakeXHR.last;
  if (!x) throw new Error("还没有创建 XHR");
  return x;
};

beforeEach(() => {
  FakeXHR.last = null;
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("上传：POST 到会话附件接口（文件名编码）、带鉴权与文件体；进度回 0–100 的百分比", async () => {
  const file = new File(["abc"], "报告 v1.html", { type: "text/html" });
  const progress = vi.fn();
  const pending = uploadAttachment("tok", "s1", file, progress);
  const x = xhr();
  expect(x.method).toBe("POST");
  expect(x.url).toBe(
    "/api/v1/sessions/s1/attachments?name=%E6%8A%A5%E5%91%8A%20v1.html",
  );
  expect(x.headers.Authorization).toBe("Bearer tok");
  expect(x.body).toBe(file);

  x.progress(30, 100);
  x.progress(100, 100);
  expect(progress.mock.calls.map((c) => c[0])).toEqual([30, 100]);

  x.respond(200, {
    name: "报告 v1.html",
    mime: "text/html",
    size: 3,
    path: "./2026-10-27/ab12-App.html",
  });
  await expect(pending).resolves.toEqual({
    ok: true,
    data: {
      name: "报告 v1.html",
      mime: "text/html",
      size: 3,
      path: "./2026-10-27/ab12-App.html",
    },
  });
});

test("上传失败：状态码映射成中文说明；网络错误也有兜底", async () => {
  const tooLarge = uploadAttachment(null, "s1", new File(["x"], "a.bin"));
  expect(xhr().headers.Authorization).toBeUndefined();
  xhr().respond(413, { error: "too_large" });
  await expect(tooLarge).resolves.toEqual({
    ok: false,
    message: "文件太大，超出了服务端限制",
  });

  const unknown = uploadAttachment(null, "s1", new File(["x"], "a.bin"));
  xhr().respond(500, {});
  await expect(unknown).resolves.toEqual({
    ok: false,
    message: "附件上传失败，请稍后重试",
  });

  const offline = uploadAttachment(null, "s1", new File(["x"], "a.bin"));
  xhr().onerror?.();
  await expect(offline).resolves.toEqual({
    ok: false,
    message: "网络错误，附件上传失败",
  });

  const broken = uploadAttachment(null, "s1", new File(["x"], "a.bin"));
  xhr().status = 200;
  xhr().responseText = "not-json";
  xhr().onload?.();
  await expect(broken).resolves.toEqual({
    ok: false,
    message: "上传响应异常，请重试",
  });
});

const blobFetch = (status: number, body = "abc") => {
  const fetchMock = vi.fn(async () =>
    status === 200 ? new Response(body) : new Response("{}", { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

test("读取内容：按相对 path + download=1 请求，成功拿到 blob；失败给中文提示", async () => {
  const fetchMock = blobFetch(200);
  const r = await attachmentBlob("tok", "s1", "./2026/a.html");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/sessions/s1/attachments/content?path=.%2F2026%2Fa.html&download=1",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer tok" }),
    }),
  );
  expect(r.ok && r.data.size).toBe(3);

  blobFetch(401);
  await expect(attachmentBlob(null, "s1", "./a")).resolves.toEqual({
    ok: false,
    message: "登录已失效，请重新登录",
  });
  blobFetch(404);
  await expect(attachmentBlob(null, "s1", "./a")).resolves.toEqual({
    ok: false,
    message: "附件不存在或已被清理",
  });
});

test("下载：取到 blob 后触发 a[download]；读取失败时不触发", async () => {
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  blobFetch(200);
  await expect(
    downloadAttachment("tok", "s1", "./2026/a.html", "a.html"),
  ).resolves.toEqual({ ok: true });
  expect(click).toHaveBeenCalledTimes(1);
  const a = click.mock.instances[0] as HTMLAnchorElement;
  expect(a.download).toBe("a.html");

  blobFetch(403);
  await expect(downloadAttachment("tok", "s1", "./a", "a")).resolves.toEqual({
    ok: false,
    message: "没有权限读取该附件",
  });
  expect(click).toHaveBeenCalledTimes(1);
});
