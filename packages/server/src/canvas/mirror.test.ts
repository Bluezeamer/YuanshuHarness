import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv } from "../env/types.js";
import { CanvasMirror } from "./mirror.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 包一层：记下调用，可以让它「断线」或「一直不回」。 */
function remoteOf(env: LocalEnv) {
  const ctl = {
    down: false,
    hang: false,
    calls: [] as Array<[string, unknown]>,
  };
  const proxy = new Proxy(env, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        ctl.calls.push([String(prop), args[0]]);
        if (ctl.down) return Promise.reject(new Error("connection lost"));
        if (ctl.hang) return new Promise(() => {});
        return value.apply(target, args);
      };
    },
  }) as ExecEnv;
  return { env: proxy, ctl };
}

function setup() {
  const base = mkdtempSync(path.join(tmpdir(), "yuanshu-mirror-"));
  dirs.push(base);
  const remoteRoot = path.join(base, "remote", ".canvas");
  const localRoot = path.join(base, "replica", ".canvas");
  const metaFile = path.join(base, "replica", "mirror.json");
  mkdirSync(path.dirname(remoteRoot), { recursive: true });
  const remote = remoteOf(new LocalEnv());
  const make = () =>
    new CanvasMirror({
      remote: remote.env,
      remoteRoot,
      local: new LocalEnv(),
      localRoot,
      metaFile,
      debounceMs: 10,
      now: () => new Date(2026, 10, 11, 9, 8, 7),
    });
  return { remoteRoot, localRoot, metaFile, remote, make, mirror: make() };
}

const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const text = (file: string) => readFileSync(file, "utf8");
const names = (dir: string) => readdirSync(dir).sort();
/** 推送写远端文件的次数（含临时文件） */
const writesOf = (r: ReturnType<typeof remoteOf>) =>
  r.ctl.calls.filter(([n]) => n === "writeStream").length;

describe("接入（远端 → 本机）", () => {
  test("拉取除 .git 以外的全部文件；远端原样保留；之后再推没有差异", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "index.md"), "# idx");
    put(path.join(t.remoteRoot, "boards/a.canvas"), "{}");
    put(path.join(t.remoteRoot, "boards/a.cards/c1.md"), "card");
    mkdirSync(path.join(t.remoteRoot, "empty"));
    put(path.join(t.remoteRoot, ".git/HEAD"), "ref");
    expect(t.mirror.adopted).toBe(false);

    await t.mirror.ready();

    expect(t.mirror.adopted).toBe(true);
    expect(names(t.localRoot)).toEqual(["boards", "empty", "index.md"]);
    expect(text(path.join(t.localRoot, "boards/a.cards/c1.md"))).toBe("card");
    expect(existsSync(path.join(t.remoteRoot, ".git/HEAD"))).toBe(true);
    const before = writesOf(t.remote);
    expect(await t.mirror.settle(2000)).toBe(true);
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);
    expect(writesOf(t.remote)).toBe(before);
  });

  test("远端没有 .canvas：本机也不建；之后本机建出来的会推过去", async () => {
    const t = setup();
    await t.mirror.ready();
    expect(existsSync(t.localRoot)).toBe(false);

    put(path.join(t.localRoot, "boards/x.canvas"), "{}");
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);
    expect(text(path.join(t.remoteRoot, "boards/x.canvas"))).toBe("{}");
  });

  test("接入过之后重建实例：只读清单，不再碰远端", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "a.md"), "A");
    await t.mirror.ready();
    t.mirror.touch();
    await t.mirror.settle(2000);

    const again = t.make();
    expect(again.adopted).toBe(true);
    t.remote.ctl.calls.length = 0;
    await again.ready();
    expect(t.remote.ctl.calls).toEqual([]);
  });
});

