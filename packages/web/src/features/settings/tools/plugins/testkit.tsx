// 仅测试使用：pi 扩展的带状态假服务端，语义对照 server 的 plugins/runtime.ts 与 api/plugins.ts。
import { fireEvent, screen } from "@testing-library/react";
import type { PluginPreview, PluginView } from "../../../../api/pluginLibrary";
import { toolsRoutes } from "../builtin/testkit";
import { fakeFetch, mountPage, type Route, reply } from "../common/testkit";

export const plugin = (
  source: string,
  over: Partial<PluginView> = {},
): PluginView => ({
  source,
  version: "1.0.0",
  enabled: true,
  installed: true,
  extensionCount: 1,
  skillCount: 0,
  ...over,
});

export const seedPlugins = (): PluginView[] => [
  plugin("npm:pi-subagents", { version: "2.1.0", extensionCount: 2 }),
  plugin("npm:@tintinweb/pi-tasks", { version: "0.9.0", skillCount: 1 }),
  plugin("npm:pi-web-access", { enabled: false, extensionCount: 0 }),
];

/** 预览的答案按来源给；没给的来源按「里面什么也没有」处理（服务端 422 source_empty）。 */
export type PreviewBook = Record<string, PluginPreview>;

export function pluginRoutes(
  initial: PluginView[] = seedPlugins(),
  book: PreviewBook = {},
) {
  const state = { plugins: structuredClone(initial) };
  const find = (source: string) =>
    state.plugins.find((p) => p.source === source);

  const route: Route = (method, path, body) => {
    if (!path.startsWith("/api/v1/plugins")) return undefined;
    const rest = path.slice("/api/v1/plugins".length);
    if (method === "GET" && rest === "") return reply(200, state.plugins);
    if (method === "POST" && rest === "/preview") {
      const source = (body as { source: string }).source;
      const hit = book[source];
      return hit
        ? reply(200, hit)
        : reply(422, {
            error: "source_empty",
            message: `这个来源里没有可加载的内容：${source}`,
          });
    }
    if (method === "POST" && rest === "") {
      const { source, allowScript } = body as {
        source: string;
        allowScript?: boolean;
      };
      const hit = book[source];
      if (!hit)
        return reply(502, { error: "install_failed", message: "npm 挂了" });
      // 带脚本又没允许：服务端用 --ignore-scripts 装，包照样装上
      void allowScript;
      state.plugins.push(
        plugin(source, {
          version: hit.version,
          extensionCount: hit.extensionCount,
          skillCount: hit.skillCount,
        }),
      );
      return reply(204);
    }
    const source = decodeURIComponent(rest.slice(1));
    const cur = find(source);
    if (method === "PATCH") {
      if (!cur)
        return reply(404, { error: "not_found", message: "没有登记这个包" });
      cur.enabled = (body as { enabled: boolean }).enabled;
      return reply(204);
    }
    if (method === "DELETE") {
      if (!cur)
        return reply(404, { error: "not_found", message: "没有登记这个包" });
      state.plugins = state.plugins.filter((p) => p.source !== source);
      return reply(204);
    }
    return undefined;
  };
  return { route, state };
}

/** 挂载整页并切到「扩展」页签。 */
export async function mountPlugins(initial?: PluginView[], book?: PreviewBook) {
  const api = pluginRoutes(initial, book);
  const fake = fakeFetch(api.route, toolsRoutes().route);
  await mountPage(fake);
  fireEvent.click(screen.getByRole("tab", { name: /扩展/ }));
  await screen.findByRole("complementary", { name: "pi 扩展" });
  return { fake, api };
}
