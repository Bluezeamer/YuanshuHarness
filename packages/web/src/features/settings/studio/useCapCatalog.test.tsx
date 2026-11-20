import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useCapCatalog } from "./useCapCatalog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GROUPS = {
  files: "文件与命令",
  orchestrate: "编排与委派",
  devtools: "开发调试",
  framework: "框架工具",
};
const tool = (
  name: string,
  group: keyof typeof GROUPS,
  over: { readOnly?: boolean; framework?: boolean } = {},
) => ({
  name,
  description: `${name} 说明`,
  readOnly: over.readOnly ?? false,
  server: false,
  group: { key: group, name: GROUPS[group] },
  framework: over.framework ?? false,
});

test("内置工具按用途分组；派发工具合成「子代理」单元排进所属的组；框架工具不进清单", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.includes("/tools")
        ? {
            tools: [
              tool("read", "files", { readOnly: true }),
              tool("bash", "files"),
              tool("spawn_subagent", "orchestrate"),
              tool("message_subagent", "orchestrate"),
              tool("workflow_run", "orchestrate"),
              tool("browser_network", "devtools"),
              tool("ask_user", "framework", { framework: true }),
              tool("todo_write", "framework", { framework: true }),
            ],
          }
        : url.includes("/skills")
          ? { skills: [] }
          : { servers: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const { result } = renderHook(() => useCapCatalog());
  await waitFor(() => expect(result.current).not.toBeNull());
  const groups = result.current ?? [];
  expect(groups.map((g) => g.title)).toEqual([
    "文件与命令",
    "编排与委派",
    "开发调试",
    "技能",
    "MCP 服务",
  ]);
  expect(groups[0]?.items.map((i) => i.id)).toEqual([
    "tool:read",
    "tool:bash",
    "unit:canvas",
  ]);
  // 派发工具不单列；单元排在所属组的工具之后
  expect(groups[1]?.items.map((i) => i.id)).toEqual([
    "tool:workflow_run",
    "unit:subagent",
    "unit:team",
  ]);
  expect(groups[1]?.items.map((i) => i.name)).toContain("子代理");
  // 调试工具合成一项「开发调试」单元，排进自己的组
  expect(groups[2]?.items.map((i) => i.id)).toEqual(["unit:devtools"]);
  const ids = groups.flatMap((g) => g.items.map((i) => i.id));
  expect(ids).not.toContain("tool:ask_user");
  expect(ids).not.toContain("tool:todo_write");
});
