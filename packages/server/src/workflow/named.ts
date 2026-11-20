// 命名流程（workflow.md §6）：一个文件一个流程，文件名就是流程名。文件头是一段纯 JSON 的块注释，
// 宿主只做字符串定位与 JSON.parse，绝不对脚本文本求值。
import { LocalEnv } from "../env/local.js";
import type { ExecEnv } from "../env/types.js";
import { pathOf } from "../permission/paths.js";

/** 名称就是文件名（不含 .js），避免名字写在两处而不一致。 */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** 元数据块的开头：文件（去掉开头空白后）以它开始，到第一个块注释结束符为止。 */
export const META_OPEN = "/* @workflow";
/** 项目层目录，相对会话当前所在的 directory。 */
export const PROJECT_DIR = [".ys", "workflows"] as const;

export const PARAM_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export interface ParamDecl {
  type: ParamType;
  description?: string;
  default?: unknown;
  required?: boolean;
}

export interface WorkflowMeta {
  description: string;
  params: Record<string, ParamDecl>;
  phases: string[];
}

export type Layer = "global" | "project";

export interface NamedEntry {
  name: string;
  layer: Layer;
  path: string;
  meta: WorkflowMeta;
  script: string;
}

export interface InvalidEntry {
  name: string;
  layer: Layer;
  /** 已带文件路径的原因，列表与运行报错用的是同一条 */
  error: string;
}

const META_KEYS = ["description", "params", "phases"];
const PARAM_KEYS = ["type", "description", "default", "required"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const describe = (v: unknown): string => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
};

const typeOk = (type: ParamType, v: unknown): boolean => {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return isRecord(v);
  }
};

export type ParsedWorkflow =
  | { ok: true; meta: WorkflowMeta; script: string }
  | { ok: false; error: string };

const bad = (error: string): ParsedWorkflow => ({ ok: false, error });

function checkParam(
  name: string,
  raw: unknown,
): { ok: true; decl: ParamDecl } | { ok: false; error: string } {
  const at = `parameter ${JSON.stringify(name)}`;
  if (!isRecord(raw)) return { ok: false, error: `${at} must be an object` };
  const unknown = Object.keys(raw).filter((k) => !PARAM_KEYS.includes(k));
  if (unknown.length > 0)
    return {
      ok: false,
      error: `${at} has unknown field ${unknown.map((k) => JSON.stringify(k)).join(", ")} (allowed: ${PARAM_KEYS.join(", ")})`,
    };
  if (!PARAM_TYPES.includes(raw.type as ParamType))
    return {
      ok: false,
      error: `${at}: "type" must be one of ${PARAM_TYPES.join(" | ")}`,
    };
  const decl: ParamDecl = { type: raw.type as ParamType };
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string")
      return { ok: false, error: `${at}: "description" must be a string` };
    decl.description = raw.description;
  }
  if (raw.required !== undefined) {
    if (typeof raw.required !== "boolean")
      return { ok: false, error: `${at}: "required" must be a boolean` };
    decl.required = raw.required;
  }
  if (raw.default !== undefined) {
    if (!typeOk(decl.type, raw.default))
      return {
        ok: false,
        error: `${at}: "default" must be of type ${decl.type} (got ${describe(raw.default)})`,
      };
    decl.default = raw.default;
  }
  return { ok: true, decl };
}

