// 「提示词与能力」接口：卡片库（只读/复制/引用保护）、预设、段列表（分组与条件）保存校验、按模型求值、AGENTS.md 预设写文件。
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { BASELINE_AGENT_ID, BASELINE_MODE_ID } from "../prompt/baseline.js";
import {
  ensureBuiltinAgents,
  PAGE_READER_CARD_ID,
  PAGE_READER_PRESET_ID,
} from "../prompt/builtin-agents.js";
import { addFixtureCards } from "../prompt/testkit.js";
import { GlobalAgentsMdFile } from "../session/agents-md-presets.js";
import { type Db, openDatabase } from "../store/db.js";
import { PromptCardStore } from "../store/prompt-cards.js";
import { PromptPresetStore } from "../store/prompt-presets.js";
import { SessionStore } from "../store/sessions.js";
import { studioApi } from "./studio.js";

let dir: string;
let ysHome: string;
let globalFile: string;
let db: Db;
let app: FastifyInstance;
let sessions: SessionStore;
const agentsFile = () => path.join(ysHome, "AGENTS.md");
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-studio-api-"));
  ysHome = path.join(dir, "ys");
  globalFile = agentsFile();
  db = openDatabase(dir);
  const cards = new PromptCardStore(db);
  const presets = new PromptPresetStore(db);
  addFixtureCards(cards);
  ensureBuiltinAgents({ cards, presets });
  app = Fastify();
  sessions = new SessionStore(db);
  app.register(studioApi, {
    cards,
    presets,
    file: new GlobalAgentsMdFile({ ysHome, db }),
    agentRefs: () => sessions.agentRefCounts(),
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const call = async (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: Record<string, unknown>,
) => {
  const res = await app.inject({
    method,
    url,
    ...(body === undefined ? {} : { payload: body }),
  });
  return { status: res.statusCode, json: () => res.json() };
};

const cardsOf = async () =>
  (await call("GET", "/api/v1/studio/cards")).json().groups as {
    group: string;
    cards: { id: string; builtin: boolean; title: string }[];
  }[];

test("卡片库按分组返回，内置卡片标记只读；内置分组排在最前", async () => {
  const groups = await cardsOf();
  expect(groups[0]?.group).toBe("默认行为构建");
  const pi = groups.find((g) => g.group === "默认行为构建");
  expect(pi?.cards.some((c) => c.id === "k-identity-pi" && c.builtin)).toBe(
    true,
  );
  expect(groups.some((g) => g.group === "测试")).toBe(true);
});

test("内置卡片不能改、不能删，但可以复制一份再改", async () => {
  const patch = await call("PATCH", "/api/v1/studio/cards/k-identity-pi", {
    body: "改写",
  });
  expect(patch.status).toBe(409);
  expect(patch.json().error).toBe("builtin_readonly");

  expect(
    (await call("DELETE", "/api/v1/studio/cards/k-identity-pi")).status,
  ).toBe(409);

  const copy = await call("POST", "/api/v1/studio/cards/k-identity-pi/copy");
  expect(copy.status).toBe(201);
  const copyId = copy.json().id as string;
  expect(copy.json().builtin).toBe(false);
  const edited = await call("PATCH", `/api/v1/studio/cards/${copyId}`, {
    body: "改了副本",
  });
  expect(edited.status).toBe(200);
  expect(edited.json().body).toBe("改了副本");
});

test("卡片库分组：能新建空分组、重名 409；有卡片的分组不能删，卡片移走后可删", async () => {
  const made = await call("POST", "/api/v1/studio/card-groups", {
    name: "团队约定",
  });
  expect(made.status).toBe(201);
  expect((await cardsOf()).find((g) => g.group === "团队约定")?.cards).toEqual(
    [],
  );
  // 重名：同一份空分组、已有卡片的分组都算
  expect(
    (await call("POST", "/api/v1/studio/card-groups", { name: "团队约定" }))
      .status,
  ).toBe(409);
  expect(
    (await call("POST", "/api/v1/studio/card-groups", { name: "测试" })).status,
  ).toBe(409);
  expect(
    (await call("POST", "/api/v1/studio/card-groups", { name: "  " })).status,
  ).toBe(400);

  // 往里放一张卡片：不能删
  const card = (
    await call("POST", "/api/v1/studio/cards", {
      title: "约定一",
      group: "团队约定",
      body: "x",
    })
  ).json() as { id: string };
  const blocked = await call(
    "DELETE",
    `/api/v1/studio/card-groups/${encodeURIComponent("团队约定")}`,
  );
  expect(blocked.status).toBe(409);
  expect(blocked.json().error).toBe("not_empty");
  expect((await cardsOf()).some((g) => g.group === "团队约定")).toBe(true);

  // 卡片移到别的分组后，空分组还在（是用户建的），可以删
  await call("PATCH", `/api/v1/studio/cards/${card.id}`, { group: "导出" });
  expect((await cardsOf()).find((g) => g.group === "团队约定")?.cards).toEqual(
    [],
  );
  expect(
    (
      await call(
        "DELETE",
        `/api/v1/studio/card-groups/${encodeURIComponent("团队约定")}`,
      )
    ).status,
  ).toBe(204);
  expect((await cardsOf()).some((g) => g.group === "团队约定")).toBe(false);
  // 再删一次、删从没建过的、删只靠卡片存在的内置分组：404 / 409
  expect(
    (await call("DELETE", "/api/v1/studio/card-groups/团队约定")).status,
  ).toBe(404);
  expect(
    (
      await call(
        "DELETE",
        `/api/v1/studio/card-groups/${encodeURIComponent("默认行为构建")}`,
      )
    ).status,
  ).toBe(409);
});

test("被预设引用的卡片不能删，先提示引用位置", async () => {
  // 自己建一份引用它的预设（内置预设引用的卡片自有 other 路径保护）
  const extra = (
    await call("POST", "/api/v1/studio/presets", {
      kind: "global-extra",
      name: "用 t-lang",
    })
  ).json().id as string;
  await putNodes(extra, [
    { ...NODE, items: [{ kind: "card", cardId: "t-lang" }] },
  ]);

  const r = await call("DELETE", "/api/v1/studio/cards/t-lang");
  expect(r.status).toBe(409);
  expect(r.json().error).toBe("in_use");
  expect(r.json().detail).toEqual([extra]);
});

test("预设列表按 kind 过滤；详情带各段的 items；按模型求值的结果可读", async () => {
  const list = await call("GET", "/api/v1/studio/presets?kind=agent");
  expect(list.status).toBe(200);
  const presets = list.json().presets as { id: string }[];
  expect(presets.length).toBeGreaterThan(0);

  // 用用户自己建的预设（内置的段由另一组测试看）
  const created = await call("POST", "/api/v1/studio/presets", {
    kind: "agent",
    name: "自己建的",
  });
  const id = created.json().id as string;
  await putNodes(id, [
    { ...NODE, items: [{ kind: "card", cardId: "t-lang" }] },
  ]);
  const detail = await call("GET", `/api/v1/studio/presets/${id}`);
  expect(detail.status).toBe(200);
  const nodes = detail.json().preset.nodes as {
    items: { kind: string }[];
  }[];
  expect(nodes[0]?.items.length).toBeGreaterThan(0);

  const render = await call("GET", `/api/v1/studio/presets/${id}/render`);
  expect(render.status).toBe(200);
  expect(render.json().preamble.length).toBeGreaterThan(0);
});

test("卡片库带 usedBy：有几份预设在用", async () => {
  const groups = (await call("GET", "/api/v1/studio/cards")).json().groups as {
    cards: { id: string; usedBy: number }[];
  }[];
  const all = groups.flatMap((g) => g.cards);
  expect(all.find((c) => c.id === "k-tools")?.usedBy).toBe(1);
  expect(all.find((c) => c.id === "k-mode-plan")?.usedBy).toBe(1);
  expect(all.find((c) => c.id === "t-lang")?.usedBy).toBe(0);
});

const NODE = {
  id: "n1",
  tag: null,
  title: "正文",
  slotKind: "custom",
  channel: "system",
  builtin: false,
};
const putNodes = (id: string, nodes: unknown) =>
  call("PUT", `/api/v1/studio/presets/${id}/nodes`, { nodes } as never);

test("保存段列表：分组与条件原样落库，按模型求值的结果跟着变", async () => {
  const created = await call("POST", "/api/v1/studio/presets", {
    kind: "global-extra",
    name: "按模型",
  });
  const id = created.json().id as string;
  const when = { kind: "model", providers: ["local"], models: [] };
  const ok = await putNodes(id, [
    {
      ...NODE,
      items: [
        { kind: "card", cardId: "t-lang" },
        {
          kind: "group",
          id: "g1",
          name: "按模型",
          cards: [
            { cardId: "t-style", when },
            { cardId: "t-deps", when: null },
          ],
        },
      ],
    },
  ]);
  expect(ok.status).toBe(200);
  const saved = (await call("GET", `/api/v1/studio/presets/${id}`)).json()
    .preset.nodes[0].items[1];
  expect(saved.cards[0].when).toEqual(when);

  const local = await call(
    "GET",
    `/api/v1/studio/presets/${id}/render?model=local/qwen`,
  );
  expect(local.json().preamble).toContain("匹配现有风格");
  expect(local.json().preamble).not.toContain("uv");
  const other = await call(
    "GET",
    `/api/v1/studio/presets/${id}/render?model=cloud/x`,
  );
  expect(other.json().preamble).toContain("uv");
  expect(other.json().preamble).not.toContain("匹配现有风格");
});

test("保存段列表：引用不存在的卡片、同卡重复、坏条件、坏段名、user 段次序都被拒", async () => {
  const id = (
    await call("POST", "/api/v1/studio/presets", { kind: "agent", name: "x" })
  ).json().id as string;
  const rejected = async (nodes: unknown, detail: string) => {
    const r = await putNodes(id, nodes);
    expect(r.status).toBe(400);
    expect(r.json().error).toBe("invalid_nodes");
    expect(r.json().detail).toContain(detail);
  };
  await rejected(
    [{ ...NODE, items: [{ kind: "card", cardId: "ghost" }] }],
    "不存在的卡片",
  );
  await rejected(
    [
      {
        ...NODE,
        items: [
          { kind: "card", cardId: "t-lang" },
          {
            kind: "group",
            id: "g",
            name: "g",
            cards: [{ cardId: "t-lang", when: null }],
          },
        ],
      },
    ],
    "只能出现一次",
  );
  await rejected(
    [
      {
        ...NODE,
        items: [
          {
            kind: "group",
            id: "g",
            name: "g",
            cards: [{ cardId: "t-lang", when: { kind: "js", code: "1" } }],
          },
        ],
      },
    ],
    "非法条件",
  );
  await rejected([{ ...NODE, tag: "Bad Tag", items: [] }], "小写字母");
  await rejected(
    [
      { ...NODE, items: [] },
      { ...NODE, id: "n2", tag: "a", items: [] },
      { ...NODE, id: "n3", tag: "a", items: [] },
    ],
    "段名重复",
  );
  await rejected(
    [
      { ...NODE, items: [] },
      { ...NODE, id: "n2", tag: "late", channel: "user", items: [] },
      { ...NODE, id: "n3", tag: "x", items: [] },
    ],
    "user 段必须排在所有 system 之后",
  );
});

test("复制预设：段与分组一起复制，段 id 换成新预设的", async () => {
  const src = (await call("GET", "/api/v1/studio/presets?kind=agent")).json()
    .presets[0] as { id: string; name: string };
  // 内置预设（coder-full）也能复制
  expect(src.id).toBe(BASELINE_AGENT_ID);
  const copy = await call("POST", `/api/v1/studio/presets/${src.id}/copy`);
  expect(copy.status).toBe(201);
  expect(copy.json().name).toBe(`${src.name}（副本）`);
  const a = (await call("GET", `/api/v1/studio/presets/${src.id}`)).json()
    .preset;
  const b = (
    await call("GET", `/api/v1/studio/presets/${copy.json().id}`)
  ).json().preset;
  expect(b.nodes).toHaveLength(a.nodes.length);
  expect(b.nodes[0].items).toEqual(a.nodes[0].items);
  expect(b.nodes[0].id).not.toBe(a.nodes[0].id);
});

test("激活预设：附加提示词只有一张生效", async () => {
  // 内置预设不带附加提示词，这里建两张
  for (const name of ["第一份", "第二份"])
    await call("POST", "/api/v1/studio/presets", {
      kind: "global-extra",
      name,
    });
  const list = (
    await call("GET", "/api/v1/studio/presets?kind=global-extra")
  ).json().presets as { id: string; active: boolean }[];
  expect(list.length).toBe(2);
  for (const p of list) {
    await call("POST", `/api/v1/studio/presets/${p.id}/activate`);
    const after = (
      await call("GET", "/api/v1/studio/presets?kind=global-extra")
    ).json().presets as { id: string; active: boolean }[];
    expect(after.filter((x) => x.active).map((x) => x.id)).toEqual([p.id]);
  }
});

test("预设自带默认能力，可读取与更新；预设不带权限（权限跟着环境走）", async () => {
  const presets = (
    await call("GET", "/api/v1/studio/presets?kind=agent")
  ).json().presets as { id: string; capabilities: unknown }[];
  // 默认 agent 是内置的 coder-full
  expect(presets[0]?.id).toBe(BASELINE_AGENT_ID);
  // 能力可读写的是用户自己建的预设（内置的不让改）
  const made = await call("POST", "/api/v1/studio/presets", {
    kind: "agent",
    name: "自定义能力",
  });
  const id = made.json().id as string;
  expect(made.json().capabilities).toBeNull();
  expect(made.json()).not.toHaveProperty("permissionTier");

  const r = await call("PATCH", `/api/v1/studio/presets/${id}`, {
    capabilities: ["tool:read", "skill:harness"],
  });
  expect(r.status).toBe(200);
  expect(r.json().capabilities).toEqual(["tool:read", "skill:harness"]);
  expect(r.json()).not.toHaveProperty("permissionTier");

  const badCaps = await call("PATCH", `/api/v1/studio/presets/${id}`, {
    capabilities: "tool:read",
  });
  expect(badCaps.status).toBe(400);
});

test("Agent 定义被会话引用（含已归档）时不能删，列表带引用数；会话删掉后可删（E4）", async () => {
  const created = await call("POST", "/api/v1/studio/presets", {
    kind: "agent",
    name: "referenced",
  });
  const id = created.json().id as string;
  const row = (sid: string) => ({
    id: sid,
    name: sid,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    promptPresetId: id,
  });
  sessions.upsert(row("s1"));
  sessions.upsert(row("s2"));
  sessions.setLifecycle("s2", "archived");

  const listed = (await call("GET", "/api/v1/studio/presets?kind=agent")).json()
    .presets as { id: string; refCount?: number }[];
  expect(listed.find((p) => p.id === id)?.refCount).toBe(2);

  const refused = await call("DELETE", `/api/v1/studio/presets/${id}`);
  expect(refused.status).toBe(409);
  expect(refused.json()).toEqual({ error: "agent_in_use", count: 2 });

  sessions.remove("s1");
  sessions.remove("s2");
  expect((await call("DELETE", `/api/v1/studio/presets/${id}`)).status).toBe(
    204,
  );
});

// ---- AGENTS.md 的两种预设：一段、无分组，全局那份激活时写文件 ----

// 段 id 全局唯一：每份预设用自己的前缀
const nodeOf = (presetId: string, items: unknown, id = "n1") => ({
  ...NODE,
  id: `${presetId}-${id}`,
  items,
});

const agentsPreset = async (
  kind: "global-agentsmd" | "project-agentsmd",
  cardId = "t-lang",
) => {
  const created = await call("POST", "/api/v1/studio/presets", {
    kind,
    name: kind,
  });
  const id = created.json().id as string;
  const put = await putNodes(id, [nodeOf(id, [{ kind: "card", cardId }])]);
  expect(put.status).toBe(200);
  return id as string;
};

const activeIds = async (kind: string) =>
  (
    (await call("GET", `/api/v1/studio/presets?kind=${kind}`)).json()
      .presets as { id: string; active: boolean }[]
  )
    .filter((p) => p.active)
    .map((p) => p.id);

const manualFile = (text: string) => {
  mkdirSync(ysHome, { recursive: true });
  writeFileSync(globalFile, text);
};

test("激活全局 AGENTS.md 版本：同 kind 互斥，文件里是拼出来的正文", async () => {
  const a = await agentsPreset("global-agentsmd", "t-lang");
  const b = await agentsPreset("global-agentsmd", "t-style");
  expect(
    (await call("POST", `/api/v1/studio/presets/${a}/activate`)).status,
  ).toBe(200);
  expect(await activeIds("global-agentsmd")).toEqual([a]);
  expect(readFileSync(globalFile, "utf8").length).toBeGreaterThan(0);

  expect(
    (await call("POST", `/api/v1/studio/presets/${b}/activate`)).status,
  ).toBe(200);
  expect(await activeIds("global-agentsmd")).toEqual([b]);
  const rendered = (
    await call("GET", `/api/v1/studio/presets/${b}/render`)
  ).json();
  expect(readFileSync(globalFile, "utf8")).toBe(`${rendered.preamble}\n`);
});

test("激活全局 AGENTS.md 版本：磁盘被人改过 409，文件与生效状态都不变", async () => {
  const id = await agentsPreset("global-agentsmd", "t-lang");
  const other = await agentsPreset("global-agentsmd", "t-style");
  await call("POST", `/api/v1/studio/presets/${id}/activate`);
  const written = readFileSync(globalFile, "utf8");
  manualFile("我自己改的约定\n");

  const refused = await call(
    "POST",
    `/api/v1/studio/presets/${other}/activate`,
  );
  expect(refused.status).toBe(409);
  expect(refused.json()).toEqual({ error: "disk_modified" });
  expect(readFileSync(globalFile, "utf8")).toBe("我自己改的约定\n");
  expect(await activeIds("global-agentsmd")).toEqual([id]);

  const forced = await call(
    "POST",
    `/api/v1/studio/presets/${other}/activate`,
    {
      overwrite: true,
    },
  );
  expect(forced.status).toBe(200);
  const rendered = (
    await call("GET", `/api/v1/studio/presets/${other}/render`)
  ).json();
  expect(readFileSync(globalFile, "utf8")).toBe(`${rendered.preamble}\n`);
  expect(written.length).toBeGreaterThan(0);
  expect(await activeIds("global-agentsmd")).toEqual([other]);
});

test("生效版本上保存段：重写文件；手改时 409 且库里内容没变", async () => {
  const id = await agentsPreset("global-agentsmd", "t-lang");
  await call("POST", `/api/v1/studio/presets/${id}/activate`);
  const next = [nodeOf(id, [{ kind: "card", cardId: "t-deps" }])];
  const saved = await call(
    "PUT",
    `/api/v1/studio/presets/${id}/nodes?overwrite=1`,
    { nodes: next },
  );
  expect(saved.status).toBe(200);
  const rendered = (
    await call("GET", `/api/v1/studio/presets/${id}/render`)
  ).json();
  expect(readFileSync(globalFile, "utf8")).toBe(`${rendered.preamble}\n`);

  manualFile("我自己改的约定\n");
  const refused = await putNodes(id, [
    nodeOf(id, [{ kind: "card", cardId: "t-style" }]),
  ]);
  expect(refused.status).toBe(409);
  expect(refused.json()).toEqual({ error: "disk_modified" });
  // 库里的段还是上一次保存的内容，文件也没被覆盖
  const detail = (await call("GET", `/api/v1/studio/presets/${id}`)).json();
  expect(detail.preset.nodes[0].items).toEqual([
    { kind: "card", cardId: "t-deps" },
  ]);
  expect(readFileSync(globalFile, "utf8")).toBe("我自己改的约定\n");

  // 带上 overwrite=1 才保存并覆盖文件
  const forced = await call(
    "PUT",
    `/api/v1/studio/presets/${id}/nodes?overwrite=1`,
    { nodes: [nodeOf(id, [{ kind: "card", cardId: "t-style" }])] },
  );
  expect(forced.status).toBe(200);
  const rewritten = (
    await call("GET", `/api/v1/studio/presets/${id}/render`)
  ).json();
  expect(readFileSync(globalFile, "utf8")).toBe(`${rewritten.preamble}\n`);
});

test("非生效版本保存段不碰文件；删除生效版本 409 active", async () => {
  const active = await agentsPreset("global-agentsmd", "t-lang");
  const other = await agentsPreset("global-agentsmd", "t-style");
  await call("POST", `/api/v1/studio/presets/${active}/activate`);
  const before = readFileSync(globalFile, "utf8");
  manualFile("我自己改的约定\n");
  const saved = await putNodes(other, [
    nodeOf(other, [{ kind: "card", cardId: "t-deps" }]),
  ]);
  expect(saved.status).toBe(200);
  expect(readFileSync(globalFile, "utf8")).toBe("我自己改的约定\n");

  manualFile(before);
  const refused = await call("DELETE", `/api/v1/studio/presets/${active}`);
  expect(refused.status).toBe(409);
  expect(refused.json()).toEqual({ error: "active" });
  // 激活别的之后就能删
  await call("POST", `/api/v1/studio/presets/${other}/activate`, {
    overwrite: true,
  });
  expect(
    (await call("DELETE", `/api/v1/studio/presets/${active}`)).status,
  ).toBe(204);
});

test("项目 AGENTS.md 版本不能激活；复制出的全局版本不带生效标记", async () => {
  const project = await agentsPreset("project-agentsmd");
  const refused = await call(
    "POST",
    `/api/v1/studio/presets/${project}/activate`,
  );
  expect(refused.status).toBe(400);
  expect(refused.json()).toEqual({ error: "not_activatable" });

  const global = await agentsPreset("global-agentsmd");
  await call("POST", `/api/v1/studio/presets/${global}/activate`);
  const copy = await call("POST", `/api/v1/studio/presets/${global}/copy`);
  expect(copy.status).toBe(201);
  expect(copy.json().active).toBe(false);
  expect(await activeIds("global-agentsmd")).toEqual([global]);
});

test("AGENTS.md 预设的段校验：两段被拒，分组被拒", async () => {
  const id = await agentsPreset("global-agentsmd");
  const two = await putNodes(id, [nodeOf(id, []), nodeOf(id, [], "n2")]);
  expect(two.status).toBe(400);
  expect(two.json().detail).toContain("只能有一段");

  const grouped = await putNodes(id, [
    nodeOf(id, [
      {
        kind: "group",
        id: "g",
        name: "g",
        cards: [{ cardId: "t-lang", when: null }],
      },
    ]),
  ]);
  expect(grouped.status).toBe(400);
  expect(grouped.json().detail).toContain("不能有分组");

  const tagged = await putNodes(id, [{ ...nodeOf(id, []), tag: "x" }]);
  expect(tagged.status).toBe(400);

  // 其他 kind 仍然可以有分组
  const extra = (
    await call("POST", "/api/v1/studio/presets", {
      kind: "global-extra",
      name: "分组照旧",
    })
  ).json().id as string;
  const ok = await putNodes(extra, [
    nodeOf(extra, [
      {
        kind: "group",
        id: "g",
        name: "g",
        cards: [{ cardId: "t-lang", when: null }],
      },
    ]),
  ]);
  expect(ok.status).toBe(200);
});

// ---- 内置预设：可看、可选用、可复制，但一切写操作都拒绝 ----

test("预设视图带 builtin；内置预设与内置卡片都在列表里", async () => {
  const presets = (
    await call("GET", "/api/v1/studio/presets?kind=agent")
  ).json().presets as { id: string; name: string; builtin: boolean }[];
  const reader = presets.find((p) => p.id === PAGE_READER_PRESET_ID);
  expect(reader?.builtin).toBe(true);
  expect(reader?.name).toBe("page-reader");
  // 内置预设：coder-full 与 page-reader 两张 agent，plan 一张模式
  expect(presets.map((p) => p.id)).toEqual([
    BASELINE_AGENT_ID,
    PAGE_READER_PRESET_ID,
  ]);
  expect(presets.filter((p) => p.builtin)).toHaveLength(2);
  const modes = (await call("GET", "/api/v1/studio/presets?kind=mode")).json()
    .presets as { id: string; builtin: boolean }[];
  expect(modes).toHaveLength(1);
  expect(modes[0]?.id).toBe(BASELINE_MODE_ID);
  expect(modes[0]?.builtin).toBe(true);

  const detail = (
    await call("GET", `/api/v1/studio/presets/${PAGE_READER_PRESET_ID}`)
  ).json().preset;
  expect(detail.builtin).toBe(true);
  expect(detail.nodes).toHaveLength(1);

  const groups = (await call("GET", "/api/v1/studio/cards")).json().groups as {
    group: string;
    cards: { id: string; builtin: boolean }[];
  }[];
  expect(
    groups
      .flatMap((g) => g.cards)
      .some((c) => c.id === PAGE_READER_CARD_ID && c.builtin),
  ).toBe(true);
});

test("内置预设的一切写操作都拒绝：改名改描述、改能力、替换段、激活、删除", async () => {
  const refused = async (
    method: "PATCH" | "POST" | "PUT" | "DELETE",
    url: string,
    body?: Record<string, unknown>,
  ) => {
    const r = await call(method, url, body);
    expect(r.status).toBe(409);
    expect(r.json()).toEqual({
      error: "builtin",
      message: "内置预设不可修改",
    });
  };
  const nodes = [
    {
      id: "a-x",
      tag: null,
      title: "角色定义",
      slotKind: "custom",
      channel: "system",
      builtin: false,
      items: [],
    },
  ];
  for (const id of [
    PAGE_READER_PRESET_ID,
    BASELINE_AGENT_ID,
    BASELINE_MODE_ID,
  ]) {
    const path = `/api/v1/studio/presets/${id}`;
    await refused("PATCH", path, { name: "另起一个名字" });
    await refused("PATCH", path, { description: "改描述" });
    await refused("PATCH", path, { capabilities: ["tool:read"] });
    await refused("POST", `${path}/activate`);
    await refused("PUT", `${path}/nodes`, { nodes });
    await refused("DELETE", path);
  }

  // 库里内容没被上面任何一次改动
  const after = (
    await call("GET", `/api/v1/studio/presets/${PAGE_READER_PRESET_ID}`)
  ).json().preset;
  expect(after.name).toBe("page-reader");
  expect(after.capabilities).toEqual(["tool:read", "tool:grep"]);
  expect(after.active).toBe(false);
  expect(after.nodes).toHaveLength(1);
  const coder = (
    await call("GET", `/api/v1/studio/presets/${BASELINE_AGENT_ID}`)
  ).json().preset;
  expect(coder.name).toBe("coder-full");
  expect(coder.nodes).toHaveLength(5);
  const plan = (
    await call("GET", `/api/v1/studio/presets/${BASELINE_MODE_ID}`)
  ).json().preset;
  expect(plan.name).toBe("plan");
  expect(plan.nodes).toHaveLength(1);
});

test("内置预设可以复制一份再改，副本不受保护", async () => {
  for (const [id, name] of [
    [PAGE_READER_PRESET_ID, "我自己的阅读 agent"],
    [BASELINE_AGENT_ID, "我自己的编码 agent"],
  ] as const) {
    const copy = await call("POST", `/api/v1/studio/presets/${id}/copy`);
    expect(copy.status).toBe(201);
    expect(copy.json().builtin).toBe(false);
    const edited = await call(
      "PATCH",
      `/api/v1/studio/presets/${copy.json().id}`,
      {
        name,
      },
    );
    expect(edited.status).toBe(200);
    expect(edited.json().name).toBe(name);
  }
});
