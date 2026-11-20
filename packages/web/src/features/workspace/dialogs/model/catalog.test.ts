import { expect, test } from "vitest";
import {
  allCapabilityIds,
  type Catalog,
  capabilityLibrary,
  capItemOf,
  parseCapId,
  settleModel,
} from "./catalog";
import { capsLabel } from "./labels";

const tool = (name: string) => ({
  name,
  description: `${name} 说明`,
  readOnly: false,
  server: true,
});
const cat = {
  tools: [tool("read"), tool("spawn_subagent"), tool("message_subagent")],
  skills: [],
  mcp: [],
} as unknown as Catalog;

test("能力单元：派发工具合成一项「子代理」，不再单列；单元 id 能解析、在库里算已知", () => {
  const lib = capabilityLibrary(cat);
  expect(lib.map((c) => c.id)).toEqual([
    "tool:read",
    "unit:subagent",
    "unit:canvas",
    "unit:team",
    "unit:devtools",
  ]);
  expect(lib.find((c) => c.id === "unit:subagent")).toMatchObject({
    kind: "unit",
    name: "子代理",
    known: true,
  });
  expect(parseCapId("unit:subagent")).toEqual({
    kind: "unit",
    name: "subagent",
  });
  expect(capItemOf(cat, "unit:subagent").known).toBe(true);
  // 「不限制」展开成显式清单时带上单元，不带被合并的两个工具，也不带默认关闭的「开发调试」
  expect(allCapabilityIds(cat)).toEqual([
    "tool:read",
    "unit:subagent",
    "unit:canvas",
    "unit:team",
  ]);
});

test("摘要里单元算在工具那一项里", () => {
  expect(capsLabel(["tool:read", "unit:subagent", "skill:x"])).toBe(
    "工具 2 · 技能 1 · MCP 0",
  );
});

const modelCat = (defaultLevel?: string) =>
  ({
    providers: [
      {
        id: "p",
        status: "ok",
        models: [
          {
            id: "m1",
            reasoning: true,
            levels: ["low", "medium", "high"],
            ...(defaultLevel ? { defaultLevel } : {}),
          },
        ],
      },
    ],
  }) as unknown as Catalog;

test("settleModel：刚换了模型落在它的默认档位；没有默认档位或不是刚换，保留当前档位", () => {
  expect(
    settleModel(modelCat("high"), "p", {
      model: "m1",
      reasoning: "low",
      fresh: true,
    }).reasoning,
  ).toBe("high");
  expect(
    settleModel(modelCat("high"), "p", { model: "m1", reasoning: "low" })
      .reasoning,
  ).toBe("low");
  expect(
    settleModel(modelCat(), "p", { model: "m1", reasoning: "low", fresh: true })
      .reasoning,
  ).toBe("low");
  // 还没有取值时：有默认档位就用它，没有仍是「中」
  expect(settleModel(modelCat("high"), "p", {}).reasoning).toBe("high");
  expect(settleModel(modelCat(), "p", {}).reasoning).toBe("medium");
});
