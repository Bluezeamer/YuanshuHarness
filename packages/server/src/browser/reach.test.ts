import { expect, test } from "vitest";
import { targetOptions, workspaceReach } from "./reach.js";

const dirs = [
  { environmentId: "local", path: "/home/me/proj" },
  { environmentId: "gpu1", path: "/data/work" },
];

test("裸 localhost 指向主目录所在的环境；没有目录时一律拒绝", () => {
  expect(workspaceReach(() => dirs).loopbackEnvId).toBe("local");
  expect(workspaceReach(() => []).loopbackEnvId).toBeNull();
});

test("服务只放行工作区目录所在的环境", () => {
  const reach = workspaceReach(() => dirs);
  expect(reach.allowService("local", 3000)).toBe(true);
  expect(reach.allowService("gpu1", 8080)).toBe(true);
  expect(reach.allowService("other", 3000)).toBe(false);
});

test("Server 自己的端口在本机环境上一律拒；别的环境同号端口不受影响", () => {
  const reach = workspaceReach(
    () => dirs,
    () => 7431,
  );
  expect(reach.allowService("local", 7431)).toBe(false);
  expect(reach.allowService("local", 7432)).toBe(true);
  expect(reach.allowService("gpu1", 7431)).toBe(true);

  // 还没 listen（null）时不拒任何端口
  const unknown = workspaceReach(
    () => dirs,
    () => null,
  );
  expect(unknown.allowService("local", 7431)).toBe(true);
});

test("文件只放行目录之内且不敏感的路径，且要环境对得上", async () => {
  const reach = workspaceReach(() => dirs);
  const ok = async (env: string, p: string) => await reach.allowFile(env, p);
  expect(await ok("local", "/home/me/proj/index.html")).toBe(true);
  expect(await ok("local", "/home/me/proj")).toBe(true);
  expect(await ok("gpu1", "/data/work/a/b.png")).toBe(true);
  // 目录之外、前缀相同的兄弟目录、环境不匹配
  expect(await ok("local", "/home/me/other/a.html")).toBe(false);
  expect(await ok("local", "/home/me/proj-secret/a.html")).toBe(false);
  expect(await ok("gpu1", "/home/me/proj/index.html")).toBe(false);
  // 敏感名单：即使在目录之内
  expect(await ok("local", "/home/me/proj/.env")).toBe(false);
  expect(await ok("local", "/home/me/proj/.ssh/id_rsa")).toBe(false);
  expect(await ok("local", "/home/me/proj/.env.example")).toBe(true);
});

test("目录清单现取：改了之后下一次判定就按新的", async () => {
  let current = dirs;
  const reach = workspaceReach(() => current);
  expect(await reach.allowFile("gpu1", "/data/work/a")).toBe(true);
  current = [dirs[0] as (typeof dirs)[number]];
  expect(await reach.allowFile("gpu1", "/data/work/a")).toBe(false);
  expect(reach.allowService("gpu1", 1)).toBe(false);
});

test("findEnv：local 是主目录所在的主机，server 是本机，其余按 id 或名称（不分大小写）；附件区不是主机", () => {
  const opts = targetOptions(
    () => [
      { id: "local", name: "本机" },
      { id: "0190-abc", name: "Web1" },
      // 用户把 ssh 环境起名叫 server：别名优先，不能被它劫持
      { id: "0190-evil", name: "server" },
    ],
    "local",
    // 主目录在一个 ssh 环境上：local 指它，Server 本机改用 server
    "0190-abc",
  );
  expect(opts.findEnv("local")).toBe("0190-abc");
  expect(opts.findEnv("LOCAL")).toBe("0190-abc");
  expect(opts.findEnv("server")).toBe("local");
  expect(opts.findEnv("SERVER")).toBe("local");
  expect(opts.findEnv("web1")).toBe("0190-abc");
  expect(opts.findEnv("0190-abc")).toBe("0190-abc");
  expect(opts.findEnv("本机")).toBe("local");
  expect(opts.findEnv("nope")).toBeNull();
  // 浏览器到不了附件区：哪怕有环境（连接）就叫 attachment
  expect(opts.findEnv("attachment")).toBeNull();
  const named = targetOptions(
    () => [
      { id: "local", name: "本机" },
      { id: "x1", name: "attachment" },
    ],
    "local",
    "local",
  );
  expect(named.findEnv("attachment")).toBeNull();
  expect(opts.defaultEnvId).toBe("local");

  // 主目录就在本机：local 与 server 都落在本机
  const same = targetOptions(
    () => [{ id: "local", name: "本机" }],
    "local",
    "local",
  );
  expect(same.findEnv("local")).toBe("local");
  expect(same.findEnv("server")).toBe("local");

  // 工作区没有主目录：local 找不到主机
  const none = targetOptions(() => [{ id: "local", name: "本机" }], null, null);
  expect(none.findEnv("local")).toBeNull();
});
