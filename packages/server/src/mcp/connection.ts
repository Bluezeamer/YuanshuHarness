import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpToolInfo } from "../store/mcp.js";

// 密钥引用已展开的连接参数；只在建立连接的瞬间生成，不落库。
export type ResolvedMcp =
  | {
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | { transport: "http"; url: string; headers: Record<string, string> };

export interface McpCallResult {
  content: unknown[];
  isError: boolean;
}

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const STDERR_TAIL = 2000;

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// 一个 MCP server 的客户端连接：首次使用时连上，断开后下次使用自动重连。
export class McpConnection {
  private client: Client | null = null;
  private opening: Promise<Client> | null = null;

  constructor(private readonly resolve: () => ResolvedMcp) {}

  private open(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.opening ??= this.connect().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async connect(): Promise<Client> {
    const cfg = this.resolve();
    let stderrTail = "";
    let transport: Transport;
    if (cfg.transport === "stdio") {
      const t = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        stderr: "pipe",
      });
      t.stderr?.on("data", (b: Buffer) => {
        stderrTail = (stderrTail + b.toString()).slice(-STDERR_TAIL);
      });
      transport = t;
    } else {
      transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: { headers: cfg.headers },
      });
    }
    const client = new Client({ name: "yuanshu", version: "0.0.0" });
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (err) {
      await client.close().catch(() => {});
      const tail = stderrTail.trim();
      throw new Error(`${reason(err)}${tail ? `；stderr：${tail}` : ""}`);
    }
    client.onclose = () => {
      if (this.client === client) this.client = null;
    };
    this.client = client;
    return client;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const client = await this.open();
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools)
        out.push({
          name: t.name,
          description: t.description?.trim() || t.title || "",
          inputSchema: t.inputSchema as Record<string, unknown>,
        });
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const client = await this.open();
    const r = await client.callTool({ name, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return {
      content: Array.isArray(r.content) ? r.content : [],
      isError: r.isError === true,
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await (await this.opening?.catch(() => null))?.close().catch(() => {});
    await client?.close().catch(() => {});
  }
}
