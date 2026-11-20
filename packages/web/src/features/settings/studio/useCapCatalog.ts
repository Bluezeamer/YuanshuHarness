import { createElement, type ReactNode, useEffect, useState } from "react";
import {
  CAPABILITY_UNITS,
  listMcp,
  listSkills,
  listTools,
  UNIT_TOOLS,
} from "../../../api/capabilities";
import { loadToken } from "../../../api/http";
import { Chip, Dot } from "../../../ui";
import { sectionsOf } from "../tools/builtin/model";

export interface CapEntry {
  id: string;
  name: string;
  desc: string;
  trail?: ReactNode;
}
export interface CapGroup {
  title: string;
  note?: string;
  items: CapEntry[];
}

// 能力的可选清单：内置工具、能力单元、技能、MCP 服务（id 形如 tool:read / unit:x / skill:x / mcp:y）。
export function useCapCatalog(): CapGroup[] | null {
  const [groups, setGroups] = useState<CapGroup[] | null>(null);
  useEffect(() => {
    const token = loadToken();
    void Promise.all([
      listTools(token),
      listSkills(token),
      listMcp(token),
    ]).then(([tools, skills, mcp]) => {
      setGroups([
        // 内置工具按用途分组（与设置页同一份分组）；能力单元排进它所属的那一组；框架工具始终可用，不在清单里
        ...(tools.ok
          ? sectionsOf(tools.data.filter((t) => !t.framework)).map((s) => ({
              title: s.name,
              items: [
                ...s.tools
                  .filter((t) => !UNIT_TOOLS.has(t.name))
                  .map((t) => ({
                    id: `tool:${t.name}`,
                    name: t.name,
                    desc: t.description,
                    ...(t.readOnly
                      ? { trail: createElement(Chip, null, "只读") }
                      : {}),
                  })),
                ...CAPABILITY_UNITS.filter((u) => u.group === s.key).map(
                  ({ id, name, desc }) => ({ id, name, desc }),
                ),
              ],
            }))
          : []),
        {
          title: "技能",
          items: skills.ok
            ? skills.data.map((s) => ({
                id: `skill:${s.name}`,
                name: s.name,
                desc: s.description,
                trail: s.scope === "global" ? "全局" : "项目",
              }))
            : [],
        },
        {
          title: "MCP 服务",
          items: mcp.ok
            ? mcp.data.map((m) => ({
                id: `mcp:${m.name}`,
                name: m.name,
                desc: m.tools ? `${m.tools.length} 个工具` : "还没拉取工具",
                trail: createElement(
                  "span",
                  { className: "sd-tr" },
                  createElement(Dot, {
                    tone: m.status?.state === "error" ? "warn" : "live",
                  }),
                  m.status?.state === "error" ? " 握手失败" : " 就绪",
                ),
              }))
            : [],
        },
      ]);
    });
  }, []);
  return groups;
}
