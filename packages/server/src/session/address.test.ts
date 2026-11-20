// 位置解析的唯一实现的单测：host 与 path 分开，表驱动覆盖全部规则
// （不写 / 裸主机 / host:目录名 × path 缺省 / 相对 / 绝对 / ~、主机别名与大小写、子代理场景、附件区、错误原文、安全网）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { ExecEnv } from "../env/types.js";
import { VirtualEnv } from "../env/virtual.js";
import type { Directory } from "../store/directories.js";
import {
  ATTACHMENT_ENV_ID,
  COLLAB_ENV_ID,
  LOCAL_ENV_ID,
} from "../store/environments.js";
import { createAddressBook, hostLabel } from "./address.js";

const root = mkdtempSync(path.join(tmpdir(), "yuanshu-address-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const stub = (id: string, kind: "local" | "ssh"): ExecEnv =>
  ({
    id,
    kind,
    homedir: async () => (kind === "ssh" ? "/home/u" : "/home/me"),
    stat: async () => null,
  }) as unknown as ExecEnv;

const local = stub(LOCAL_ENV_ID, "local");
const dev1 = stub("e1", "ssh");
const attachRoot = path.join(root, "attachments", "s1");
const virtual = new VirtualEnv(attachRoot);
const collabRoot = path.join(root, "collab");
const collabEnv = new VirtualEnv(collabRoot, COLLAB_ENV_ID);

const dir = (
  id: string,
  name: string,
  p: string,
  environmentId = LOCAL_ENV_ID,
): Directory => ({ id, name, path: p, environmentId, createdAt: "t" });

function book(o: {
  directories: Directory[];
  /** 主目录所在的 env id；缺省 local。 */
  primaryEnvId?: string | null;
  currentId: string;
  envs?: Record<string, ExecEnv | undefined>;
}) {
  const envs: Record<string, ExecEnv | undefined> = {
    [LOCAL_ENV_ID]: local,
    e1: dev1,
    [ATTACHMENT_ENV_ID]: virtual,
    [COLLAB_ENV_ID]: collabEnv,
    ...o.envs,
  };
  return createAddressBook({
    directories: () => o.directories,
    primaryEnvId: () =>
      o.primaryEnvId === undefined ? LOCAL_ENV_ID : o.primaryEnvId,
    current: () => {
      const hit = o.directories.find((d) => d.id === o.currentId);
      if (!hit) throw new Error("no current");
      return hit;
    },
    envOf: (d) => envs[d.environmentId] ?? null,
    connectionName: (id) => (id === "e1" ? "dev1" : undefined),
  });
}

const PROJ = dir("d1", "proj", "/home/me/proj");
const DOCS = dir("d2", "docs", "/home/me/docs");
const TRAIN = dir("d3", "train", "/data/train", "e1");
const LOGS = dir("d4", "logs", "/var/log/app", "e1");
const COLLAB_ROOT = path.join(collabRoot, "r1");
const COLLAB = dir("c1", "collab", COLLAB_ROOT, COLLAB_ENV_ID);
const ATT = dir("a1", "attachment", attachRoot, ATTACHMENT_ENV_ID);

describe("locate：不写 host", () => {
  const b = book({ directories: [PROJ, DOCS, TRAIN], currentId: "d1" });

  test("path 缺省 / 空串 = 当前目录本身", async () => {
    for (const p of [undefined, "", "   "]) {
      const at = await b.locate(undefined, p);
      expect(at).toMatchObject({
        host: "local",
        path: "/home/me/proj",
        shown: "local:/home/me/proj",
      });
      expect(at.directory.id).toBe("d1");
    }
  });

  test("相对路径从当前目录起；前导 @ 去掉（pi 工具的既有约定）", async () => {
    expect((await b.locate(undefined, "a.txt")).path).toBe(
      "/home/me/proj/a.txt",
    );
    expect((await b.locate("", "@a.txt")).path).toBe("/home/me/proj/a.txt");
    expect((await b.locate("  ", "../x")).path).toBe("/home/me/x");
  });

  test("带冒号的普通文件名仍是相对路径", async () => {
    expect((await b.locate(undefined, "a:b.txt")).path).toBe(
      "/home/me/proj/a:b.txt",
    );
    expect((await b.locate(undefined, "dev9:src/a.ts")).path).toBe(
      "/home/me/proj/dev9:src/a.ts",
    );
  });

  test("绝对路径与 ~ 都在当前目录所在的主机上", async () => {
    expect((await b.locate(undefined, "/etc/hosts")).path).toBe("/etc/hosts");
    expect((await b.locate(undefined, "~/x")).path).toBe("/home/me/x");
    expect((await b.locate(undefined, "~")).path).toBe("/home/me");
  });
});

describe("locate：裸主机", () => {
  const b = book({ directories: [PROJ, DOCS, TRAIN, LOGS], currentId: "d1" });

  test("绝对路径与 ~ 在它上面展开", async () => {
    const at = await b.locate("dev1", "/data/train/a.bin");
    expect(at).toMatchObject({ host: "dev1", path: "/data/train/a.bin" });
    expect(at.env).toBe(dev1);
    expect((await b.locate("dev1", "~/x")).path).toBe("/home/u/x");
  });

  test("主机名大小写不敏感", async () => {
    expect((await b.locate("Dev1", "/data/x")).host).toBe("dev1");
    expect((await b.locate("LOCAL", "/a")).host).toBe("local");
  });

  test("相对路径拒绝，报错里教它点名一个目录", async () => {
    await expect(b.locate("dev1", "p")).rejects.toThrow(
      'A relative path on host "dev1" needs a directory. Write an absolute path (/p or ~/p), or name a directory in the host parameter, e.g. dev1:train. Directories on dev1: dev1:train, dev1:logs.',
    );
  });

  test("path 缺省拒绝", async () => {
    await expect(b.locate("dev1", undefined)).rejects.toThrow(
      "A host on its own needs a path. Give an absolute path (/… or ~/…), or name a directory in the host parameter, e.g. dev1:train. Directories on dev1: dev1:train, dev1:logs.",
    );
  });

  test("server 是 Server 所在物理机的别名（主目录在本机时也是 local 的别名）", async () => {
    const at = await b.locate("server", "/srv/x");
    expect(at.env).toBe(local);
    expect(at.path).toBe("/srv/x");
  });
});

describe("locate：host:目录名", () => {
  const b = book({ directories: [PROJ, DOCS, TRAIN, LOGS], currentId: "d1" });

  test("path 缺省 = 该目录本身", async () => {
    const at = await b.locate("dev1:train", undefined);
    expect(at).toMatchObject({
      host: "dev1",
      path: "/data/train",
      shown: "dev1:/data/train",
    });
    expect(at.directory.id).toBe("d3");
  });

  test("相对路径从该目录起，归属也是它", async () => {
    const at = await b.locate("dev1:train", "a.bin");
    expect(at.path).toBe("/data/train/a.bin");
    expect(at.directory.id).toBe("d3");
  });

  test("绝对路径仍在它自己的主机上，可以写出目录之外", async () => {
    const at = await b.locate("dev1:train", "/etc/x");
    expect(at).toMatchObject({ host: "dev1", path: "/etc/x" });
    expect(at.env).toBe(dev1);
    expect((await b.locate("dev1:train", "~/x")).path).toBe("/home/u/x");
  });

  test("目录名按第一个冒号切，可以含冒号", async () => {
    const odd = dir("d9", "a:b", "/srv/ab", "e1");
    const bb = book({ directories: [PROJ, TRAIN, odd], currentId: "d1" });
    expect((await bb.locate("dev1:a:b", "x")).path).toBe("/srv/ab/x");
  });

  test("目录不存在：报错带清单", async () => {
    await expect(b.locate("dev1:nope", "/x")).rejects.toThrow(
      'Directory "dev1:nope" not found. Directories in this session: local:proj, local:docs, dev1:train, dev1:logs.',
    );
  });

  test("冒号后面是路径：教它把主机与路径分开", async () => {
    await expect(b.locate("dev1:/data/x", "a")).rejects.toThrow(
      '"dev1:/data/x" is not a directory name. To use an arbitrary path, pass host="dev1" with an absolute path; to use a directory, name it: dev1:<name>. Directories in this session: local:proj, local:docs, dev1:train, dev1:logs.',
    );
    await expect(b.locate("dev1:~/x", undefined)).rejects.toThrow(
      "is not a directory name",
    );
  });
});

describe("locate：主目录在 ssh 主机上", () => {
  const b = book({
    directories: [TRAIN, PROJ],
    primaryEnvId: "e1",
    currentId: "d3",
  });

  test("local 指向它，server 指向 Server 物理机", async () => {
    expect((await b.locate(undefined, "x.txt")).host).toBe("local");
    expect((await b.locate(undefined, "x.txt")).env).toBe(dev1);
    expect((await b.locate("server", "/srv/x")).env).toBe(local);
    expect((await b.locate("server", "/srv/x")).host).toBe("server");
    expect((await b.locate("local", "/data/x")).env).toBe(dev1);
    expect(b.labelOf(LOCAL_ENV_ID)).toBe("server");
    expect(b.hosts().map((h) => h.label)).toEqual(["local", "server"]);
  });
});

describe("locate：子代理（目录子集在别的机器上）", () => {
  // 派发它的会话主目录在本机；子代理只拿到 dev1 上的一个目录。
  const b = book({
    directories: [
      TRAIN,
      dir("a1", "attachment", attachRoot, ATTACHMENT_ENV_ID),
    ],
    primaryEnvId: LOCAL_ENV_ID,
    currentId: "d3",
  });

  test("hosts() 只有 dev1 与 attachment；dev1 的标签就是 dev1，不是 local", () => {
    expect(b.hosts().map((h) => h.label)).toEqual(["dev1", "attachment"]);
    expect(b.refOf(TRAIN)).toBe("dev1:train");
  });
  test("local 不在它的目录里：未知主机；不写 host 与写 dev1 / dev1:train 都行", async () => {
    await expect(b.locate("local", "/data/x")).rejects.toThrow(
      'Unknown host "local". Hosts in this session: dev1, attachment.',
    );
    expect((await b.locate(undefined, "x")).path).toBe("/data/train/x");
    expect((await b.locate("dev1", "/data/x")).path).toBe("/data/x");
    expect((await b.locate("dev1:train", "x")).path).toBe("/data/train/x");
    expect((await b.locate(undefined, undefined)).shown).toBe(
      "dev1:/data/train",
    );
  });
});

describe("locate：附件区（虚拟主机 attachment）", () => {
  const b = book({ directories: [PROJ, ATT], currentId: "d1" });

  test("以附件区根为 /，展示形式不暴露真实路径", async () => {
    const at = await b.locate("attachment", "/2026-11-16/ab12cd34-x.png");
    expect(at.env).toBe(virtual);
    expect(at.path).toBe(path.join(attachRoot, "2026-11-16", "ab12cd34-x.png"));
    expect(at.shown).toBe("attachment:/2026-11-16/ab12cd34-x.png");
  });

  test("~ 等价于 /", async () => {
    expect((await b.locate("attachment", "~/x.png")).path).toBe(
      path.join(attachRoot, "x.png"),
    );
    expect((await b.locate("attachment", "~")).path).toBe(attachRoot);
  });

  test("相对路径与缺省 path 拒绝", async () => {
    await expect(b.locate("attachment", "p")).rejects.toThrow(
      "A relative path on the attachment host is not accepted. Write an absolute path: /p.",
    );
    await expect(b.locate("attachment", undefined)).rejects.toThrow(
      "The attachment host needs a path: write an absolute path such as /2026-11-16/ab12cd34-chart.png.",
    );
  });

  test("带目录名拒绝", async () => {
    await expect(b.locate("attachment:x", "/a")).rejects.toThrow(
      'The attachment host is not a directory. Address its files with host="attachment" and an absolute path, e.g. /2026-11-16/ab12cd34-chart.png.',
    );
  });

  test("越界（..）直接拒绝", async () => {
    await expect(b.locate("attachment", "/../x")).rejects.toThrow(
      "Paths on the attachment host must stay inside it: attachment:/../x.",
    );
  });

  test("附件区出现在主机清单最后，不是目录引用", () => {
    expect(b.hosts().map((h) => h.label)).toEqual(["local", "attachment"]);
    expect(b.labelOf(ATTACHMENT_ENV_ID)).toBe("attachment");
    expect(() => b.directory("attachment:x")).toThrow(
      "The attachment host is not a directory.",
    );
  });
});

describe("locate：协作区（虚拟主机 collab）", () => {
  const b = book({ directories: [PROJ, TRAIN, COLLAB, ATT], currentId: "d1" });

  test("以这棵树的根为 /，展示形式不暴露真实路径", async () => {
    const at = await b.locate("collab", "/c1/report.md");
    expect(at.env).toBe(collabEnv);
    expect(at.path).toBe(path.join(COLLAB_ROOT, "c1", "report.md"));
    expect(at.shown).toBe("collab:/c1/report.md");
    expect(at.directory.id).toBe("c1");
  });

  test("~ 等价于 /", async () => {
    expect((await b.locate("collab", "~/board.md")).path).toBe(
      path.join(COLLAB_ROOT, "board.md"),
    );
    expect((await b.locate("collab", "~")).path).toBe(COLLAB_ROOT);
  });

  test("相对路径、缺省 path 与越界（..）", async () => {
    await expect(b.locate("collab", "p.md")).rejects.toThrow(
      "A relative path on the collab host is not accepted. Write an absolute path: /p.md.",
    );
    await expect(b.locate("collab", undefined)).rejects.toThrow(
      "The collab host needs a path: write an absolute path such as /<id>/report.md.",
    );
    await expect(b.locate("collab", "/../x")).rejects.toThrow(
      "Paths on the collab host must stay inside it: collab:/../x.",
    );
  });

  test("带目录名拒绝，原文把主机名换成 collab", () => {
    expect(() => b.directory("collab:x")).toThrow(
      'The collab host is not a directory. Address its files with host="collab" and an absolute path, e.g. /<id>/report.md.',
    );
    return expect(b.locate("collab:x", "/a")).rejects.toThrow(
      "The collab host is not a directory.",
    );
  });

  test("两个虚拟主机都在最后，collab 在 attachment 之前；路径里带主机名的安全网也认得 collab", async () => {
    expect(b.hosts().map((h) => h.label)).toEqual([
      "local",
      "dev1",
      "collab",
      "attachment",
    ]);
    expect(b.labelOf(COLLAB_ENV_ID)).toBe("collab");
    await expect(b.locate(undefined, "collab:/board.md")).rejects.toThrow(
      'host="collab", path="/board.md"',
    );
  });

  test("主目录在 ssh 上、目录里没有本机目录：collab 照样可寻址", async () => {
    const remote = book({
      directories: [TRAIN, COLLAB],
      primaryEnvId: "e1",
      currentId: "d3",
    });
    const at = await remote.locate("collab", "/c1/report.md");
    expect(at.path).toBe(path.join(COLLAB_ROOT, "c1", "report.md"));
    expect(remote.hosts().map((h) => h.label)).toEqual(["local", "collab"]);
  });
});

describe("directory：<host>:<目录名>", () => {
  const b = book({ directories: [PROJ, DOCS, TRAIN], currentId: "d1" });

  test("按主机名（大小写不敏感）与目录名（精确）找", () => {
    expect(b.directory("dev1:train").id).toBe("d3");
    expect(b.directory("LOCAL:proj").id).toBe("d1");
    expect(b.directory("server:docs").id).toBe("d2");
    expect(b.refOf(TRAIN)).toBe("dev1:train");
  });

  test("没有冒号 / 未知主机 / 目录不存在：三条报错原文", () => {
    expect(() => b.directory("local")).toThrow(
      "A directory is written <host>:<name>, for example local:proj. Directories in this session: local:proj, local:docs, dev1:train.",
    );
    expect(() => b.directory("x:proj")).toThrow(
      'Unknown host "x". Hosts in this session: local, dev1.',
    );
    expect(() => b.directory("dev1:nope")).toThrow(
      'Directory "dev1:nope" not found. Directories in this session: local:proj, local:docs, dev1:train.',
    );
  });
});

describe("locate：安全网（路径里带已知主机名）", () => {
  const b = book({ directories: [PROJ, TRAIN], currentId: "d1" });

  test("host 写没写都拒绝，提示把主机放进 host", async () => {
    const why =
      'The path "dev1:/data/x" starts with a host name. Put the host in the host parameter: host="dev1", path="/data/x".';
    await expect(b.locate(undefined, "dev1:/data/x")).rejects.toThrow(why);
    await expect(b.locate("local:proj", "dev1:/data/x")).rejects.toThrow(why);
    await expect(b.locate("local", "dev1:/data/x")).rejects.toThrow(why);
  });

  test("大小写原样回显；server 与 attachment 也是已知主机名", async () => {
    await expect(b.locate(undefined, "DEV1:/x")).rejects.toThrow(
      'The path "DEV1:/x" starts with a host name. Put the host in the host parameter: host="DEV1", path="/x".',
    );
    await expect(b.locate(undefined, "server:/x")).rejects.toThrow(
      'host="server", path="/x"',
    );
    await expect(b.locate(undefined, "attachment:/x")).rejects.toThrow(
      'host="attachment", path="/x"',
    );
  });

  test("未知前缀当作普通文件名（相对当前目录）", async () => {
    expect((await b.locate(undefined, "dev9:/x")).path).toBe(
      "/home/me/proj/dev9:/x",
    );
    expect((await b.locate(undefined, "a:b.txt")).path).toBe(
      "/home/me/proj/a:b.txt",
    );
  });
});

describe("locate：当前目录所在的主机不可用", () => {
  const b = book({
    directories: [PROJ, TRAIN],
    currentId: "d3",
    envs: { e1: undefined },
  });

  test("别的主机照常可寻址，相对路径与空路径才报错", async () => {
    expect((await b.locate("local", "/etc/hosts")).path).toBe("/etc/hosts");
    expect((await b.locate("server", "/srv/x")).path).toBe("/srv/x");
    await expect(b.locate(undefined, "a.txt")).rejects.toThrow(
      'Host "dev1" is not available.',
    );
    await expect(b.locate(undefined, undefined)).rejects.toThrow(
      "is not available",
    );
  });
});

describe("locate：归属目录", () => {
  const nested = dir("d5", "nested", "/home/me/proj/src");
  const b = book({
    directories: [PROJ, DOCS, TRAIN, LOGS, nested],
    currentId: "d2",
  });

  test("取包含该路径的最深的一个", async () => {
    expect(
      (await b.locate(undefined, "/home/me/proj/src/a.ts")).directory.id,
    ).toBe("d5");
    expect((await b.locate(undefined, "/home/me/proj/a.ts")).directory.id).toBe(
      "d1",
    );
  });

  test("都不包含时取点名的目录 / 当前目录（同一主机），再没有取该主机的第一个", async () => {
    // 点名的目录优先于当前目录
    expect((await b.locate("local:docs", "/tmp/x")).directory.id).toBe("d2");
    expect((await b.locate("dev1:logs", "/etc/x")).directory.id).toBe("d4");
    // dev1 上都不包含时取该主机的第一个
    expect((await b.locate("dev1", "/etc/x")).directory.id).toBe("d3");
  });
});

describe("hostLabel：一份规则", () => {
  const name = (id: string) => (id === "e1" ? "dev1" : undefined);
  test("主目录所在主机叫 local，Server 物理机在主目录不占它时叫 server，其余取连接名", () => {
    expect(hostLabel("e1", { primaryEnvId: "e1", connectionName: name })).toBe(
      "local",
    );
    expect(
      hostLabel(LOCAL_ENV_ID, { primaryEnvId: "e1", connectionName: name }),
    ).toBe("server");
    expect(
      hostLabel(LOCAL_ENV_ID, {
        primaryEnvId: LOCAL_ENV_ID,
        connectionName: name,
      }),
    ).toBe("local");
    expect(
      hostLabel("e1", { primaryEnvId: LOCAL_ENV_ID, connectionName: name }),
    ).toBe("dev1");
    // 拿不到连接名就用环境 id
    expect(
      hostLabel("e9", { primaryEnvId: LOCAL_ENV_ID, connectionName: name }),
    ).toBe("e9");
    expect(
      hostLabel(ATTACHMENT_ENV_ID, {
        primaryEnvId: LOCAL_ENV_ID,
        connectionName: name,
      }),
    ).toBe("attachment");
  });
});