function checkMeta(raw: unknown):
  | { ok: true; meta: WorkflowMeta }
  | {
      ok: false;
      error: string;
    } {
  if (!isRecord(raw))
    return { ok: false, error: "the metadata block must be a JSON object" };
  const unknown = Object.keys(raw).filter((k) => !META_KEYS.includes(k));
  if (unknown.length > 0)
    return {
      ok: false,
      error: `unknown field ${unknown.map((k) => JSON.stringify(k)).join(", ")} (allowed: ${META_KEYS.join(", ")})`,
    };
  if (typeof raw.description !== "string" || raw.description.trim() === "")
    return { ok: false, error: `"description" must be a non-empty string` };
  const params: Record<string, ParamDecl> = {};
  if (raw.params !== undefined) {
    if (!isRecord(raw.params))
      return { ok: false, error: `"params" must be an object` };
    for (const [name, decl] of Object.entries(raw.params)) {
      const r = checkParam(name, decl);
      if (!r.ok) return { ok: false, error: r.error };
      params[name] = r.decl;
    }
  }
  const phases: string[] = [];
  if (raw.phases !== undefined) {
    if (
      !Array.isArray(raw.phases) ||
      !raw.phases.every((p) => typeof p === "string" && p !== "")
    )
      return { ok: false, error: `"phases" must be an array of strings` };
    phases.push(...(raw.phases as string[]));
  }
  return {
    ok: true,
    meta: { description: raw.description, params, phases },
  };
}

/**
 * 文件 → `{ meta, script }`。元数据块缺失、JSON 非法、字段不合法都返回错误：
 * 解析失败的文件不可运行，原因同时出现在列表与运行报错里。
 */
export function parseNamedWorkflow(text: string): ParsedWorkflow {
  const head = text.trimStart();
  if (!head.startsWith(META_OPEN))
    return bad(`the file must start with a "${META_OPEN}" metadata block`);
  const from = text.length - head.length + META_OPEN.length;
  const close = text.indexOf("*/", from);
  if (close < 0) return bad(`the "${META_OPEN}" block is not closed with "*/"`);
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(from, close));
  } catch (e) {
    return bad(
      `invalid JSON in the "${META_OPEN}" block: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const meta = checkMeta(raw);
  if (!meta.ok) return bad(meta.error);
  const script = text.slice(close + 2);
  if (script.trim() === "")
    return bad("there is no script after the metadata block");
  return { ok: true, meta: meta.meta, script };
}

export type CheckedArgs =
  | { ok: true; args: unknown }
  | { ok: false; error: string };

/** 按声明补默认值并校验 args；没声明 params 的流程原样透传。错误一次列全。 */
export function checkArgs(
  params: Record<string, ParamDecl>,
  raw: unknown,
): CheckedArgs {
  const names = Object.keys(params);
  if (names.length === 0) return { ok: true, args: raw };
  const fail = (errors: string[]): CheckedArgs => ({
    ok: false,
    error: `Invalid args:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
  });
  const args = raw === undefined ? {} : raw;
  if (!isRecord(args))
    return fail([
      `args must be an object with the declared params (got ${describe(args)})`,
    ]);
  const errors: string[] = [];
  const unknown = Object.keys(args).filter((k) => !names.includes(k));
  if (unknown.length > 0)
    errors.push(
      `unknown ${unknown.length === 1 ? "param" : "params"} ${unknown
        .map((k) => JSON.stringify(k))
        .join(", ")} (allowed: ${names.join(", ")})`,
    );
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const decl = params[name] as ParamDecl;
    const given = Object.hasOwn(args, name)
      ? (args as Record<string, unknown>)[name]
      : undefined;
    if (given !== undefined) {
      if (typeOk(decl.type, given)) out[name] = given;
      else
        errors.push(
          `${JSON.stringify(name)} must be of type ${decl.type} (got ${describe(given)})`,
        );
      continue;
    }
    if (decl.default !== undefined) out[name] = decl.default;
    else if (decl.required) errors.push(`${JSON.stringify(name)} is required`);
  }
  return errors.length > 0 ? fail(errors) : { ok: true, args: out };
}

export type NamedRun =
  | { ok: true; script: string; args: unknown; layer: Layer }
  | { ok: false; error: string };

type Loaded =
  | { kind: "ok"; entry: NamedEntry }
  | { kind: "invalid"; error: string }
  | { kind: "missing" };

interface Source {
  layer: Layer;
  env: ExecEnv;
  dir: string;
}

export interface NamedDeps {
  /** 全局层目录（Server 本机）：`<ysHome>/workflows`，不存在等于空。 */
  globalDir: string;
  /** 会话此刻所在 directory 的环境与路径；拿不到时只有全局层。 */
  project: (sessionId: string) => { env: ExecEnv; path: string } | null;
}

