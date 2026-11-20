// 回复里的文件引用：`[名称](file:<主机>:<路径>)` 点一下就在文件预览标签里打开。
// 不在目录内（独立渲染）时退化成普通文字，不给点了没反应的入口。
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LayoutProvider } from "../../workspace/layoutContext";
import type { Directory } from "../../workspace/model/l2";
import {
  LAYOUT_VERSION,
  type LayoutDoc,
} from "../../workspace/model/layoutDoc";
import {
  createLayoutStore,
  type LayoutStore,
} from "../../workspace/store/layoutStore";
import { chatPaneOf } from "./chatPane";
import { Markdown } from "./Markdown";

const envs = vi.hoisted(() => ({
  listEnvironments: vi.fn(async () => ({
    ok: true,
    data: [{ id: "local", name: "本机" }],
  })),
  sessionDirectories: vi.fn(async () => ({
    ok: true,
    data: [{ environmentId: "local", path: "/w", role: "local" }],
  })),
}));
vi.mock("../../../api/environments", () => ({
  listEnvironments: envs.listEnvironments,
}));
vi.mock("../../../api/directories", () => ({
  sessionDirectories: envs.sessionDirectories,
}));
const attachments = vi.hoisted(() => ({
  attachmentBlob: vi.fn(async () => ({
    ok: true,
    data: new Blob(["x"], { type: "image/png" }),
  })),
  downloadAttachment: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../../api/attachments", () => attachments);

const WS: readonly Directory[] = [{ host: "server", path: "/w" }];
// 会话列表要带上 s1：否则 store 的会话收敛会把 s1 的标签剪掉
const SESSION = {
  id: "s1",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archived: false,
};
const TEXT = "[报告](file:local:/w/out/report.md)";

/** 一个窗口、一个窗格、一个 s1 对话标签 */
const DOC: LayoutDoc = {
  version: LAYOUT_VERSION,
  windows: {
    list: [
      {
        id: "w1",
        focus: "p1",
        root: {
          pid: "p1",
          host: null,
          tabs: [{ id: "t1", type: "chat", ctab: "chat", sid: "s1" }],
          active: "t1",
        },
      },
    ],
    active: 0,
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function setup(): Promise<LayoutStore> {
  const store = createLayoutStore({
    api: {
      get: async () => ({ ok: true, data: { revision: 0, document: DOC } }),
      put: async (_id, rev) => ({ ok: true, revision: rev + 1 }),
    },
    debounceMs: 10_000,
    notify: () => {},
  });
  render(
    <LayoutProvider
      store={store}
      workspaceId="ws1"
      directories={WS}
      sessions={[SESSION]}
      hosts={[]}
    >
      <Markdown text={TEXT} sessionId="s1" />
    </LayoutProvider>,
  );
  await act(async () => {
    await store.setWorkspace("ws1");
  });
  return store;
}

test("点文件引用在文件预览标签里打开", async () => {
  const store = await setup();
  fireEvent.click(screen.getByRole("link", { name: "报告" }));

  // 预览标签自己渲染要走接口，直接查 store 状态
  await waitFor(() => {
    const st = store.getState().doc.windows;
    const win = st.list[st.active];
    const tabs = win ? JSON.stringify(win) : "";
    expect(tabs).toContain('"type":"preview"');
    expect(tabs).toContain("/w/out/report.md");
  });
});

test("图片引用了不存在的主机：占位里写明原因", async () => {
  render(<Markdown text="![图](file:nope:/a.png)" sessionId="s1" />);
  await waitFor(() =>
    expect(
      document.querySelector(".md-img-note[data-state='fail']")?.textContent,
    ).toBe("[图片：图] 没有叫「nope」的主机"),
  );
});

test("附件区地址：图片按附件区接口读（路径换成相对附件区根的写法）", async () => {
  render(
    <Markdown
      text="![图](file:attachment:/2026-11-16/ab12cd34-c.png)"
      sessionId="s1"
    />,
  );
  await waitFor(() =>
    expect(document.querySelector(".md-img img")).toBeTruthy(),
  );
  expect(attachments.attachmentBlob.mock.calls[0]?.slice(1)).toEqual([
    "s1",
    "./2026-11-16/ab12cd34-c.png",
  ]);
});

test("没有目录上下文时退化成普通文字链接，不可点开预览", () => {
  render(<Markdown text={TEXT} sessionId="s1" />);
  expect(screen.queryByRole("button", { name: "报告" })).toBeNull();
  const a = screen.getByText("报告").closest("a");
  expect(a).not.toBeNull();
  // jsdom 会把 href 里的中文百分号编码，比对前先解码
  expect(decodeURIComponent(a?.getAttribute("href") ?? "")).toContain(
    "file:local:/w/out/report.md",
  );
});

test("chatPaneOf：在当前窗口里找到承载该会话的对话窗格", async () => {
  const store = await setup();
  const at = chatPaneOf(store, "s1");
  expect(at).toEqual({ pid: "p1", tabId: "t1", host: undefined });
  // 会话在这个窗口里没有对话标签：退回第一个窗格当参照
  expect(chatPaneOf(store, "s2")).toEqual({
    pid: "p1",
    tabId: null,
    host: undefined,
  });
});
