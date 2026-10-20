// 隐私变量的权限侧（ADR-0052）：命令用了哪些变量、是否在登记的适用范围内。只用元数据，不接触值。

import type { VariableMeta } from "../store/secrets.js";
import type { Tier } from "../store/workspaces.js";
import { parseWithConnectors } from "./bash.js";
import { findPlaceholders } from "./placeholders.js";
import { parseSudo } from "./sudo.js";

export interface VarUse {
  meta: VariableMeta;
  /** 超出适用范围时的原因；在范围内为 null。 */
  problem: string | null;
}

const base = (w: string) => w.split("/").pop() ?? "";

// 域名或其子域名，且后面不能再接主机名字符（evil.com.x.net、example.com@evil.com 都不算）。
function mentionsDomain(line: string, domain: string): boolean {
  const re = new RegExp(
    `(?<![a-z0-9.-])(?:[a-z0-9-]+\\.)*${domain.replaceAll(".", "\\.")}(?![a-z0-9@-]|\\.[a-z0-9])`,
  );
  return re.test(line.toLowerCase());
}

// sudo 密码只能写成 `printf '%s\n' @名字 | sudo -S …`：占位符只出现在管道上游的 echo/printf 里，
// 且那条管道的下游紧接着带 -S 的 sudo。
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
      const feeder = r.segs[i] as string[];
      const next = r.segs[i + 1];
      return (
        ["echo", "printf"].includes(base(feeder[0] ?? "")) &&
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
      if (!mentionsDomain(line, meta.scopeTarget))
        problem = `只能用于访问 ${meta.scopeTarget}，命令里没有出现该域名`;
    } else if (meta.scopeKind === "sudo") {
      if (!(await feedsSudoStdin(line, name)))
        problem = "只能写成 printf '%s\\n' @名字 | sudo -S … 的形式喂给 sudo";
    }
    uses.push({ meta, problem });
  }
  return uses;
}

const RANK: Record<Tier, number> = { rules: 0, auto: 1, full: 2 };

/** 命令生效的档位：workspace 档位与所用变量的档位取最严的一档（ADR-0007：按变量的档位走）。 */
export function effectiveTier(tier: Tier, uses: readonly VarUse[]): Tier {
  return uses.reduce<Tier>(
    (t, u) => (RANK[u.meta.tier] < RANK[t] ? u.meta.tier : t),
    tier,
  );
}
