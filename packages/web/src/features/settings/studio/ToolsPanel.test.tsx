// 提示词调优页的「工具」：列里显示模型实际收到的描述（英文原文 / 覆盖），不是目录里的中文标签。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../../../api/http";
import {
  type Call,
  fakeFetch,
  type Handler,
  json,
} from "../../../test/dialogsServer";
import { LeaveGuardProvider } from "../frame/leave";
import { ToolsPanel } from "./ToolsPanel";

const tool = (name: string, label: string) => ({
  name,
  description: label,
  readOnly: false,
  server: false,
  group: { key: "files", name: "文件与命令" },
  kind: "fixed",
  framework: false,
  note: null,
  factory: null,
  rule: null,
  modified: false,
});

const READ = "Read the contents of a file. Supports text files and images.";

let calls: Call[];
let overrides: { name: string; description: string; updatedAt: string }[];
let originals: Record<string, string>;

const server: Handler = (c) => {
  if (c.method === "GET" && c.path === "/api/v1/tools")
    return json({
      tools: [tool("read", "读取文件"), tool("write", "写入文件")],
    });
  if (c.method === "GET" && c.path === "/api/v1/mcp")
    return json({ servers: [] });
  if (c.method === "GET" && c.path === "/api/v1/studio/tool-descriptions")
    return json({ descriptions: overrides, originals });
  if (
    c.method === "PUT" &&
    c.path.startsWith("/api/v1/studio/tool-descriptions/")
  )
    return json({
      name: c.path.split("/").pop(),
      description: (c.body as { description: string }).description,
      updatedAt: "2026-11-10T00:00:00Z",
    });
  return undefined;
};

beforeEach(() => {
  saveToken("tkn");
  calls = [];
  overrides = [];
  originals = { read: READ, write: "Write content to a file." };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount() {
  vi.stubGlobal("fetch", fakeFetch(calls, server));
  render(
    <LeaveGuardProvider>
      <ToolsPanel />
    </LeaveGuardProvider>,
  );
  await screen.findByText("Write content to a file.");
}
const rowOf = (name: string) =>
  screen.getByRole("cell", { name }).closest("tr") as HTMLElement;

test("列里是模型收到的英文原文，不是目录里的中文标签", async () => {
  await mount();
  expect(rowOf("read").textContent).toContain(READ);
  expect(rowOf("read").textContent).not.toContain("读取文件");
});

test("覆盖过的显示覆盖的并标「已覆盖」；点调优时编辑框从当前显示的内容起手", async () => {
  overrides = [
    { name: "read", description: "读文件（调优后）", updatedAt: "2026-11-10" },
  ];
  await mount();
  expect(rowOf("read").textContent).toContain("读文件（调优后）");
  expect(rowOf("read").textContent).toContain("已覆盖");

  fireEvent.click(within(rowOf("write")).getByRole("button", { name: "调优" }));
  const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
  // 没覆盖的从英文原文起手，而不是中文标签
  expect(box.value).toBe("Write content to a file.");
});

test("还没有会话运行过（没有原文）：如实说明，不给调优入口，不拿中文标签顶替", async () => {
  originals = {};
  vi.stubGlobal("fetch", fakeFetch(calls, server));
  render(
    <LeaveGuardProvider>
      <ToolsPanel />
    </LeaveGuardProvider>,
  );
  const row = await waitFor(() => rowOf("read"));
  await waitFor(() => expect(row.textContent).toContain("还没有会话运行过"));
  expect(
    (within(row).getByRole("button", { name: "调优" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
