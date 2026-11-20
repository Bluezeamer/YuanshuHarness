import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, test } from "vitest";
import { LayoutProvider } from "../layoutContext";
import type { LayoutDoc } from "../model/layoutDoc";
import { createLayoutStore } from "../store/layoutStore";
import { getTabDef, registerTab } from "../tabs/registry";
import { TerminalGuardProvider } from "../tabs/terminal/wiring";
import { L2View } from "./L2View";

afterEach(cleanup);

// 同一窗格里同类型的两个标签必须是两个独立的组件实例：切换标签就是换一个实例。
// 之前标签内容没有按标签 id 做 key，终端、文件这类带本地状态的标签会被复用，
// 第二个终端标签其实还是第一个终端（服务端没新建终端，输入进了第一个）。
let mounts = 0;
function Probe({ tid }: { tid: string }) {
  const n = useRef<number | null>(null);
  if (n.current === null) n.current = ++mounts;
  return (
    <div data-testid="probe" data-tid={tid} data-instance={n.current}>
      实例 {n.current}
    </div>
  );
}

const HOSTS = [{ id: "server", name: "Server" }];
const SESSIONS = [
  { id: "a", updatedAt: "2026-01-01T00:00:00.000Z", archived: false },
];
const DIRS = [{ host: "server", path: "/w" }];

test("同窗格两个终端标签：切换时换成另一个组件实例，不复用第一个", async () => {
  registerTab("term", {
    ...getTabDef("term"),
    render: ({ tab }) => <Probe tid={tab.id} />,
  });
  const doc: LayoutDoc = {
    version: 4,
    windows: {
      list: [
        {
          id: "w1",
          focus: "p1",
          root: {
            pid: "p1",
            host: "server",
            tabs: [
              { id: "t1", type: "chat", ctab: "chat", sid: "a" },
              { id: "t2", type: "files", host: "server", path: "/w" },
            ],
            active: "t2",
          },
        },
      ],
      active: 0,
    },
  };
  const store = createLayoutStore({
    api: {
      get: async () => ({ ok: true, data: { revision: 0, document: doc } }),
      put: async (_id, rev) => ({ ok: true, revision: rev + 1 }),
    },
    debounceMs: 10_000,
    notify: () => {},
  });
  render(
    <LayoutProvider
      store={store}
      workspaceId="ws1"
      directories={DIRS}
      sessions={SESSIONS}
      hosts={HOSTS}
    >
      <TerminalGuardProvider>
        <L2View />
      </TerminalGuardProvider>
    </LayoutProvider>,
  );
  await act(async () => {
    await store.setWorkspace("ws1");
  });

  const pane = screen.getByRole("region", { name: "窗格 · Server" });
  const addTerm = async () => {
    await act(async () => {
      fireEvent.click(within(pane).getByRole("button", { name: "新建标签页" }));
    });
    const menu = await screen.findByRole("menu", { name: "新建标签页" });
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: /终端/ }));
    });
  };
  // 先把前后的值各自取出来：被复用的 DOM 元素读起来会是同一个
  const read = () => {
    const el = screen.getByTestId("probe");
    return { tid: el.dataset.tid, instance: el.dataset.instance };
  };
  await addTerm();
  const first = read();
  await addTerm();
  const second = read();

  expect(second.tid).not.toBe(first.tid);
  // 关键：是另一个实例，而不是同一个实例换了 props
  expect(second.instance).not.toBe(first.instance);

  // 切回第一个标签：同样换成一个新实例，内容对应第一个标签
  // 标签条里每个标签外面的包装带着 data-tid，里面才是 role=tab 的按钮
  const target = pane.querySelector<HTMLElement>(
    `.ws-pn-tab[data-tid="${first.tid}"] [role="tab"]`,
  );
  expect(target).toBeTruthy();
  await act(async () => {
    fireEvent.click(target as HTMLElement);
  });
  const back = read();
  expect(back.tid).toBe(first.tid);
  expect(back.instance).not.toBe(second.instance);
});
