import { expect, test } from "vitest";
import type { ModelSpec } from "../../../api/providers";
import { levelOnSwitch } from "./models";

const spec = (over: Partial<ModelSpec> = {}): ModelSpec => ({
  id: "m",
  name: "m",
  reasoning: true,
  levels: ["low", "medium", "high"],
  input: ["text"],
  ctx: 1000,
  out: 100,
  source: "manual",
  ...over,
});

test("换到一个模型：声明了默认档位就用它，不管当前档位是什么", () => {
  expect(levelOnSwitch(spec({ defaultLevel: "high" }), "low")).toBe("high");
});

test("没声明默认档位：沿用当前档位，不支持就落到最近的一档；当前为空取中", () => {
  expect(levelOnSwitch(spec(), "medium")).toBe("medium");
  expect(levelOnSwitch(spec(), "xhigh")).toBe("high");
  expect(levelOnSwitch(spec(), null)).toBe("medium");
});

test("默认档位不在声明的档位里（档位后来被改掉了）：当作没声明", () => {
  expect(levelOnSwitch(spec({ defaultLevel: "max" }), "low")).toBe("low");
});

test("不支持思考的模型只有「关闭」", () => {
  expect(levelOnSwitch(spec({ reasoning: false, levels: [] }), "high")).toBe(
    "off",
  );
});
