// 最小 service worker：只缓存应用外壳（页面与静态资源），让 WebUI 可安装、离线能打开壳。
// API 与 WS 永远走网络、不进缓存；带 Authorization 的请求同样放行，令牌绝不落入缓存。
const CACHE = "yuanshu-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.add("/"))
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

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (!cacheable(req)) return;
  if (req.mode === "navigate") {
    // 页面：网络优先，保证部署新版后立刻生效；离线才回落到缓存的壳。
    e.respondWith(
      fetch(req).then(
        (res) => {
          if (res.ok) {
            const copy = res.clone();
            e.waitUntil(caches.open(CACHE).then((c) => c.put("/", copy)));
          }
          return res;
        },
        () => caches.match("/").then((r) => r || Response.error()),
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
