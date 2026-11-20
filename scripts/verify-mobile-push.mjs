// 手机端通知的真机检查：起真实 Server（配了全局令牌）+ 假模型 + 一个本地假的「推送服务」+ 无头 Chromium（手机设备描述），不需要真实模型。
// 订阅这一步（浏览器连 FCM 之类）在本机做不到，所以把 pushManager.subscribe 换成发给假推送端点的假订阅（密钥是真的，自己持有私钥）；
// 其余全部是真的：真 Server 发出加密的 Web Push，这里用私钥解开、核对载荷，再经 CDP 原样投递给真的 service worker，看它显示出什么通知。
//  1) 设置页「通知」：service worker 注册上（范围 /）；还没开时有「开启通知」；点了之后订阅送到服务端，三个开关与「什么时候发」是默认值
//  2) 偏好立即生效且刷新后还在：打开「跑完时通知」、选「总是」，服务端的值跟着变
//  3) 「发一条测试通知」：假推送端点收到一条加密推送，请求头齐备、VAPID 的 k 就是服务端公钥；解开是 test 载荷；
//     投给 service worker 后浏览器里有一条「测试通知」
//  4) 会话里要审批：服务端推 blocked（只含类型、会话 id 与标题，没有命令）→ 通知「需要你处理」；批准之后推 resolved，
//     替换同一条通知（同 tag、数量不增加）成低调文案（静音）；一轮结束再推 done，仍是同一条
//  5) 「关闭通知」：服务端没有订阅了，界面回到「开启通知」；全局令牌访问 /push 是 403
//  6) 明文来源（非安全上下文）：没有 service worker，界面说明要用 HTTPS，不出现「添加到主屏幕」
//  7) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-mobile-push.mjs [--shots 目录]
import { spawn } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "./lib/fake-model.mjs";
import { chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
// http_ece 是 web-push 的依赖（server 包没直接依赖它）：按 web-push 的位置解析
const ece = createRequire(
  createRequire(join(root, "packages/server/package.json")).resolve("web-push"),
)("http_ece");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 轮询到条件成立或超时；返回最后一次的取值。 */
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await sleep(150);
    v = await fn();
  }
  return v;
}
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
};

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "mobile-push-"));
const work = `${realpathSync(base)}/work`;
const dir = `${work}/proj`;
mkdirSync(dir, { recursive: true });

// 假推送服务：记下每一次 POST（请求头与加密的请求体），回 201
const received = [];
const pushService = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    received.push({ headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(201).end();
  });
});
await new Promise((ok) => pushService.listen(0, "127.0.0.1", ok));
const endpoint = `http://127.0.0.1:${pushService.address().port}/push/phone`;

// 假订阅的密钥：浏览器那边由 pushManager 生成，这里自己算一份，私钥留着解密
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const authSecret = randomBytes(16);
const FAKE_SUB = {
  endpoint,
  p256dh: ecdh.getPublicKey().toString("base64url"),
  auth: authSecret.toString("base64url"),
};
const decrypt = (body) =>
  JSON.parse(
    ece
      .decrypt(body, { version: "aes128gcm", privateKey: ecdh, authSecret })
      .toString("utf8"),
  );

// 剧本：一条要审批的命令，批准之后收尾
const fake = await startFakeModel(
  [
    {
      text: "我来建个目录。",
      tools: [
        {
          name: "bash",
          args: { command: "mkdir -p out && echo hi > out/a.txt" },
        },
      ],
    },
    { text: "完成。" },
  ],
  { delay: 30 },
);

