import type { FastifyInstance, FastifyReply } from "fastify";
import { isObject } from "../lib/validate.js";
import {
  isFlatTool,
  isPolicy,
  matrixTool,
  type ToolPolicy,
} from "../permission/tool-matrix.js";
import {
  FRAMEWORK_TOOLS,
  TOOL_GROUPS,
  TOOLS,
  type ToolGroupKey,
  type ToolInfo,
} from "../session/tool-catalog.js";
import type { ToolRuleStore } from "../store/tool-rules.js";

// 出厂矩阵之外的工具（transfer_files、框架工具）不可调，只读展示。
const ALL: ToolInfo[] = [...TOOLS, ...FRAMEWORK_TOOLS];
const GROUP_ORDER = Object.keys(TOOL_GROUPS) as ToolGroupKey[];

// 内置工具目录与出厂规则矩阵：能力勾选用，也是「工具」页签的数据源。
export async function toolsApi(
  app: FastifyInstance,
  deps: { rules: ToolRuleStore },
): Promise<void> {
  const { rules } = deps;

  const view = (t: ToolInfo) => {
    const m = matrixTool(t.name);
    const rule = rules.effective(t.name);
    const factory = m?.factory ?? null;
    return {
      name: t.name,
      description: t.description,
      readOnly: t.readOnly,
      server: t.server,
      group: { key: t.group, name: TOOL_GROUPS[t.group] },
      kind: m?.kind ?? "fixed",
      framework: t.framework === true,
      note: t.note ?? null,
      factory,
      rule,
      modified:
        factory !== null &&
        rule !== null &&
        (rule.inside !== factory.inside || rule.outside !== factory.outside),
    };
  };
  // 组的顺序即展示顺序，组内保持目录声明顺序。
  const sorted = () =>
    [...ALL]
      .sort(
        (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
      )
      .map(view);

  app.get("/api/v1/tools", async () => ({ tools: sorted() }));

  const find = (name: string) =>
    ALL.find((t) => t.name === name && matrixTool(name));

  const missing = (reply: FastifyReply) =>
    reply.code(404).send({ error: "not_found" });

  const invalid = (reply: FastifyReply, message: string) =>
    reply.code(400).send({ error: "invalid_rule", message });

  // 规则校验：值不合法返回原因。工具是否可调由 find 判定。
  const check = (
    name: string,
    raw: unknown,
  ): { rule: ToolPolicy } | { reason: string } => {
    const body = isObject(raw) ? raw : {};
    if (!isPolicy(body.inside) || !isPolicy(body.outside))
      return { reason: "inside 与 outside 都须为 allow / ask" };
    if (isFlatTool(name) && body.inside !== body.outside)
      return { reason: "该工具不分 cwd，inside 与 outside 须相同" };
    return { rule: { inside: body.inside, outside: body.outside } };
  };

  // 改出厂规则：cwd 内 / 外各一档，两个都要给。与出厂值相同等于恢复出厂。
  app.put<{ Params: { name: string } }>(
    "/api/v1/tools/:name/rule",
    async (req, reply) => {
      const tool = find(req.params.name);
      if (!tool) return missing(reply);
      const r = check(tool.name, req.body);
      if ("reason" in r) return invalid(reply, r.reason);
      rules.set(tool.name, r.rule);
      return view(tool);
    },
  );

  // 批量写：每一项都校验通过才落库（一个事务），任一项不合格就整批拒绝、一行不写。
  app.put("/api/v1/tools/rules", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    if (!isObject(body.rules))
      return invalid(reply, "rules 须为 { 工具名: { inside, outside } }");
    const entries: Array<[string, ToolPolicy]> = [];
    for (const [name, raw] of Object.entries(body.rules)) {
      if (!find(name)) return invalid(reply, `工具不存在或不可调：${name}`);
      const r = check(name, raw);
      if ("reason" in r) return invalid(reply, `${name}：${r.reason}`);
      entries.push([name, r.rule]);
    }
    rules.setMany(entries);
    return { tools: sorted() };
  });

  // 恢复出厂；本来就没改过也返回 200（幂等）。
  app.delete<{ Params: { name: string } }>(
    "/api/v1/tools/:name/rule",
    async (req, reply) => {
      const tool = find(req.params.name);
      if (!tool) return missing(reply);
      rules.reset(tool.name);
      return view(tool);
    },
  );
}
