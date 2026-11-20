// 带 resource 的 stdio MCP server：pi 只有在服务宣告了 resources 能力时才注册 list_mcp_resources 等三个工具。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "fixture-resources", version: "0.0.0" });
server.tool("ping", "占位工具", async () => ({
  content: [{ type: "text", text: "pong" }],
}));
server.resource("note", "mem://note", async (uri) => ({
  contents: [{ uri: uri.href, text: "note" }],
}));

await server.connect(new StdioServerTransport());