/** 两层命名流程：项目层覆盖全局层，同名只列生效的那一个。无缓存，每次现读。 */
export class NamedWorkflows {
  private readonly local = new LocalEnv();

  constructor(private readonly deps: NamedDeps) {}

  private sources(sessionId: string): Source[] {
    const out: Source[] = [];
    const project = this.deps.project(sessionId);
    if (project)
      out.push({
        layer: "project",
        env: project.env,
        dir: pathOf(project.env).join(project.path, ...PROJECT_DIR),
      });
    out.push({ layer: "global", env: this.local, dir: this.deps.globalDir });
    return out;
  }

  private fileName(name: string): string {
    return `${name}.js`;
  }

  private async names(source: Source): Promise<string[]> {
    let entries: Awaited<ReturnType<ExecEnv["readdir"]>>;
    try {
      entries = await source.env.readdir(source.dir);
    } catch {
      return [];
    }
    return entries
      .filter((e) => !e.isDirectory && e.name.endsWith(".js"))
      .map((e) => e.name.slice(0, -3))
      .filter((n) => NAME_RE.test(n))
      .sort();
  }

  private async readOne(source: Source, name: string): Promise<Loaded> {
    const file = pathOf(source.env).join(source.dir, this.fileName(name));
    let text: string;
    try {
      text = (await source.env.readFile(file)).toString("utf8");
    } catch {
      return { kind: "missing" };
    }
    const parsed = parseNamedWorkflow(text);
    if (!parsed.ok)
      return { kind: "invalid", error: `${file}: ${parsed.error}` };
    return {
      kind: "ok",
      entry: {
        name,
        layer: source.layer,
        path: file,
        meta: parsed.meta,
        script: parsed.script,
      },
    };
  }

  async list(
    sessionId: string,
  ): Promise<{ entries: NamedEntry[]; invalid: InvalidEntry[] }> {
    const entries: NamedEntry[] = [];
    const invalid: InvalidEntry[] = [];
    const seen = new Set<string>();
    for (const source of this.sources(sessionId)) {
      for (const name of await this.names(source)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const r = await this.readOne(source, name);
        if (r.kind === "ok") entries.push(r.entry);
        else if (r.kind === "invalid")
          invalid.push({ name, layer: source.layer, error: r.error });
      }
    }
    const byName = (a: { name: string }, b: { name: string }) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    return { entries: entries.sort(byName), invalid: invalid.sort(byName) };
  }

  async resolve(sessionId: string, name: string): Promise<Loaded> {
    if (!NAME_RE.test(name))
      return {
        kind: "invalid",
        error: `Invalid workflow name ${JSON.stringify(name)}: use lowercase letters, digits, "-" and "_" (at most 64 characters).`,
      };
    for (const source of this.sources(sessionId)) {
      const r = await this.readOne(source, name);
      if (r.kind !== "missing") return r;
    }
    return { kind: "missing" };
  }

  /** 运行前的一步：解析文件、按声明填好 args。读文件的次数只有这一次。 */
  async resolveRun(
    sessionId: string,
    name: string,
    args: unknown,
  ): Promise<NamedRun> {
    const r = await this.resolve(sessionId, name);
    if (r.kind === "invalid") return { ok: false, error: r.error };
    if (r.kind === "missing") {
      const { entries } = await this.list(sessionId);
      const available = entries.map((e) => e.name);
      return {
        ok: false,
        error: `There is no named workflow ${JSON.stringify(name)}. ${
          available.length > 0
            ? `Available: ${available.join(", ")}.`
            : `No workflow has been saved yet; the workflow_run tool description says how to save one.`
        }`,
      };
    }
    const checked = checkArgs(r.entry.meta.params, args);
    if (!checked.ok) return { ok: false, error: checked.error };
    return {
      ok: true,
      script: r.entry.script,
      args: checked.args,
      layer: r.entry.layer,
    };
  }
}