describe("推送（本机 → 远端）", () => {
  test("新增、修改、删除、空目录都推过去；.git 与临时文件不推", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "keep.md"), "k");
    put(path.join(t.remoteRoot, "old.md"), "o");
    await t.mirror.ready();

    put(path.join(t.localRoot, "keep.md"), "k2");
    put(path.join(t.localRoot, "new/deep/n.md"), "n");
    mkdirSync(path.join(t.localRoot, "hollow"));
    rmSync(path.join(t.localRoot, "old.md"));
    put(path.join(t.localRoot, ".git/HEAD"), "ref");
    put(path.join(t.localRoot, ".x.md.1234.part"), "half");
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);

    expect(text(path.join(t.remoteRoot, "keep.md"))).toBe("k2");
    expect(text(path.join(t.remoteRoot, "new/deep/n.md"))).toBe("n");
    expect(existsSync(path.join(t.remoteRoot, "hollow"))).toBe(true);
    expect(existsSync(path.join(t.remoteRoot, "old.md"))).toBe(false);
    expect(names(t.remoteRoot)).toEqual(["hollow", "keep.md", "new"]);
  });

  test("删掉文件夹：文件先删、再删空目录", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "d/a.md"), "a");
    put(path.join(t.remoteRoot, "d/sub/b.md"), "b");
    await t.mirror.ready();

    rmSync(path.join(t.localRoot, "d"), { recursive: true });
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);
    expect(existsSync(path.join(t.remoteRoot, "d"))).toBe(false);
  });

  test("内容没变只是时间变了：不重传", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "a.md"), "A");
    await t.mirror.ready();
    const before = writesOf(t.remote);

    utimesSync(path.join(t.localRoot, "a.md"), new Date(), new Date(1e12));
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);
    expect(writesOf(t.remote)).toBe(before);
  });

  test("挪动文件（内容相同）：远端改名，不重传", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "boards/a.cards/c.md"), "same body");
    put(path.join(t.remoteRoot, "boards/a.canvas"), "{}");
    await t.mirror.ready();
    const before = writesOf(t.remote);

    const lc = (p: string) => path.join(t.localRoot, p);
    mkdirSync(lc("boards/b.cards"));
    writeFileSync(lc("boards/b.cards/c.md"), "same body");
    rmSync(lc("boards/a.cards"), { recursive: true });
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);

    expect(text(path.join(t.remoteRoot, "boards/b.cards/c.md"))).toBe(
      "same body",
    );
    expect(existsSync(path.join(t.remoteRoot, "boards/a.cards"))).toBe(false);
    expect(writesOf(t.remote)).toBe(before);
  });
});

describe("远端被外部改过", () => {
  test("覆盖前先把外部版本另存在旁边，再写我们的", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "n.md"), "v1");
    await t.mirror.ready();

    put(path.join(t.remoteRoot, "n.md"), "human edit on remote");
    put(path.join(t.localRoot, "n.md"), "v2 from app");
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);

    expect(text(path.join(t.remoteRoot, "n.md"))).toBe("v2 from app");
    const aside = path.join(t.remoteRoot, "n.remote-20261111-090807.md");
    expect(text(aside)).toBe("human edit on remote");
    expect(t.mirror.status().asides).toEqual([aside]);
  });

  test("删除前远端被改过：改名另存，不删", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "n.md"), "v1");
    await t.mirror.ready();

    put(path.join(t.remoteRoot, "n.md"), "edited remotely");
    rmSync(path.join(t.localRoot, "n.md"));
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);

    expect(existsSync(path.join(t.remoteRoot, "n.md"))).toBe(false);
    expect(text(path.join(t.remoteRoot, "n.remote-20261111-090807.md"))).toBe(
      "edited remotely",
    );
  });

  test("远端只是被碰了时间、内容没变：不算外部改动", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "n.md"), "v1");
    await t.mirror.ready();

    utimesSync(path.join(t.remoteRoot, "n.md"), new Date(), new Date(1e12));
    put(path.join(t.localRoot, "n.md"), "v2 edited");
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);

    expect(text(path.join(t.remoteRoot, "n.md"))).toBe("v2 edited");
    expect(t.mirror.status().asides).toEqual([]);
  });

  test("上次推到一半崩溃（远端已经是新内容、清单没记）：重试不另存", async () => {
    const t = setup();
    await t.mirror.ready();

    put(path.join(t.localRoot, "n.md"), "body");
    put(path.join(t.remoteRoot, "n.md"), "body");
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);
    expect(names(t.remoteRoot)).toEqual(["n.md"]);
  });
});

