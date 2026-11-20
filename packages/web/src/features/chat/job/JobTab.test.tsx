import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { JobSnapshot } from "../../../api";
import {
  LayoutProvider,
  useLayoutState,
  useLayoutStore,
} from "../../workspace/layoutContext";
import { panesOf } from "../../workspace/model/l2";
import {
  LAYOUT_VERSION,
  type LayoutDoc,
} from "../../workspace/model/layoutDoc";
import { createLayoutStore } from "../../workspace/store/layoutStore";
import { getTabDef } from "../../workspace/tabs/registry";
import { registerSubTab } from "../exec";
import { registerJobTab } from "./JobTab";
import { forgetJobs, jobName } from "./names";
import { useOpenJob } from "./useOpenJob";

beforeEach(() => forgetJobs());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DIRS = [{ host: "server", path: "/w" }];
const sessions = [
  { id: "s1", updatedAt: "2026-01-01T00:00:00.000Z", archived: false },
];
const DOC: LayoutDoc = {
  version: LAYOUT_VERSION,
  windows: {
    list: [
      {
        id: "w1",
        name: "窗口 1",
        root: {
          pane: {
            pid: "p1",
            host: null,
            tabs: [{ id: "t1", type: "chat", ctab: "chat", sid: "s1" }],
            active: "t1",
          },
        },
        active: "p1",
      },
    ],
    active: 0,
  },
} as never;

const job = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id: "j1",
  kind: "command",
  name: "bash",
  label: "npm run build",
  ref: null,
  state: "done",
  exitCode: 0,
  startedAt: "2026-11-17T08:00:00.000Z",
  endedAt: "2026-11-17T08:01:00.000Z",
  ...over,
});

function Probe({ jobs }: { jobs: Record<string, JobSnapshot> }) {
  const store = useLayoutStore();
  const win = useLayoutState((s) => s.doc.windows).list[0];
  const first = win ? panesOf(win)[0] : undefined;
  const open = useOpenJob("s1", first?.pid ?? "");
  const tabs = win
    ? panesOf(win).flatMap((p) =>
        p.tabs
          .filter((t) => t.type === "job" || t.type === "sub")
          .map((t) => `${t.type}:${t.job ?? t.sub}`),
      )
    : [];
  return (
    <div>
      <output aria-label="tabs">{tabs.join(",")}</output>
      <output aria-label="active">
        {first?.tabs.find((t) => t.id === first.active)?.type}
      </output>
      {Object.entries(jobs).map(([k, j]) => (
        <button key={k} type="button" onClick={() => open(j)}>
          开{k}
        </button>
      ))}
      <button
        type="button"
        onClick={() =>
          first && store.activateTab(first.pid, first.tabs[0]?.id ?? "")
        }
      >
        回首个
      </button>
    </div>
  );
}

async function mount(jobs: Record<string, JobSnapshot>) {
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
      directories={DIRS}
      sessions={sessions}
      hosts={[{ id: "server", name: "Server" }]}
    >
      <Probe jobs={jobs} />
    </LayoutProvider>,
  );
  await act(async () => {
    await store.setWorkspace("ws1");
  });
  return store;
}
const tabs = () => screen.getByLabelText("tabs").textContent;

test("点命令任务：开 job 标签，同一任务只开一个，再点只激活它；标题立刻取到任务简述", async () => {
  const j = job();
  const store = await mount({ a: j, b: job({ id: "j2" }) });
  fireEvent.click(screen.getByText("开a"));
  expect(tabs()).toBe("job:j1");
  expect(jobName("j1")).toBe("npm run build");
  const win = store.getState().doc.windows.list[0];
  const tab =
    win &&
    panesOf(win)
      .flatMap((p) => p.tabs)
      .find((t) => t.type === "job");
  expect(tab).toMatchObject({ type: "job", sid: "s1", job: "j1" });
  expect(tab?.host).toBeUndefined();
  fireEvent.click(screen.getByText("回首个"));
  expect(screen.getByLabelText("active").textContent).toBe("chat");
  fireEvent.click(screen.getByText("开a"));
  expect(tabs()).toBe("job:j1");
  expect(screen.getByLabelText("active").textContent).toBe("job");
  fireEvent.click(screen.getByText("开b"));
  expect(tabs()).toBe("job:j1,job:j2");
});

test("点子代理 / 团队成员的任务：去它们的执行体标签，不开 job 标签", async () => {
  await mount({
    s: job({
      id: "j9",
      kind: "subagent",
      name: "spawn_subagent",
      ref: "child-1",
    }),
  });
  fireEvent.click(screen.getByText("开s"));
  expect(tabs()).toBe("sub:child-1");
});

test("registerJobTab：标题取任务简述，取不到退回「后台任务」；没有任务 id 不渲染", () => {
  registerSubTab();
  registerJobTab();
  const def = getTabDef("job");
  expect(def.title({ id: "t", type: "job", sid: "s1", job: "jx" })).toBe(
    "后台任务",
  );
  expect(def.title({ id: "t", type: "job" })).toBe("后台任务");
  const tab = { id: "t1", type: "job" as const, sid: "s1" };
  const { container } = render(
    <>
      {def.render({
        tab,
        pane: { pid: "p1", host: null, tabs: [tab], active: "t1" },
        sessionId: "s1",
        active: true,
        patchTab: () => {},
        patchAfx: () => {},
        close: () => {},
      })}
    </>,
  );
  expect(container.firstChild).toBeNull();
});
