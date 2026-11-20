import { expect, test } from "vitest";
import {
  ATTACHMENT_HOST_LINE,
  COLLAB_HOST_LINE,
  type DirectoryView,
  directoriesChangedNotice,
  directoryExtension,
  switchNotice,
} from "./directory-tools.js";

const view = (
  over: Partial<DirectoryView> & { name: string },
): DirectoryView => ({
  id: `id-${over.name}`,
  path: `/srv/${over.name}`,
  ref: `local:${over.name}`,
  host: "local",
  state: "ready",
  current: false,
  hostId: "local",
  role: "remote",
  ...over,
});

function tools(api: Parameters<typeof directoryExtension>[0]) {
  const registered = new Map<
    string,
    {
      name: string;
      description?: string;
      parameters?: { properties?: Record<string, { description?: string }> };
      executionMode?: string;
      execute: (
        id: string,
        p: unknown,
      ) => Promise<{
        content: { text: string }[];
        isError?: boolean;
      }>;
    }
  >();
  directoryExtension(api)({
    registerTool: (t: { name: string }) => registered.set(t.name, t as never),
    on: () => {},
  } as never);
  return registered;
}

const views = () => [
  view({ name: "proj", ref: "local:proj", current: true }),
  view({ name: "docs", ref: "local:docs" }),
  view({
    name: "train",
    ref: "dev1:train",
    host: "dev1",
    hostId: "e1",
    state: "connected",
  }),
];

test("switch_directory 声明为顺序执行，list_directories 不限", () => {
  const t = tools({
    list: () => [],
    switchTo: () => {
      throw new Error("unused");
    },
    takeNotice: () => null,
  });
  expect(t.get("switch_directory")?.executionMode).toBe("sequential");
  expect(t.get("list_directories")?.executionMode).toBeUndefined();
});

test("子会话（switchTo 缺省）只有 list_directories", () => {
  const t = tools({ list: () => [], takeNotice: () => null });
  expect([...t.keys()]).toEqual(["list_directories"]);
});

test("list_directories：按主机分组，目录写成 <host>:<name>、没有 id，当前目录前标 *，两个虚拟主机各单列一行", async () => {
  const t = tools({
    list: () => [
      ...views(),
      view({
        name: "attachment",
        ref: "attachment:attachment",
        host: "attachment",
        hostId: "attachment",
      }),
      view({
        name: "collab",
        ref: "collab:collab",
        host: "collab",
        hostId: "collab",
      }),
    ],
    switchTo: () => {
      throw new Error("unused");
    },
    takeNotice: () => null,
  });
  const r = await t.get("list_directories")?.execute("t1", {});
  expect(r?.content[0]?.text).toBe(
    [
      "Hosts and directories. A directory is written <host>:<name>. Relative paths and bash use the current directory (marked *); the host parameter of a tool names another host or directory.",
      "- local: ready",
      "  * local:proj  /srv/proj",
      "    local:docs  /srv/docs",
      "- dev1: connected",
      "    dev1:train  /srv/train",
      // 顺序跟目录清单：附件区在前，协作区在它之后
      `- ${ATTACHMENT_HOST_LINE}`,
      `- ${COLLAB_HOST_LINE}`,
    ].join("\n"),
  );
  expect(r?.content[0]?.text).not.toContain("id:");
});

test("switch_directory 的原样文字：结果与通知都写引用，不说绝对路径仍要带主机", async () => {
  const t = tools({
    list: views,
    switchTo: (ref) => {
      const hit = views().find((v) => v.ref === ref);
      if (!hit) throw new Error(`Directory "${ref}" not found.`);
      return { ...hit, current: true };
    },
    takeNotice: () => null,
  });
  const r = await t.get("switch_directory")?.execute("t1", {
    directory: "dev1:train",
  });
  expect(r?.content[0]?.text).toBe(
    "Switched to dev1:train (/srv/train). Relative paths and bash run there from now on, on host dev1.",
  );
  expect(
    switchNotice(view({ name: "train", ref: "dev1:train", host: "dev1" })),
  ).toBe(
    "[System notice] The current directory is now dev1:train (/srv/train, host dev1). Relative paths and bash run there from now on; the host parameter can still name any host.",
  );
});

test("switch_directory 只把参数原样交给池：裸名字与 id 由地址簿拒绝入参", async () => {
  const asked: string[] = [];
  const t = tools({
    list: views,
    switchTo: (ref) => {
      asked.push(ref);
      throw new Error(
        "A directory is written <host>:<name>, for example local:proj.",
      );
    },
    takeNotice: () => null,
  });
  await expect(
    t.get("switch_directory")?.execute("t1", { directory: "docs" }),
  ).rejects.toThrow("A directory is written <host>:<name>");
  expect(asked).toEqual(["docs"]);
});

test("directoriesChangedNotice：新增与移除都用引用写法；所在的被移除时说明已退回主目录", () => {
  const local = view({ name: "proj", ref: "local:proj", current: true });
  const added = view({ name: "train", ref: "dev1:train", host: "dev1" });
  const stay = directoriesChangedNotice({
    added: [added, view({ name: "docs", ref: "local:docs" })],
    removed: ["dev1:old"],
    current: local,
    movedToLocal: false,
  });
  expect(stay).toContain(
    "Added: dev1:train (/srv/train), local:docs (/srv/docs)",
  );
  expect(stay).toContain("Removed: dev1:old");
  expect(stay).toContain("The current directory is still local:proj.");
  expect(stay).not.toContain("has been removed");
  // 完整清单在环境信息段里，通知里不再重复
  expect(stay).not.toContain("Hosts and directories");
});

test("directoriesChangedNotice：所在的目录被移除时说明回到主目录", () => {
  const local = view({ name: "proj", ref: "local:proj", current: true });
  const moved = directoriesChangedNotice({
    added: [],
    removed: ["dev1:train"],
    current: local,
    movedToLocal: true,
  });
  expect(moved).toContain(
    "The directory you were in has been removed; you are back in local:proj (/srv/proj), and relative paths and bash run there from now on.",
  );
});

test("工具说明原文：目录写 <host>:<name>，附件区不是目录，切换只管相对路径与 bash", () => {
  const t = tools({
    list: () => [],
    switchTo: () => {
      throw new Error("unused");
    },
    takeNotice: () => null,
  });
  expect(t.get("list_directories")?.description).toContain(
    "A directory is written <host>:<name>: that is what switch_directory, spawn_subagent and the host parameter of the file tools and bash accept.",
  );
  expect(t.get("list_directories")?.description).toContain(
    "the attachment host is read-only and holds the files the user uploaded and tools saved.",
  );
  expect(t.get("switch_directory")?.description).toContain(
    "Switch the current directory to another registered directory, written <host>:<name> (see list_directories), possibly on another host.",
  );
  expect(t.get("switch_directory")?.description).toContain(
    "You can only switch to registered directories; the attachment host is not a directory.",
  );
  expect(
    t.get("switch_directory")?.parameters?.properties?.directory?.description,
  ).toBe("Directory written <host>:<name>, e.g. dev1:train");
  // 旧说法不再出现
  for (const d of [
    t.get("list_directories")?.description ?? "",
    t.get("switch_directory")?.description ?? "",
  ]) {
    expect(d).not.toContain("Name or id");
    expect(d).not.toContain("attachment:/");
  }
});
