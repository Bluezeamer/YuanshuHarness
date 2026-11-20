// service worker（桌面 / 与手机 /m/ 共用）：
//  1) 只缓存应用外壳（页面与静态资源），让 WebUI 可安装、离线能打开壳；
//     API 与 WS 永远走网络、不进缓存；带 Authorization 的请求同样放行，令牌绝不落入缓存。
//  2) 手机的 Web Push：每条 push 都必须显示一条通知（浏览器不允许静默推送）；点通知进对应会话。
const CACHE = "yuanshu-shell-v2";
// 两个入口各缓存一份自己的壳，离线时各回各的（不能互相覆盖）
const SHELLS = ["/", "/m/"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.all(SHELLS.map((s) => c.add(s))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) =>
        Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

const cacheable = (req) => {
  if (req.method !== "GET" || req.headers.has("Authorization")) return false;
  const u = new URL(req.url);
  return u.origin === self.location.origin && !u.pathname.startsWith("/api/");
};

// /m 与 /m/ 下的一切是手机（不含 /mark.svg 这类只是以 m 开头的路径）
const isMobilePath = (p) => p === "/m" || p.startsWith("/m/");

// 页面请求属于哪个入口的壳
const shellOf = (req) =>
  isMobilePath(new URL(req.url).pathname) ? "/m/" : "/";

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (!cacheable(req)) return;
  if (req.mode === "navigate") {
    // 页面：网络优先，保证部署新版后立刻生效；离线才回落到缓存的壳。
    const shell = shellOf(req);
    e.respondWith(
      fetch(req).then(
        (res) => {
          // 只有 HTML 才是壳：直接在地址栏打开一张图标，不能把它存成离线时回的页面
          if (
            res.ok &&
            res.headers.get("content-type")?.includes("text/html")
          ) {
            const copy = res.clone();
            e.waitUntil(caches.open(CACHE).then((c) => c.put(shell, copy)));
          }
          return res;
        },
        () => caches.match(shell).then((r) => r || Response.error()),
      ),
    );
    return;
  }
  // 静态资源（文件名带内容哈希）：缓存优先，未命中再取网络并写入。
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
          }
          return res;
        }),
    ),
  );
});

// ── Web Push ──
// 载荷由 Server 给：{ v: 1, kind, sid, title, tag }。kind：blocked 待处理 / error 出错 / done 跑完了 /
// resolved 前面那条已在别处处理 / test 测试。内容只有会话标题与类型，不带命令与输出。
const KIND_TEXT = {
  blocked: "需要你处理",
  error: "出错了",
  done: "已完成",
  resolved: "已处理",
  test: "测试通知",
};

const noticeOf = (p) => {
  const kind = Object.hasOwn(KIND_TEXT, p?.kind) ? p.kind : "done";
  const quiet = kind === "resolved";
  return {
    title: KIND_TEXT[kind],
    options: {
      body: kind === "test" ? "手机通知已经打通" : String(p?.title ?? ""),
      // 同一会话的通知同 tag：新的替换旧的；resolved 也走这条，替换成低调文案、不再响
      tag: typeof p?.tag === "string" && p.tag ? p.tag : "yuanshu",
      renotify: !quiet,
      silent: quiet,
      icon: "/m/icon-192.png",
      badge: "/m/icon-192.png",
      data: { sid: typeof p?.sid === "string" ? p.sid : "" },
    },
  };
};

self.addEventListener("push", (e) => {
  let payload = null;
  try {
    payload = e.data ? e.data.json() : null;
  } catch {}
  const { title, options } = noticeOf(payload);
  e.waitUntil(self.registration.showNotification(title, options));
});

// 点通知：已有 /m/ 窗口就聚焦并让它切到那个会话，否则新开（深链接进来时栈底是列表）
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const sid = e.notification.data?.sid ?? "";
  const url = sid ? `/m/s/${encodeURIComponent(sid)}` : "/m/";
  e.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((all) => {
        const open = all.find((c) => isMobilePath(new URL(c.url).pathname));
        if (!open) return self.clients.openWindow(url);
        open.postMessage({ type: "open-session", sid });
        return open.focus();
      }),
  );
});
