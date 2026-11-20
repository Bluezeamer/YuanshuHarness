// 会话弹窗：按工作区默认起步、摘要行进二级页、提交体、编辑只发有变化的部分、版本冲突。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, type Mock, test, vi } from "vitest";
import { saveToken } from "../../../api/http";
import type { Workspace } from "../../../api/workspaces";
import {
  type Call,
  fakeFetch,
  type Handler,
  json,
} from "../../../test/dialogsServer";
import { choose } from "../../../test/select";
import { clearToasts, ToastHost } from "../../../ui";
import { SessionDialog, type SessionDialogProps } from "./SessionDialog";

const WS: Workspace = {
  id: "w1",
  name: "演示",
  description: "",
  groupId: null,
  archived: false,
  pinned: false,
  order: 1,
  defaults: {},
  reviewPolicy: { mode: "append", text: "" },
  directories: [
    {
      id: "d1",
      name: "demo",
      path: "/tmp/demo",
      environmentId: "local",
      role: "local",
    },
  ],
  sessionCount: 0,
  createdAt: "",
  updatedAt: "",
};

let calls: Call[];
let onDone: Mock<(id: string) => void>;

beforeEach(() => {
  saveToken("tkn");
  calls = [];
  onDone = vi.fn<(id: string) => void>();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearToasts();
});

async function mount(
  props: Partial<SessionDialogProps> & { workspace?: Workspace } = {},
  handler?: Handler,
) {
  vi.stubGlobal("fetch", fakeFetch(calls, handler));
  render(
    <>
      <SessionDialog
        mode="create"
        workspace={WS}
        onClose={() => {}}
        onDone={(id) => onDone(id)}
        {...props}
      />
      <ToastHost />
    </>,
  );
  await screen.findByLabelText("名称");
}

const row = (label: string) =>
  screen.getByRole("button", { name: new RegExp(`^${label}`) });
const done = () =>
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
const go = (name = "创建") =>
  fireEvent.click(screen.getByRole("button", { name }));
const find = (method: string, path: string) =>
  calls.find((c) => c.method === method && c.path === path);

type CreateBody = {
  workspaceId?: string;
  promptPresetId?: string;
  modePresetIds?: string[];
  directoryIds?: string[];
  projectPresetId?: string;
  config: {
    model: unknown;
    capabilities: string[] | null;
    permissionTier: string | null;
  };
};
const createBody = () => find("POST", "/api/v1/sessions")?.body as CreateBody;

const created: Handler = (c) =>
  c.method === "POST" && c.path === "/api/v1/sessions"
    ? json({ id: "s1" }, 201)
    : c.method === "PATCH" && c.path === "/api/v1/sessions/s1"
      ? json({})
      : undefined;

test("按工作区默认配置起步；提交体带 workspaceId，不带目录与项目约定", async () => {
  await mount(
    {
      workspace: {
        ...WS,
        defaults: {
          agentPresetId: "p-reviewer",
          modePresetIds: ["p-mode"],
          permissionTier: "full",
        },
      },
    },
    created,
  );
  go();
  await waitFor(() => expect(onDone).toHaveBeenCalledWith("s1"));
  const body = createBody();
  expect(body.workspaceId).toBe("w1");
  expect(body.promptPresetId).toBe("p-reviewer");
  expect(body.modePresetIds).toEqual(["p-mode"]);
  expect(body.config.capabilities).toEqual(["tool:read", "tool:grep"]);
  expect(body.config.permissionTier).toBe("full");
  expect(body.config.model).toEqual({ mode: "follow-default" });
  expect(body).not.toHaveProperty("directoryIds");
  expect(body).not.toHaveProperty("projectPresetId");
});

test("名称可以留空：不去写名字；填了才写", async () => {
  await mount({}, created);
  go();
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(find("PATCH", "/api/v1/sessions/s1")).toBeUndefined();
  cleanup();
  calls.length = 0;
  onDone.mockClear();

  await mount({}, created);
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "试一下" },
  });
  go();
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(find("PATCH", "/api/v1/sessions/s1")?.body).toEqual({
    title: "试一下",
  });
});

