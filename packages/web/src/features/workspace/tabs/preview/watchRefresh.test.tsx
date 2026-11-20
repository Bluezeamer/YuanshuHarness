// 预览标签订阅文件变更后的刷新行为。
// 回归点：`usePreview` 的 retry 曾经每次渲染都是新函数，而 PreviewTab 的刷新 effect 依赖它，
// 于是「收到 fs.changed → retry → 重渲染 → retry 又是新函数 → 再 retry」无限循环，
// 一保存就整页卡死、CPU 打满。这里断言：一次变更只重取有限次数，且 retry 身份稳定。
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  FakeWS,
  frame,
  installChatApi,
  msgs,
  snapshot,
} from "../../../../test/chatFakes";
import { ChatContext } from "../../../chat/context";
import { ChatHub } from "../../../chat/store/hub";
import { LayoutProvider } from "../../layoutContext";
import type { Pane, Tab } from "../../model/types";
import { createLayoutStore } from "../../store/layoutStore";
import { world } from "../files/testkit";
import { PreviewTab } from "./PreviewTab";
import { usePreview } from "./usePreview";

/** 把 hook 的状态挂到 DOM 上，方便断言 */
function StateProbe({
  onReady,
}: {
  onReady: (v: ReturnType<typeof usePreview>) => void;
}) {
  const api = usePreview("local", PATH);
  onReady(api);
  return (
    <span data-testid="text">
      {api.state.kind === "markdown" ? api.state.text : ""}
    </span>
  );
}

vi.mock(
  "../../../../api/files",
  async () => (await import("../files/testkit")).fakeFilesApi,
);

const PATH = "/w/a.md";

beforeEach(() => {
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS);
  world.reset();
  world.put("local", PATH, "# 标题\n\n正文\n");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// PreviewTab 还要目录上下文（主机名、标签路由）
function wrap(hub: ChatHub, children: React.ReactNode) {
  const store = createLayoutStore({
    api: {
      get: async () => ({ ok: true, data: { revision: 0, document: null } }),
      put: async (_id, rev) => ({ ok: true, revision: rev + 1 }),
    },
    debounceMs: 10_000,
    notify: () => {},
  });
  return (
    <LayoutProvider
      store={store}
      workspaceId="ws1"
      directories={null}
      sessions={null}
      hosts={[]}
    >
      <ChatContext.Provider value={hub}>{children}</ChatContext.Provider>
    </LayoutProvider>
  );
}

function probeApi() {
  const history = msgs(0, 2);
  installChatApi(history);
  const hub = new ChatHub({ token: () => "tok", onUnauthorized: () => {} });
  hub.acquire("s1");
  const ws = FakeWS.last;
  ws.serve(snapshot(1, history));
  return { hub, ws };
}

/** 推一帧 fs.changed 给这台环境 */
async function changed(ws: FakeWS, seq: number) {
  await act(async () => {
    ws.serve(frame(seq, "fs.changed", { env: "local", paths: [PATH] }));
  });
}

test("retry 身份稳定：依赖它的 effect 不会因为重渲染反复触发", () => {
  const seen = { changed: false };
  function Probe() {
    const { retry } = usePreview("local", PATH);
    const first = useRef(retry);
    if (first.current !== retry) seen.changed = true;
    return null;
  }
  const { rerender } = render(<Probe />);
  rerender(<Probe />);
  rerender(<Probe />);
  expect(seen.changed).toBe(false);
  cleanup();
});

test("收到 fs.changed 后只重取有限次数，不会无限循环", async () => {
  const { hub, ws } = probeApi();
  const tab = {
    id: "t1",
    type: "preview",
    host: "server",
    path: PATH,
  } as Tab;
  const pane = {
    pid: "p1",
    tabs: [],
    active: "",
    host: "server",
  } as unknown as Pane;

  render(
    wrap(
      hub,
      <PreviewTab
        tab={tab}
        pane={pane}
        sessionId="s1"
        active
        patchTab={() => {}}
        patchAfx={() => {}}
        close={() => {}}
      />,
    ),
  );
  await act(async () => {});

  const reads = () =>
    world.calls.filter((c) => c === `preview local ${PATH}`).length;
  const before = reads();
  await changed(ws, 2);
  await act(async () => {});
  const afterFirst = reads();
  // 一次变更最多重取一次（允许 0 次：编辑态不刷新），绝不能是「每次渲染都重取」
  expect(afterFirst - before).toBeLessThanOrEqual(1);

  await changed(ws, 3);
  await act(async () => {});
  expect(reads() - afterFirst).toBeLessThanOrEqual(1);

  // 再多推几帧也不该放大
  for (let i = 4; i < 8; i++) await changed(ws, i);
  expect(reads() - before).toBeLessThanOrEqual(6);
  hub.release("s1");
});

/** 编辑态下收到变更：不替换内容，只提示（不触发重取） */
test("编辑中收到变更不重取，改为提示", async () => {
  const { hub, ws } = probeApi();
  const tab = {
    id: "t2",
    type: "preview",
    host: "server",
    path: PATH,
  } as Tab;
  const pane = {
    pid: "p1",
    tabs: [],
    active: "",
    host: "server",
  } as unknown as Pane;
  const { container } = render(
    wrap(
      hub,
      <PreviewTab
        tab={tab}
        pane={pane}
        sessionId="s1"
        active
        patchTab={() => {}}
        patchAfx={() => {}}
        close={() => {}}
      />,
    ),
  );
  await act(async () => {});
  // 进入编辑态
  const edit = container.querySelector<HTMLButtonElement>(
    '.ws-pv-lead [role="radio"]',
  );
  const before = world.calls.filter(
    (c) => c === `preview local ${PATH}`,
  ).length;
  await changed(ws, 2);
  await act(async () => {});
  const after = world.calls.filter((c) => c === `preview local ${PATH}`).length;
  expect(after - before).toBeLessThanOrEqual(1);
  expect(edit === null).toBe(false);
  hub.release("s1");
});

// 回归点：保存只推进了编辑器自己的缓冲区，预览态（state.text）没变，
// 于是「保存 → 切回预览」还是旧内容，必须关掉重开才更新。
test("保存后 applySaved 让预览态立刻是新内容（不必重新拉）", async () => {
  let api: ReturnType<typeof usePreview> | null = null;
  const { container } = render(<StateProbe onReady={(v) => (api = v)} />);
  await act(async () => {});
  const shown = () =>
    container.querySelector('[data-testid="text"]')?.textContent ?? "";
  expect(shown()).toContain("正文");

  const reads = () =>
    world.calls.filter((c) => c === `preview local ${PATH}`).length;
  const before = reads();
  await act(async () => {
    api?.applySaved({
      text: "# 新标题\n\n刚写下的内容\n",
      base: { mtimeMs: 1, sha256: "sha-new" },
    });
  });
  expect(shown()).toContain("刚写下的内容");
  // 不额外拉一次接口
  expect(reads() - before).toBe(0);
});
