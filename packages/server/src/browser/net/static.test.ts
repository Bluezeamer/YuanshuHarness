import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { LocalEnv } from "../../env/local.js";
import { serveFile } from "./static.js";

const env = new LocalEnv();

// 起一个只把请求交给 serveFile 的服务器，得到状态码、头与 body。
function serve(
  allow: (real: string) => boolean | Promise<boolean> = () => true,
) {
  const server: Server = createServer((req, res) => {
    void serveFile(
      {
        env,
        path: decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname),
        method: req.method ?? "GET",
        allow,
      },
      res,
    );
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      ok({
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const get = async (port: number, pathname: string, method = "GET") => {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    length: res.headers.get("content-length"),
    cache: res.headers.get("cache-control"),
    nosniff: res.headers.get("x-content-type-options"),
    body: method === "HEAD" ? "" : await res.text(),
  };
};

const setup = () => {
  const work = makeTmpDir("yuanshu-static-");
  writeFileSync(path.join(work, "page.html"), "<h1>hi</h1>");
  writeFileSync(path.join(work, "a.unknownext"), "blob");
  mkdirSync(path.join(work, "dir"));
  writeFileSync(path.join(work, "dir", "index.html"), "<h1>index</h1>");
  mkdirSync(path.join(work, "empty"));
  symlinkSync(path.join(work, "page.html"), path.join(work, "link.html"));
  return work;
};

test("普通文件：类型、长度与不缓存", async () => {
  const s = await serve();
  try {
    const r = await get(s.port, `${setup()}/page.html`);
    expect(r).toMatchObject({
      status: 200,
      type: "text/html; charset=utf-8",
      length: "11",
      cache: "no-store",
      nosniff: "nosniff",
      body: "<h1>hi</h1>",
    });
  } finally {
    await s.close();
  }
});

test("未知扩展名用 application/octet-stream", async () => {
  const s = await serve();
  try {
    expect((await get(s.port, `${setup()}/a.unknownext`)).type).toBe(
      "application/octet-stream",
    );
  } finally {
    await s.close();
  }
});

test("目录取 index.html；没有就是 404", async () => {
  const s = await serve();
  try {
    const dir = setup();
    expect((await get(s.port, `${dir}/dir/`)).body).toBe("<h1>index</h1>");
    expect((await get(s.port, `${dir}/empty/`)).status).toBe(404);
  } finally {
    await s.close();
  }
});

test("不存在的路径 404", async () => {
  const s = await serve();
  try {
    expect((await get(s.port, `${setup()}/nope.html`)).status).toBe(404);
  } finally {
    await s.close();
  }
});

test("符号链接逃出被 allow 拒绝", async () => {
  const dir = setup();
  const seen: string[] = [];
  const s = await serve((real) => {
    seen.push(real);
    return real.startsWith(dir);
  });
  try {
    // 链接解析到 work 内的文件，放行
    expect((await get(s.port, `${dir}/link.html`)).status).toBe(200);
    // 指向 work 之外的链接被 allow 拦下
    symlinkSync("/etc/passwd", path.join(dir, "escape.html"));
    const r = await get(s.port, `${dir}/escape.html`);
    expect(r.status).toBe(403);
    expect(seen.at(-1)).toBe("/etc/passwd");
  } finally {
    await s.close();
  }
});

test("HEAD 不发 body 但有 Content-Length", async () => {
  const s = await serve();
  try {
    const r = await get(s.port, `${setup()}/page.html`, "HEAD");
    expect(r).toMatchObject({ status: 200, length: "11", body: "" });
  } finally {
    await s.close();
  }
});

test("非 GET / HEAD 返回 405", async () => {
  const s = await serve();
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}${setup()}/page.html`, {
      method: "POST",
    });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, HEAD");
  } finally {
    await s.close();
  }
});
