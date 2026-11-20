// 「提示词与能力」接口：卡片库、预设、预设的段列表（含分组与条件）、工具描述覆盖。
import type { FastifyInstance, FastifyReply } from "fastify";
import { isObject, str } from "../lib/validate.js";
import { isBuiltinPreset } from "../prompt/builtin-agents.js";
import { composePreset, presetCardIds } from "../prompt/compose.js";
import type { ModelRef } from "../prompt/items.js";
import type { GlobalAgentsMdFile } from "../session/agents-md-presets.js";
import { renderAgentsMd } from "../session/agents-md-presets.js";
import type { PromptCardStore } from "../store/prompt-cards.js";
import {
  CARD_BODY_MAX,
  CARD_GROUP_MAX,
  CARD_TITLE_MAX,
} from "../store/prompt-cards.js";
import type { PresetKind, PromptPresetStore } from "../store/prompt-presets.js";
import { PRESET_KINDS } from "../store/prompt-presets.js";
import type { ToolDescriptionStore } from "../store/tool-descriptions.js";
import { parseNodes } from "./studio-nodes.js";

const bad = (reply: FastifyReply, error = "bad_request", detail?: string) =>
  reply.code(400).send(detail ? { error, detail } : { error });

/** 预设视图带上「是不是内置」：内置的那些界面只给看与选用 */
const withBuiltin = <T extends { id: string }>(
  p: T,
): T & { builtin: boolean } => ({ ...p, builtin: isBuiltinPreset(p.id) });

/** 内置预设的一切写操作都拒绝：409 builtin（复制一份再改走 copy 那条路） */
const builtin = (reply: FastifyReply) =>
  reply.code(409).send({ error: "builtin", message: "内置预设不可修改" });

/** 能力 id 列表（tool:/mcp: 前缀）：没给 → undefined；不是字符串数组 → "bad"。 */
const idList = (v: unknown): string[] | undefined | "bad" => {
  if (v === undefined) return undefined;
  return Array.isArray(v) &&
    v.every((x) => typeof x === "string" && x.length < 200)
    ? (v as string[])
    : "bad";
};

/** 查询 / 请求里的模型写成 "供应商id/模型id"，只在第一个斜杠处切开 */
const parseModelRef = (v: unknown): ModelRef | null => {
  if (typeof v !== "string") return null;
  const i = v.indexOf("/");
  return i > 0 && i < v.length - 1
    ? { provider: v.slice(0, i), model: v.slice(i + 1) }
    : null;
};

/** 新预设自带的第一段：没有任何段的预设无从下手 */
const ROOT_TITLE: Record<PresetKind, string> = {
  agent: "角色定义",
  mode: "模式提示词",
  "global-extra": "附加提示词正文",
  "global-agentsmd": "正文",
  "project-agentsmd": "正文",
};

/** 这两种预设拼出来是固定文本：不能有分组与条件（prompt.md S2′） */
const isAgentsMd = (kind: PresetKind): boolean =>
  kind === "global-agentsmd" || kind === "project-agentsmd";

