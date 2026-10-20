import { describe, expect, test } from "vitest";
import type { VariableMeta } from "../store/secrets.js";
import { variableNotice, variableNoticeExtension } from "./variable-notice.js";

const meta = (over: Partial<VariableMeta> = {}): VariableMeta => ({
  id: "1",
  name: "gitlab_token",
  purpose: "GitLab 推送",
  scopeKind: "domain",
  scopeTarget: "gitlab.example.com",
  tier: "auto",
  maskable: true,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

// 取出扩展注册的 before_agent_start 处理器。
function handler(list: () => VariableMeta[]) {
  let h: (() => unknown) | undefined;
  variableNoticeExtension({ list })({
    on: (ev: string, fn: () => unknown) => {
      if (ev === "before_agent_start") h = fn;
    },
  } as never);
  if (!h) throw new Error("未注册");
  return h as () => { message: { content: string } } | undefined;
}

describe("隐私变量清单通知", () => {
  test("列出名字、用途、范围、档位，不含值", () => {
    const t = variableNotice([meta()]);
    expect(t).toContain("@gitlab_token");
    expect(t).toContain("GitLab 推送");
    expect(t).toContain("gitlab.example.com");
    expect(t).toContain("自动模式");
  });

  test("清单不变不重复注入；变化或清空时再注入一次", () => {
    let vars: VariableMeta[] = [];
    const h = handler(() => vars);
    expect(h()).toBeUndefined(); // 一开始没有变量，不打扰
    vars = [meta()];
    expect(h()?.message.content).toContain("@gitlab_token");
    expect(h()).toBeUndefined();
    vars = [meta({ tier: "full" })];
    expect(h()?.message.content).toContain("完全允许");
    vars = [];
    expect(h()?.message.content).toContain("已清空");
    expect(h()).toBeUndefined();
  });
});
