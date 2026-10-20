// 测试用 stdio MCP server：echo 回显参数，fail 返回 isError，env 回显环境变量。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "0.0.0" });
const reply = (text, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

server.tool("echo", "回显 text", { text: z.string() }, async ({ text }) =>
  reply(`echo:${text}`),
);
server.tool("fail", "总是失败", {}, async () => reply("boom", true));
server.tool("env", "回显环境变量", { name: z.string() }, async ({ name }) =>
  reply(process.env[name] ?? ""),
);

await server.connect(new StdioServerTransport());
