// 发送器：对本地假推送端点核对请求头与加密载荷、404/410 判 gone、失败与超时不抛。
import { createECDH, randomBytes } from "node:crypto";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { generateVAPIDKeys } from "web-push";
import { buildPayload, encodePayload } from "./payload.js";
import { createSender } from "./sender.js";

// http_ece 是 web-push 的依赖（本包没直接依赖它）：按 web-push 的位置解析。
const ece = createRequire(createRequire(import.meta.url).resolve("web-push"))(
  "http_ece",
) as {
  decrypt(
    body: Buffer,
    opts: {
      version: string;
      privateKey: ReturnType<typeof createECDH>;
      authSecret: Buffer;
    },
  ): Buffer;
};

const VAPID = {
  publicKey: "B".repeat(87),
  privateKey: "P".repeat(43),
  subject: "mailto:admin@example.com",
};

/** 现造一对订阅密钥（浏览器那边由 pushManager 生成，这里自己算一份）。 */
function subscription() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    target: {
      endpoint: "",
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
  };
}

interface Got {
  method: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** 假推送端点：记下收到的请求，按 status 回应；"hang" 表示收下却永不回应。 */
async function endpoint(status: number | "hang" = 201) {
  const requests: Got[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      if (status === "hang") return;
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(status >= 400 ? "端点说不" : "");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  const { port } = srv.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/push/abc`, requests };
}

test("请求头齐备（VAPID / TTL / Urgency / 加密），载荷能解开且与 encodePayload 一致", async () => {
  const box = await endpoint(201);
  const { ecdh, target, auth } = subscription();
  const payload = buildPayload("blocked", "sess-1", "等你批准");

  const send = createSender({ vapid: VAPID });
  expect(await send({ ...target, endpoint: box.url }, payload)).toEqual({
    ok: true,
  });

  const got = box.requests[0];
  if (!got) throw new Error("没有收到请求");
  expect(got.method).toBe("POST");
  expect(got.headers.authorization).toMatch(/^vapid t=[^,]+, k=\S+$/);
  expect(got.headers.ttl).toBe("14400");
  expect(got.headers.urgency).toBe("high");
  expect(got.headers["content-encoding"]).toBe("aes128gcm");
  expect(got.headers["content-type"]).toBe("application/octet-stream");

  const plain = ece.decrypt(got.body, {
    version: "aes128gcm",
    privateKey: ecdh,
    authSecret: auth,
  });
  expect(plain.toString("utf8")).toBe(encodePayload(payload));
});

test("请求头里不带手写的 Content-Length（全局 fetch 换成 undici 8 后会拒掉它）", async () => {
  let sent: Record<string, string> = {};
  const send = createSender({
    vapid: VAPID,
    fetch: async (_url, init) => {
      sent = init?.headers as Record<string, string>;
      return new Response(null, { status: 201 });
    },
  });
  const to = { ...subscription().target, endpoint: "https://push.example/x" };
  expect(await send(to, buildPayload("done", "sess-4", "跑完了"))).toEqual({
    ok: true,
  });
  expect(Object.keys(sent).map((k) => k.toLowerCase())).not.toContain(
    "content-length",
  );
  expect(sent.Authorization).toMatch(/^vapid /);
});

test("200 / 202 也算送达", async () => {
  const send = createSender({ vapid: VAPID });
  const payload = buildPayload("done", "sess-3", "跑完了");
  for (const status of [200, 202]) {
    const box = await endpoint(status);
    const to = { ...subscription().target, endpoint: box.url };
    expect(await send(to, payload), String(status)).toEqual({ ok: true });
  }
});

test("404 / 410 判 gone（订阅作废），500 不是 gone 但带状态码与响应体", async () => {
  const gone404 = await endpoint(404);
  const gone410 = await endpoint(410);
  const boom = await endpoint(500);
  const send = createSender({ vapid: VAPID });
  const payload = buildPayload("done", "sess-2", "跑完了");
  const at = (url: string) => ({ ...subscription().target, endpoint: url });

  expect(await send(at(gone404.url), payload)).toMatchObject({
    ok: false,
    gone: true,
    status: 404,
  });
  expect(await send(at(gone410.url), payload)).toMatchObject({
    ok: false,
    gone: true,
    status: 410,
  });
  const c = await send(at(boom.url), payload);
  expect(c).toMatchObject({ ok: false, gone: false, status: 500 });
  expect(c.ok === false && c.error).toBe("500 端点说不");
});

test("连不上不抛：ok: false、gone: false", async () => {
  const send = createSender({ vapid: VAPID });
  const r = await send(
    { ...subscription().target, endpoint: "http://127.0.0.1:1/push" },
    buildPayload("error", "s", "出错了"),
  );
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.gone).toBe(false);
});

test("超时：10 秒后中止，按失败返回而不抛", async () => {
  const box = await endpoint("hang");
  const ctl = new AbortController();
  const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(ctl.signal);

  const send = createSender({ vapid: VAPID });
  const p = send(
    { ...subscription().target, endpoint: box.url },
    buildPayload("test", "", ""),
  );
  // 端点永不回应：只等中止信号。
  await new Promise<void>((r) => setTimeout(r, 20));
  ctl.abort();
  const r = await p;
  expect(spy).toHaveBeenCalledWith(10_000);
  expect(r.ok).toBe(false);
  expect(r.ok === false && /abort/i.test(r.error)).toBe(true);
});

test("真 VAPID 密钥：签出的 JWT 带 aud / sub / exp，k 就是公钥", async () => {
  const box = await endpoint(201);
  const keys = generateVAPIDKeys();
  const send = createSender({ vapid: { ...keys, subject: VAPID.subject } });
  expect(
    await send(
      { ...subscription().target, endpoint: box.url },
      buildPayload("blocked", "s", "标题"),
    ),
  ).toEqual({ ok: true });

  const jwt = /^vapid t=([^,]+), k=(\S+)$/.exec(
    box.requests[0]?.headers.authorization ?? "",
  );
  expect(jwt?.[2]).toBe(keys.publicKey);
  const [header, payload] = (jwt?.[1] ?? "").split(".");
  expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual(
    { typ: "JWT", alg: "ES256" },
  );
  const claims = JSON.parse(
    Buffer.from(payload ?? "", "base64url").toString(),
  ) as { aud: string; sub: string; exp: number };
  expect(claims.aud).toBe(new URL(box.url).origin);
  expect(claims.sub).toBe(VAPID.subject);
  expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
});

test("订阅密钥坏了：返回失败、不抛，也不算 gone", async () => {
  const box = await endpoint(201);
  const send = createSender({ vapid: VAPID });
  const r = await send(
    { endpoint: box.url, p256dh: "too-short", auth: "x" },
    buildPayload("blocked", "s", "标题"),
  );
  expect(r).toMatchObject({ ok: false, gone: false });
  expect(box.requests).toEqual([]);
});