describe("断线与重启", () => {
  test("远端不通：本机照常读写，状态是离线；通了之后推过去", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "a.md"), "A");
    await t.mirror.ready();

    t.remote.ctl.down = true;
    put(path.join(t.localRoot, "a.md"), "A2");
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(false);
    expect(t.mirror.status().state).toBe("offline");
    expect(t.mirror.status().error).toContain("connection lost");
    expect(text(path.join(t.remoteRoot, "a.md"))).toBe("A");

    t.remote.ctl.down = false;
    expect(await t.mirror.settle(2000)).toBe(true);
    expect(text(path.join(t.remoteRoot, "a.md"))).toBe("A2");
    expect(t.mirror.status()).toMatchObject({ state: "synced", pending: 0 });
  });

  test("远端一直不回：settle 超时返回 false", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "a.md"), "A");
    await t.mirror.ready();

    t.remote.ctl.hang = true;
    put(path.join(t.localRoot, "a.md"), "A2");
    t.mirror.touch();
    expect(await t.mirror.settle(100)).toBe(false);
    t.mirror.close();
  });

  test("没推完就重启：新实例凭清单把差异补推", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "a.md"), "A");
    await t.mirror.ready();
    t.mirror.touch();
    await t.mirror.settle(2000);
    t.mirror.close();

    put(path.join(t.localRoot, "a.md"), "A2");
    put(path.join(t.localRoot, "b.md"), "B");
    const again = t.make();
    await again.ready();
    again.touch();
    expect(await again.settle(2000)).toBe(true);
    expect(text(path.join(t.remoteRoot, "a.md"))).toBe("A2");
    expect(text(path.join(t.remoteRoot, "b.md"))).toBe("B");
  });

  test("本机副本目录丢了：报错，不把远端清空", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "a.md"), "A");
    await t.mirror.ready();

    rmSync(t.localRoot, { recursive: true });
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(false);
    expect(t.mirror.status().error).toContain("副本目录不见了");
    expect(text(path.join(t.remoteRoot, "a.md"))).toBe("A");
    t.mirror.close();
  });
});

describe("review 之后加的保护", () => {
  test("同一秒内两次外部改动：第二份另存不覆盖第一份（加 -2）", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "n.md"), "v1");
    await t.mirror.ready();

    put(path.join(t.remoteRoot, "n.md"), "remote edit A");
    put(path.join(t.localRoot, "n.md"), "app edit 1");
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);
    put(path.join(t.remoteRoot, "n.md"), "remote edit B");
    put(path.join(t.localRoot, "n.md"), "app edit 22");
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);

    expect(text(path.join(t.remoteRoot, "n.md"))).toBe("app edit 22");
    expect(text(path.join(t.remoteRoot, "n.remote-20261111-090807.md"))).toBe(
      "remote edit A",
    );
    expect(text(path.join(t.remoteRoot, "n.remote-20261111-090807-2.md"))).toBe(
      "remote edit B",
    );
  });

  test("删空目录时远端那里已被换成文件：不删它", async () => {
    const t = setup();
    mkdirSync(path.join(t.remoteRoot, "d"), { recursive: true });
    await t.mirror.ready();

    rmSync(path.join(t.remoteRoot, "d"), { recursive: true });
    put(path.join(t.remoteRoot, "d"), "someone put a file here");
    rmSync(path.join(t.localRoot, "d"), { recursive: true });
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);
    expect(text(path.join(t.remoteRoot, "d"))).toBe("someone put a file here");
  });

  test("远端的 .canvas 被删了：项目目录还在就整份重推（没改的文件也推）", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "a.md"), "A");
    put(path.join(t.remoteRoot, "b/c.md"), "C");
    await t.mirror.ready();

    rmSync(t.remoteRoot, { recursive: true });
    put(path.join(t.localRoot, "a.md"), "A edited");
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(true);
    expect(text(path.join(t.remoteRoot, "a.md"))).toBe("A edited");
    expect(text(path.join(t.remoteRoot, "b/c.md"))).toBe("C");
  });

  test("远端的项目目录也没了：报错、不替它重建", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "a.md"), "A");
    await t.mirror.ready();

    rmSync(path.dirname(t.remoteRoot), { recursive: true });
    put(path.join(t.localRoot, "a.md"), "A edited");
    t.mirror.touch();
    expect(await t.mirror.settle(2000)).toBe(false);
    expect(t.mirror.status()).toMatchObject({ state: "offline" });
    expect(t.mirror.status().error).toContain("远端项目目录不存在");
    expect(existsSync(path.dirname(t.remoteRoot))).toBe(false);
    t.mirror.close();
  });

  test("重启后立刻 settle（清单还没读）：先读清单，把上次没推完的推完才返回", async () => {
    const t = setup();
    put(path.join(t.remoteRoot, "a.md"), "A");
    await t.mirror.ready();
    t.mirror.close();

    put(path.join(t.localRoot, "a.md"), "A left unpushed");
    const again = t.make();
    expect(await again.settle(3000)).toBe(true);
    expect(text(path.join(t.remoteRoot, "a.md"))).toBe("A left unpushed");
    again.close();
  });
});