export async function studioApi(
  app: FastifyInstance,
  opts: {
    cards: PromptCardStore;
    presets: PromptPresetStore;
    tools?: ToolDescriptionStore;
    // 全局 AGENTS.md 文件：激活 / 保存生效版本时要写它，删生效版本要拦
    file: GlobalAgentsMdFile;
    // 每个 Agent 定义被多少会话引用（含已归档）；被引用时不能删（E4）
    agentRefs: () => Map<string, number>;
    // 分组条件的输入缺省值：请求没带模型时按全局默认求值
    defaultModel?: () => ModelRef | null;
  },
): Promise<void> {
  const { cards, presets, tools, agentRefs, file } = opts;
  const defaultModel = opts.defaultModel ?? (() => null);

  /** 这份预设拼出来的 AGENTS.md 正文 */
  const renderMd = (id: string): string => {
    const detail = presets.detail(id);
    if (!detail) return "";
    return renderAgentsMd(detail, cards.getMany(presetCardIds(detail)));
  };

  // ---- 卡片库 ----

  app.get("/api/v1/studio/cards", async () => {
    const usage = presets.cardUsage();
    return {
      groups: cards.grouped().map((g) => ({
        group: g.group,
        // usedBy：有几份预设在用这张卡片
        cards: g.cards.map((c) => ({
          ...c,
          usedBy: usage.get(c.id)?.length ?? 0,
        })),
      })),
    };
  });

  app.post("/api/v1/studio/cards", async (req, reply) => {
    const b = req.body;
    if (!isObject(b)) return bad(reply);
    const title = str(b.title, CARD_TITLE_MAX);
    const group = str(b.group, 50);
    if (!title || !group) return bad(reply);
    if (typeof b.body !== "string" || b.body.length > CARD_BODY_MAX)
      return bad(reply);
    return reply
      .code(201)
      .send(cards.create({ title, group, body: b.body, origin: "user" }));
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/studio/cards/:id",
    async (req, reply) => {
      const b = req.body;
      if (!isObject(b)) return bad(reply);
      const cur = cards.get(req.params.id);
      if (!cur) return reply.code(404).send({ error: "not_found" });
      if (cur.builtin)
        return reply.code(409).send({
          error: "builtin_readonly",
          detail: "内置卡片只读，请先复制一份",
        });
      if (b.body !== undefined && typeof b.body !== "string") return bad(reply);
      const next = cards.update(req.params.id, {
        ...(typeof b.title === "string"
          ? { title: str(b.title, CARD_TITLE_MAX) ?? cur.title }
          : {}),
        ...(typeof b.group === "string"
          ? { group: str(b.group, 50) ?? cur.group }
          : {}),
        ...(typeof b.body === "string" ? { body: b.body } : {}),
      });
      if (!next) return reply.code(409).send({ error: "builtin_readonly" });
      return next;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/studio/cards/:id/copy",
    async (req, reply) => {
      const made = cards.copy(req.params.id);
      if (!made) return reply.code(404).send({ error: "not_found" });
      return reply.code(201).send(made);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/studio/cards/:id",
    async (req, reply) => {
      const cur = cards.get(req.params.id);
      if (!cur) return reply.code(404).send({ error: "not_found" });
      if (cur.builtin)
        return reply.code(409).send({ error: "builtin_readonly" });
      const refs = presets.cardUsage().get(req.params.id) ?? [];
      if (refs.length > 0)
        return reply
          .code(409)
          .send({ error: "in_use", detail: refs, count: refs.length });
      cards.remove(req.params.id);
      return reply.code(204).send();
    },
  );

  /** 新建一个空分组 */
  app.post("/api/v1/studio/card-groups", async (req, reply) => {
    const b = req.body;
    const name = isObject(b) ? str(b.name, CARD_GROUP_MAX) : null;
    if (!name) return bad(reply);
    if (!cards.addGroup(name)) return reply.code(409).send({ error: "exists" });
    return reply.code(201).send({ group: name });
  });

  /** 删分组：只有空分组能删（卡片先移走或删掉） */
  app.delete<{ Params: { name: string } }>(
    "/api/v1/studio/card-groups/:name",
    async (req, reply) => {
      const r = cards.removeGroup(req.params.name);
      if (r === "not_found")
        return reply.code(404).send({ error: "not_found" });
      if (r === "not_empty")
        return reply.code(409).send({ error: "not_empty" });
      return reply.code(204).send();
    },
  );

  /** 重排分组内卡片顺序（拖拽后调用） */
  app.put("/api/v1/studio/cards/order", async (req, reply) => {
    const b = req.body;
    if (!isObject(b) || typeof b.group !== "string" || !Array.isArray(b.ids))
      return bad(reply);
    const ids = b.ids.filter((x): x is string => typeof x === "string");
    const known = new Set(
      cards
        .list()
        .filter((c) => c.group === b.group)
        .map((c) => c.id),
    );
    if (ids.some((id) => !known.has(id))) return bad(reply, "unknown_card");
    cards.reorder(b.group, ids);
    return { ok: true };
  });

  // ---- 预设 ----

  app.get<{ Querystring: { kind?: string } }>(
    "/api/v1/studio/presets",
    async (req) => {
      const refs = agentRefs();
      return {
        // Agent 带 refCount：界面据此把删除置灰并写「被 N 个会话引用」
        presets: presets
          .list(
            PRESET_KINDS.includes(req.query.kind as PresetKind)
              ? (req.query.kind as PresetKind)
              : undefined,
          )
          .map((p) =>
            p.kind === "agent"
              ? { ...withBuiltin(p), refCount: refs.get(p.id) ?? 0 }
              : withBuiltin(p),
          ),
      };
    },
  );

  app.post("/api/v1/studio/presets", async (req, reply) => {
    const b = req.body;
    if (!isObject(b)) return bad(reply);
    const name = str(b.name, 100);
    const kind = b.kind;
    if (!name || !PRESET_KINDS.includes(kind as PresetKind)) return bad(reply);
    // 能力可以带在创建请求里（面板默认值 / 冒烟脚本用）
    const caps = b.capabilities;
    if (
      caps !== undefined &&
      caps !== null &&
      (!Array.isArray(caps) || !caps.every((c) => typeof c === "string"))
    )
      return bad(reply, "invalid_capabilities");
    const capsAdd = idList(b.capsAdd);
    const capsRemove = idList(b.capsRemove);
    if (capsAdd === "bad" || capsRemove === "bad")
      return bad(reply, "invalid_capabilities");
    const preset = presets.create({
      kind: kind as PresetKind,
      name,
      description: typeof b.description === "string" ? b.description : "",
      capabilities: (caps as string[] | null | undefined) ?? null,
      ...(capsAdd === undefined ? {} : { capsAdd }),
      ...(capsRemove === undefined ? {} : { capsRemove }),
    });
    presets.replaceNodes(preset.id, [
      {
        id: `${preset.id}-root`,
        tag: null,
        title: ROOT_TITLE[preset.kind],
        slotKind: "custom",
        channel: "system",
        builtin: false,
        items: [],
      },
    ]);
    return reply.code(201).send(withBuiltin(preset));
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/studio/presets/:id",
    async (req, reply) => {
      const preset = presets.detail(req.params.id);
      if (!preset) return reply.code(404).send({ error: "not_found" });
      return { preset: withBuiltin(preset) };
    },
  );

  /** 按某个模型求值后的结果（创建流程预览用）：model 写成 供应商id/模型id，缺省按全局默认 */
  app.get<{ Params: { id: string }; Querystring: { model?: string } }>(
    "/api/v1/studio/presets/:id/render",
    async (req, reply) => {
      const d = presets.detail(req.params.id);
      if (!d) return reply.code(404).send({ error: "not_found" });
      const model = parseModelRef(req.query.model) ?? defaultModel();
      return composePreset(d, cards.getMany(presetCardIds(d)), model);
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/studio/presets/:id",
    async (req, reply) => {
      const b = req.body;
      if (!isObject(b)) return bad(reply);
      const cur = presets.get(req.params.id);
      if (!cur) return reply.code(404).send({ error: "not_found" });
      if (isBuiltinPreset(cur.id)) return builtin(reply);
      // 能力集合：id 形如 tool:read / skill:x / mcp:y；null = 不限制
      let capabilities: string[] | null | undefined;
      if (b.capabilities === null) capabilities = null;
      else if (Array.isArray(b.capabilities)) {
        const caps = b.capabilities.filter(
          (x): x is string => typeof x === "string" && x.length < 200,
        );
        if (caps.length !== b.capabilities.length)
          return bad(reply, "bad_capabilities");
        capabilities = caps;
      } else if (b.capabilities !== undefined)
        return bad(reply, "bad_capabilities");

      // 模式的另外两种能力操作（capabilities 对模式即「限定为」）
      const capsAdd = idList(b.capsAdd);
      const capsRemove = idList(b.capsRemove);
      if (capsAdd === "bad" || capsRemove === "bad")
        return bad(reply, "bad_capabilities");

      return presets.update(req.params.id, {
        ...(typeof b.name === "string"
          ? { name: str(b.name, 100) ?? cur.name }
          : {}),
        ...(typeof b.description === "string"
          ? { description: b.description }
          : {}),
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(capsAdd === undefined ? {} : { capsAdd }),
        ...(capsRemove === undefined ? {} : { capsRemove }),
      });
    },
  );

  /** 复制一份（段与分组一起）；段 id 全局唯一，所以换成新预设的前缀 */
  app.post<{ Params: { id: string } }>(
    "/api/v1/studio/presets/:id/copy",
    async (req, reply) => {
      const src = presets.detail(req.params.id);
      if (!src) return reply.code(404).send({ error: "not_found" });
      const made = presets.create({
        kind: src.kind,
        name: `${src.name}（副本）`.slice(0, 100),
        description: src.description,
        capabilities: src.capabilities,
        capsAdd: src.capsAdd,
        capsRemove: src.capsRemove,
      });
      presets.replaceNodes(
        made.id,
        src.nodes.map((n, i) => ({ ...n, id: `${made.id}-${i}` })),
      );
      return reply.code(201).send(withBuiltin(made));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/studio/presets/:id/activate",
    async (req, reply) => {
      const cur = presets.get(req.params.id);
      if (!cur) return reply.code(404).send({ error: "not_found" });
      if (isBuiltinPreset(cur.id)) return builtin(reply);
      if (cur.kind === "project-agentsmd") return bad(reply, "not_activatable");
      const b = isObject(req.body) ? req.body : {};
      // 全局 AGENTS.md：生效 = 把这个版本写进文件；文件被人改过时先问（409）
      if (cur.kind === "global-agentsmd") {
        if ((await file.state()).modified && b.overwrite !== true)
          return reply.code(409).send({ error: "disk_modified" });
        presets.activate(cur.id);
        await file.write(renderMd(cur.id));
        return { ok: true };
      }
      presets.activate(req.params.id);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/studio/presets/:id",
    async (req, reply) => {
      const cur = presets.get(req.params.id);
      if (!cur) return reply.code(404).send({ error: "not_found" });
      if (isBuiltinPreset(cur.id)) return builtin(reply);
      const refs = cur.kind === "agent" ? (agentRefs().get(cur.id) ?? 0) : 0;
      if (refs > 0)
        return reply.code(409).send({ error: "agent_in_use", count: refs });
      // 生效的全局 AGENTS.md 是此刻的文件来源，先让用户激活别的
      if (cur.kind === "global-agentsmd" && cur.active)
        return reply.code(409).send({ error: "active" });
      presets.remove(req.params.id);
      return reply.code(204).send();
    },
  );

  /** 整份替换预设的段（含分组与条件）；界面本地编辑，保存时一次提交 */
  app.put<{ Params: { id: string }; Querystring: { overwrite?: string } }>(
    "/api/v1/studio/presets/:id/nodes",
    async (req, reply) => {
      const cur = presets.get(req.params.id);
      if (!cur) return reply.code(404).send({ error: "not_found" });
      if (isBuiltinPreset(cur.id)) return builtin(reply);
      const b = req.body;
      if (!isObject(b)) return bad(reply);
      const nodes = parseNodes(b.nodes, (id) => cards.get(id) !== undefined, {
        flat: isAgentsMd(cur.kind),
      });
      if (typeof nodes === "string") return bad(reply, "invalid_nodes", nodes);
      // 改的是生效中的全局 AGENTS.md：新内容要重写进文件，重写前同样先问
      const rewrite = cur.kind === "global-agentsmd" && cur.active;
      if (
        rewrite &&
        (await file.state()).modified &&
        req.query.overwrite !== "1"
      )
        return reply.code(409).send({ error: "disk_modified" });
      presets.replaceNodes(req.params.id, nodes);
      if (rewrite) await file.write(renderMd(cur.id));
      return { preset: presets.detail(req.params.id) };
    },
  );

  // ---- 工具描述覆盖（调优用）----

  // descriptions 是调优覆盖；originals 是模型实际收到的原文（会话创建时记下，没有会话跑过就是空）
  app.get("/api/v1/studio/tool-descriptions", async () => ({
    descriptions: tools?.all() ?? [],
    originals: tools?.originals() ?? {},
  }));

  app.put<{ Params: { name: string } }>(
    "/api/v1/studio/tool-descriptions/:name",
    async (req, reply) => {
      if (!tools) return reply.code(501).send({ error: "not_supported" });
      const b = req.body;
      if (!isObject(b) || typeof b.description !== "string") return bad(reply);
      if (b.description.length > 2000) return bad(reply, "too_long");
      return tools.set(req.params.name, b.description);
    },
  );

  app.delete<{ Params: { name: string } }>(
    "/api/v1/studio/tool-descriptions/:name",
    async (req, reply) => {
      tools?.remove(req.params.name);
      return reply.code(204).send();
    },
  );
}