const TOKEN = "p".repeat(40);
const port = 18500 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const proc = spawn(
  "node",
  [
    join(root, "packages/server/dist/bin.js"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--data-dir",
    join(base, "data"),
  ],
  {
    stdio: "ignore",
    cwd: work,
    // pi 的 SDK 给全局 fetch 装了按环境变量走代理的分发器：本机的假推送端点要排除在代理之外
    env: {
      ...process.env,
      YUANSHU_TOKEN: TOKEN,
      HOME: base,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
  },
);
const api = async (method, path, body, token = TOKEN) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};

const problems = [];

async function main() {
  let up = false;
  for (let i = 0; i < 600 && !up; i++) {
    try {
      up = (await fetch(`${origin}/healthz`)).ok;
    } catch {}
    if (!up) await sleep(100);
  }
  if (!up) throw new Error("Server 60 秒内没有起来（机器负载高时启动会很慢）");
  await api("POST", "/providers", {
    name: "假模型",
    slug: "fake",
    api: "openai-completions",
    baseUrl: fake.baseUrl,
    apiKey: "x",
    models: [
      {
        id: "fake",
        name: "fake",
        reasoning: true,
        levels: ["off", "low", "high"],
        input: ["text"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  const ws = (
    await api("POST", "/workspaces", {
      name: "推送",
      directories: [{ path: dir }],
    })
  ).body;
  const sid = (await api("POST", "/sessions", { workspaceId: ws.id })).body.id;
  await api("PATCH", `/sessions/${sid}`, { title: "推送会话" });
  const { code } = (await api("POST", "/devices/pairing", {})).body;
  const paired = (
    await api("POST", "/devices/pair", { code, name: "测试手机" })
  ).body;
  const deviceApi = (method, path, body) =>
    api(method, path, body, paired.token);

  // plain.test 解析到本机：http://plain.test 不是回环地址，浏览器当作明文（非安全上下文）来源，和手机用局域网 IP 访问一样
  const browser = await chromium.launch({
    channel: "chromium",
    // 不走环境里的代理（plain.test 不是回环地址，会被送去代理而 502）
    args: [
      "--host-resolver-rules=MAP plain.test 127.0.0.1",
      "--no-proxy-server",
    ],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    });
    await context.grantPermissions(["notifications"], { origin });
    await context.addInitScript(
      ({ token, sub }) => {
        localStorage.setItem("yuanshu.token", token);
        // 假订阅：subscribe 返回它，getSubscription 在订阅过之后返回它（存在 localStorage，刷新后还在）
        const KEY = "__fakeSub";
        const made = () => ({
          endpoint: sub.endpoint,
          toJSON: () => ({
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          }),
          unsubscribe: async () => {
            localStorage.removeItem(KEY);
            return true;
          },
        });
        PushManager.prototype.subscribe = async () => {
          localStorage.setItem(KEY, "1");
          return made();
        };
        PushManager.prototype.getSubscription = async () =>
          localStorage.getItem(KEY) ? made() : null;
      },
      { token: paired.token, sub: FAKE_SUB },
    );
    const page = await context.newPage();
    page.on("pageerror", (e) =>
      problems.push(`pageerror ${e.message.split("\n")[0]}`),
    );
    page.on("console", (m) => {
      if (m.type() === "error")
        problems.push(`console.error ${m.text().slice(0, 140)}`);
    });
    page.on("response", (r) => {
      if (r.url().includes("/api/v1/") && r.status() >= 400)
        problems.push(`${r.status()} ${r.url().split("/api/v1")[1]}`);
    });
    const shot = (n) =>
      SHOTS ? page.screenshot({ path: join(SHOTS, `${n}.png`) }) : null;

    // CDP：记下 service worker 的注册编号，之后原样投递推送
    const cdp = await context.newCDPSession(page);
    let registrationId = null;
    cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => {
      registrationId = e.registrations[0]?.registrationId ?? registrationId;
    });
    await cdp.send("ServiceWorker.enable");
    /** 把服务端发给假推送端点的第 n 条解开，并像浏览器那样投给 service worker */
    const deliver = async (req) => {
      const payload = decrypt(req.body);
      await cdp.send("ServiceWorker.deliverPushMessage", {
        origin,
        registrationId,
        data: JSON.stringify(payload),
      });
      return payload;
    };
    const notices = () =>
      page.evaluate(async () => {
        const reg = await navigator.serviceWorker.ready;
        return (await reg.getNotifications()).map((n) => ({
          title: n.title,
          body: n.body,
          tag: n.tag,
          silent: n.silent,
          sid: n.data?.sid,
        }));
      });
    const prefsOf = async () => (await deviceApi("GET", "/push")).body;

    // 1) 设置页
    await page.goto(`${origin}/m/settings`);
    await page.getByRole("button", { name: "开启通知" }).waitFor();
    const sw = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return {
        scope: new URL(reg.scope).pathname,
        script: new URL(reg.active.scriptURL).pathname,
      };
    });
    await shot("1-off");
    const before = (await prefsOf()).subscribed;
    await page.getByRole("button", { name: "开启通知" }).click();
    await page.getByLabel("需要你处理时通知").waitFor();
    const info = await prefsOf();
    const sw1 = await page.evaluate(() => ({
      blocked: document.querySelector('[aria-label="需要你处理时通知"]')
        ?.ariaChecked,
      error: document.querySelector('[aria-label="出错时通知"]')?.ariaChecked,
      done: document.querySelector('[aria-label="跑完时通知"]')?.ariaChecked,
    }));
    check(
      "设置页：service worker 注册在 /，没订阅时有「开启通知」；点了之后服务端记下订阅，开关与策略是默认值",
      sw.scope === "/" &&
        sw.script === "/sw.js" &&
        before === false &&
        info.subscribed === true &&
        info.prefs.blocked === true &&
        info.prefs.error === true &&
        info.prefs.done === false &&
        info.prefs.policy === "unwatched" &&
        info.prefs.delaySec === 30 &&
        sw1.blocked === "true" &&
        sw1.error === "true" &&
        sw1.done === "false",
      JSON.stringify({ sw, before, prefs: info.prefs, sw1 }),
    );
    await shot("2-on");

    // 2) 偏好立即生效，刷新后还在
    await page.getByLabel("跑完时通知").click();
    await page.getByRole("radio", { name: "总是" }).click();
    const after = (await until(async () => {
      const p = (await prefsOf()).prefs;
      return p.done && p.policy === "always" ? p : null;
    })) ?? { done: false };
    await page.reload();
    await page.getByLabel("跑完时通知").waitFor();
    const reloaded = await page.evaluate(() => ({
      done: document.querySelector('[aria-label="跑完时通知"]')?.ariaChecked,
      always: document
        .querySelector('[aria-label="什么时候发"] [aria-checked="true"]')
        ?.textContent?.trim(),
    }));
    check(
      "偏好立即生效：服务端的值变了，刷新后界面里还是这样",
      after.done === true &&
        after.policy === "always" &&
        reloaded.done === "true" &&
        reloaded.always === "总是",
      JSON.stringify({ after, reloaded }),
    );

    // 3) 测试通知
    await page.getByRole("button", { name: "发一条测试通知" }).click();
    const gotTest = await until(() => received.length >= 1);
    // 没收到时直接调一次接口，把服务端给的失败原因带进报告
    const why = gotTest
      ? null
      : (await deviceApi("POST", "/push/test", {})).body;
    const first = received[0];
    const k = /k=(\S+)/.exec(first?.headers.authorization ?? "")?.[1];
    check(
      "测试通知：假推送端点收到加密推送，请求头齐备，VAPID 的 k 就是服务端的公钥",
      gotTest &&
        /^vapid t=/.test(first.headers.authorization) &&
        first.headers["content-encoding"] === "aes128gcm" &&
        first.headers.ttl === "14400" &&
        first.headers.urgency === "high" &&
        k === info.publicKey,
      JSON.stringify({
        auth: first?.headers.authorization?.slice(0, 20),
        ttl: first?.headers.ttl,
        k: k?.slice(0, 12),
        why,
      }),
    );
    const testPayload = await deliver(first);
    const testNotice = await until(async () => {
      const list = await notices();
      return list.length === 1 ? list[0] : null;
    });
    check(
      "测试推送解开是 test 载荷，投给 service worker 后浏览器里有一条「测试通知」",
      testPayload.kind === "test" &&
        testPayload.tag === "test" &&
        testNotice?.title === "测试通知" &&
        testNotice.tag === "test",
      JSON.stringify({ testPayload, testNotice }),
    );

    // 4) 会话里要审批 → blocked → 批准 → resolved → done，同一条通知被替换
    await page.goto(`${origin}/m/s/${sid}`);
    await page.waitForSelector(".ch-shell");
    await page.locator(".ch-ta").click();
    await page.keyboard.type("建个目录");
    await page.getByRole("button", { name: "发送" }).click();
    const blockedReq = await until(
      () => received.length >= 2 && received[1],
      30000,
    );
    const blocked = blockedReq ? await deliver(blockedReq) : null;
    const afterBlocked = await until(async () => {
      const list = await notices();
      return list.find((n) => n.tag === `s:${sid}`) ?? null;
    });
    check(
      "要审批：服务端推 blocked，载荷只有类型 / 会话 id / 标题；通知是「需要你处理」，正文是会话标题",
      blocked?.kind === "blocked" &&
        blocked.sid === sid &&
        blocked.title === "推送会话" &&
        !JSON.stringify(blocked).includes("mkdir") &&
        afterBlocked?.title === "需要你处理" &&
        afterBlocked.body === "推送会话" &&
        afterBlocked.sid === sid,
      JSON.stringify({ blocked, afterBlocked }),
    );
    await page.getByRole("button", { name: "批准", exact: true }).click();
    const resolvedReq = await until(
      () => received.length >= 3 && received[2],
      30000,
    );
    const resolved = resolvedReq ? await deliver(resolvedReq) : null;
    const afterResolved = await until(async () => {
      const list = (await notices()).filter((n) => n.tag === `s:${sid}`);
      return list.length === 1 && list[0].title === "已处理" ? list : null;
    });
    check(
      "批准之后：推 resolved，替换同一条通知（同 tag、数量不增加），低调文案且静音",
      resolved?.kind === "resolved" &&
        resolved.tag === `s:${sid}` &&
        afterResolved?.length === 1 &&
        afterResolved[0].silent === true,
      JSON.stringify({ resolved, afterResolved }),
    );
    // 一轮结束：done（已选「总是」，所以正在看也会推）
    const doneReq = await until(
      () =>
        received.slice(3).find((r) => {
          try {
            return decrypt(r.body).kind === "done";
          } catch {
            return false;
          }
        }),
      30000,
    );
    const done = doneReq ? await deliver(doneReq) : null;
    const afterDone = await until(async () => {
      const list = (await notices()).filter((n) => n.tag === `s:${sid}`);
      return list.length === 1 && list[0].title === "已完成" ? list : null;
    });
    check(
      "一轮结束：推 done，仍是同一条通知（被替换成「已完成」）",
      done?.kind === "done" && afterDone?.length === 1,
      JSON.stringify({ done, afterDone }),
    );
    await shot("3-chat");

    // 5) 关闭通知
    await page.goto(`${origin}/m/settings`);
    await page.getByRole("button", { name: "关闭通知" }).click();
    await page.getByRole("button", { name: "开启通知" }).waitFor();
    const off = await prefsOf();
    const global = await api("GET", "/push");
    check(
      "「关闭通知」：服务端没有订阅了，界面回到「开启通知」；全局令牌访问 /push 是 403",
      off.subscribed === false && off.prefs === null && global.status === 403,
      JSON.stringify({ subscribed: off.subscribed, global: global.status }),
    );
    await shot("4-off-again");

    // 6) 明文来源（局域网 IP 访问）：浏览器不给 service worker 与推送，界面说清原因，也不出现「添加到主屏幕」
    const plain = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await plain.addInitScript((token) => {
      localStorage.setItem("yuanshu.token", token);
    }, paired.token);
    const pp = await plain.newPage();
    await pp.goto(`http://plain.test:${port}/m/settings`);
    await pp.getByText(/当前是明文访问/).waitFor();
    const insecure = await pp.evaluate(() => ({
      secure: window.isSecureContext,
      hasWorker: "serviceWorker" in navigator,
      text: document.body.innerText,
    }));
    check(
      "明文来源：不是安全上下文、没有 service worker；通知那里说明要用 HTTPS，且没有「添加到主屏幕」",
      insecure.secure === false &&
        insecure.hasWorker === false &&
        insecure.text.includes("用 HTTPS 访问后才能开启") &&
        !insecure.text.includes("添加到主屏幕") &&
        !insecure.text.includes("开启通知"),
      JSON.stringify({
        secure: insecure.secure,
        hasWorker: insecure.hasWorker,
      }),
    );
    if (SHOTS) await pp.screenshot({ path: join(SHOTS, "5-plain.png") });
  } finally {
    await browser.close();
  }
}

let crashed = null;
try {
  await main();
} catch (e) {
  crashed = e;
} finally {
  proc.kill("SIGTERM");
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  pushService.close();
  await fake.close();
  rmSync(base, { recursive: true, force: true });
}

const uniq = [...new Set(problems)];
check(
  "全程没有控制台报错、没有失败的接口请求",
  uniq.length === 0,
  uniq.slice(0, 5).join(" | "),
);
if (crashed)
  console.log(
    `脚本异常：${String(crashed.message).split("\n").slice(0, 4).join(" | ")}`,
  );
const bad = results.filter((r) => !r).length + (crashed ? 1 : 0);
console.log(
  bad
    ? `\n未通过：${bad} 项`
    : `\nPASS  手机端通知：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