test("权限、模式、模型从摘要行进二级页改，完成后回到主页并写进提交体", async () => {
  await mount({}, created);
  fireEvent.click(row("权限"));
  choose(screen.getByLabelText("权限档位"), "full");
  done();
  fireEvent.click(row("模式"));
  fireEvent.click(screen.getByRole("checkbox", { name: /plan/ }));
  done();
  fireEvent.click(row("模型"));
  fireEvent.click(screen.getByRole("radio", { name: "指定模型" }));
  done();
  go();
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  const body = createBody();
  expect(body.config.permissionTier).toBe("full");
  expect(body.modePresetIds).toEqual(["p-mode"]);
  expect(body.config.model).toEqual({
    mode: "explicit",
    provider: "prov",
    model: "m1",
    reasoning: "off",
  });
});

test("换 Agent 后能力回到新 Agent 的基线", async () => {
  await mount({}, created);
  choose(screen.getByLabelText("Agent"), "p-reviewer");
  go();
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(createBody().config.capabilities).toEqual(["tool:read", "tool:grep"]);
});

test("工作区默认里的模型已不在已连接的供应商里：提示并拦住创建", async () => {
  await mount({
    workspace: {
      ...WS,
      defaults: { model: { provider: "gone", model: "x", reasoning: "low" } },
    },
  });
  expect(screen.getByText(/指定的模型不在已连接的供应商里/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "创建" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("⌘/Ctrl+Enter 也能提交；但模型有问题时同样被拦住", async () => {
  await mount({}, created);
  fireEvent.keyDown(screen.getByLabelText("名称"), {
    key: "Enter",
    ctrlKey: true,
  });
  await waitFor(() => expect(onDone).toHaveBeenCalledWith("s1"));
  cleanup();
  calls.length = 0;
  onDone.mockClear();

  await mount(
    {
      workspace: {
        ...WS,
        defaults: { model: { provider: "gone", model: "x", reasoning: "low" } },
      },
    },
    created,
  );
  fireEvent.keyDown(screen.getByLabelText("名称"), {
    key: "Enter",
    ctrlKey: true,
  });
  expect(find("POST", "/api/v1/sessions")).toBeUndefined();
});

const config = (rev: number, tier: string | null = null) => ({
  sessionId: "s9",
  model: { mode: "follow-default" },
  capabilities: null,
  permissionTier: tier,
  rev,
});
const editing: Handler = (c) => {
  if (c.method === "GET" && c.path === "/api/v1/sessions/s9/config")
    return json(config(3));
  if (c.method === "GET" && c.path === "/api/v1/sessions/s9")
    return json({
      title: "旧名",
      promptPresetId: "p-agent",
      modePresetIds: [],
    });
  return undefined;
};

test("编辑：Agent 不能换；只提交有变化的配置分区，带着载入时的版本号", async () => {
  await mount(
    { mode: "edit", sessionId: "s9" },
    (c) =>
      editing(c) ??
      (c.method === "PATCH" && c.path === "/api/v1/sessions/s9/config"
        ? json({ config: config(4, "full"), appliedAt: "now" })
        : undefined),
  );
  expect((screen.getByLabelText("Agent") as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "旧名",
  );
  fireEvent.click(row("权限"));
  choose(screen.getByLabelText("权限档位"), "full");
  done();
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalledWith("s9"));
  expect(find("PATCH", "/api/v1/sessions/s9/config")?.body).toEqual({
    baseRev: 3,
    patch: { permissionTier: "full" },
  });
  expect(find("PUT", "/api/v1/sessions/s9/modes")).toBeUndefined();
  expect(find("PATCH", "/api/v1/sessions/s9")).toBeUndefined();
});

test("编辑时配置已被别处改过：让用户选，覆盖就用服务端当前版本号重发", async () => {
  let n = 0;
  await mount({ mode: "edit", sessionId: "s9" }, (c) => {
    const e = editing(c);
    if (e) return e;
    if (c.method === "PATCH" && c.path === "/api/v1/sessions/s9/config") {
      n += 1;
      return n === 1
        ? json({ error: "conflict", current: config(5, "auto") }, 409)
        : json({ config: config(6, "full"), appliedAt: "now" });
    }
    return undefined;
  });
  fireEvent.click(row("权限"));
  choose(screen.getByLabelText("权限档位"), "full");
  done();
  go("保存");
  fireEvent.click(await screen.findByRole("button", { name: "覆盖" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith("s9"));
  const patches = calls.filter(
    (c) => c.method === "PATCH" && c.path === "/api/v1/sessions/s9/config",
  );
  expect(patches.map((p) => (p.body as { baseRev: number }).baseRev)).toEqual([
    3, 5,
  ]);
});
