// 工作区弹窗：新建（目录、名称、默认配置）与编辑（改名、改目录清单、移除前确认）。
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
import { WorkspaceDialog, type WorkspaceDialogProps } from "./WorkspaceDialog";

const dir = (id: string, path: string, env = "local", role = "local") => ({
  id,
  name: id,
  path,
  environmentId: env,
  role: role as "local" | "remote",
});
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
  directories: [dir("d1", "/tmp/demo")],
  sessionCount: 0,
  createdAt: "",
  updatedAt: "",
};
const NEW_WS: Workspace = {
  ...WS,
  id: "w2",
  name: "新的",
  directories: [dir("d9", "/work/new")],
};

let calls: Call[];
let onDone: Mock<(ws: Workspace, created: boolean) => void>;

beforeEach(() => {
  saveToken("tkn");
  calls = [];
  onDone = vi.fn<(ws: Workspace, created: boolean) => void>();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearToasts();
});

async function mount(
  props: Partial<WorkspaceDialogProps> = {},
  handler?: Handler,
) {
  vi.stubGlobal("fetch", fakeFetch(calls, handler));
  render(
    <>
      <WorkspaceDialog
        mode="create"
        workspaces={[]}
        onClose={() => {}}
        onDone={(ws, created) => onDone(ws, created)}
        {...props}
      />
      <ToastHost />
    </>,
  );
  await screen.findByLabelText("目录路径");
}

const row = (label: string) =>
  screen.getByRole("button", { name: new RegExp(`^${label}`) });
const done = () =>
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
const go = (name = "创建") =>
  fireEvent.click(screen.getByRole("button", { name }));
const find = (method: string, path: string) =>
  calls.find((c) => c.method === method && c.path === path);
const bodyOf = <T,>(method: string, path: string): T =>
  find(method, path)?.body as T;
const typePath = (path: string) =>
  fireEvent.change(screen.getByLabelText("目录路径"), {
    target: { value: path },
  });

const createsWorkspace: Handler = (c) =>
  c.method === "POST" && c.path === "/api/v1/workspaces"
    ? json(NEW_WS, 201)
    : undefined;

test("新建：留空的名称不提交（服务端取目录名）；默认配置全跟随时是空对象", async () => {
  await mount({}, createsWorkspace);
  expect(
    (screen.getByRole("button", { name: "创建" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  typePath("/work/new");
  expect(screen.getByPlaceholderText("new")).toBeTruthy();
  go();
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(NEW_WS, true));
  expect(find("POST", "/api/v1/workspaces")?.body).toEqual({
    directories: [{ environmentId: "local", path: "/work/new" }],
    defaults: {},
  });
});

test("这个主目录已有工作区：提示并把「创建」换成「打开」，不新建", async () => {
  await mount({ workspaces: [WS] }, createsWorkspace);
  typePath("/tmp/demo/");
  expect(screen.getByText(/已是「演示」的主目录/)).toBeTruthy();
  go("打开");
  expect(onDone).toHaveBeenCalledWith(WS, false);
  expect(find("POST", "/api/v1/workspaces")).toBeUndefined();
});

test("新会话默认配置：只写覆盖了的项；「全部跟随」清回空", async () => {
  await mount({}, createsWorkspace);
  typePath("/work/new");
  fireEvent.click(row("新会话默认"));
  choose(screen.getByLabelText("Agent"), "p-reviewer");
  choose(screen.getByLabelText("权限档位"), "full");
  done();
  expect(screen.getByText(/覆盖 2 项/)).toBeTruthy();
  go();
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(
    bodyOf<{ defaults: unknown }>("POST", "/api/v1/workspaces").defaults,
  ).toEqual({ agentPresetId: "p-reviewer", permissionTier: "full" });

  cleanup();
  calls.length = 0;
  await mount({}, createsWorkspace);
  typePath("/work/new");
  fireEvent.click(row("新会话默认"));
  choose(screen.getByLabelText("权限档位"), "full");
  done();
  fireEvent.click(screen.getByRole("button", { name: "全部跟随" }));
  go();
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
  expect(
    bodyOf<{ defaults: unknown }>("POST", "/api/v1/workspaces").defaults,
  ).toEqual({});
});

test("不是 git 仓库给一条不拦人的提示", async () => {
  await mount({}, createsWorkspace);
  typePath("/work/new");
  expect(await screen.findByText(/这里不是 git 仓库/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "创建" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

const TWO: Workspace = {
  ...WS,
  directories: [dir("d1", "/tmp/demo"), dir("d2", "/srv/x", "gpu", "remote")],
};
const impact = {
  id: "d2",
  name: "gpu 上的 x",
  path: "/srv/x",
  environmentId: "gpu",
  removed: true,
  rules: 2,
  hooks: 0,
};
const dirsApi =
  (removed: unknown[]): Handler =>
  (c) => {
    if (c.method === "PUT" && c.path === "/api/v1/workspaces/w1/directories")
      return (c.body as { dryRun?: boolean }).dryRun
        ? json({ added: [], removed })
        : json(WS);
    if (c.method === "PATCH" && c.path === "/api/v1/workspaces/w1")
      return json({ ...TWO, name: "改过" });
    return undefined;
  };

test("编辑：移除附加目录前先列出会连带删掉什么，确认后才真正提交", async () => {
  await mount({ mode: "edit", workspace: TWO }, dirsApi([impact]));
  expect((screen.getByLabelText("目录路径") as HTMLInputElement).disabled).toBe(
    true,
  );
  fireEvent.click(row("附加目录"));
  fireEvent.click(screen.getByRole("button", { name: "移除这个目录" }));
  done();
  go("保存");
  expect(await screen.findByText(/2 条规则/)).toBeTruthy();
  expect(
    calls.some(
      (c) => c.method === "PUT" && !(c.body as { dryRun?: boolean }).dryRun,
    ),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "移除并保存" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(WS, false));
  const put = calls.filter((c) => c.method === "PUT");
  expect(put.map((c) => (c.body as { dryRun?: boolean }).dryRun)).toEqual([
    true,
    undefined,
  ]);
  expect(
    (put[1] as { body: { directories: unknown[] } }).body.directories,
  ).toEqual([{ environmentId: "local", path: "/tmp/demo" }]);
});

test("编辑：新增目录、没有东西会被删时不打断；名称变了才 PATCH", async () => {
  await mount({ mode: "edit", workspace: WS }, dirsApi([]));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "改过" },
  });
  fireEvent.click(row("附加目录"));
  fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
  // 二级页里只有附加目录的行
  fireEvent.change(screen.getByLabelText("目录路径"), {
    target: { value: "/srv/y" },
  });
  done();
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(find("PATCH", "/api/v1/workspaces/w1")?.body).toEqual({
    name: "改过",
  });
  expect(screen.queryByText("移除并保存")).toBeNull();
});

test("编辑：只改了描述就只发描述；什么都没改不发 PATCH", async () => {
  await mount({ mode: "edit", workspace: WS }, dirsApi([]));
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(WS, false));
  expect(find("PATCH", "/api/v1/workspaces/w1")).toBeUndefined();
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
  cleanup();
  calls.length = 0;

  await mount({ mode: "edit", workspace: WS }, dirsApi([]));
  fireEvent.change(screen.getByLabelText("描述（可选）"), {
    target: { value: "备注" },
  });
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
  expect(find("PATCH", "/api/v1/workspaces/w1")?.body).toEqual({
    description: "备注",
  });
});

// ---- 审核要求：「模型」档下审批模型的判别准则，对这个工作区追加或覆盖 ----

test("审核要求：只在编辑时出现；没写就是跟随全局，写了再保存只发 reviewPolicy", async () => {
  await mount({}, createsWorkspace);
  expect(screen.queryByRole("button", { name: /^审核要求/ })).toBeNull();
  cleanup();

  await mount({ mode: "edit", workspace: WS }, dirsApi([]));
  expect(row("审核要求").textContent).toContain("跟随全局");
  fireEvent.click(row("审核要求"));
  fireEvent.click(screen.getByRole("radio", { name: "覆盖" }));
  fireEvent.change(screen.getByLabelText("这个工作区的要求"), {
    target: { value: "  只许改 docs/ 下的文件  " },
  });
  done();
  expect(row("审核要求").textContent).toContain("覆盖 · 只许改 docs/ 下的文件");
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(find("PATCH", "/api/v1/workspaces/w1")?.body).toEqual({
    reviewPolicy: { mode: "override", text: "只许改 docs/ 下的文件" },
  });
});

test("审核要求：「跟随全局」只清掉文字；原来就有要求、没动它时不发 reviewPolicy", async () => {
  const withPolicy: Workspace = {
    ...WS,
    reviewPolicy: { mode: "append", text: "禁止联网" },
  };
  await mount({ mode: "edit", workspace: withPolicy }, dirsApi([]));
  expect(row("审核要求").textContent).toContain("追加 · 禁止联网");
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(find("PATCH", "/api/v1/workspaces/w1")).toBeUndefined();
  cleanup();

  await mount({ mode: "edit", workspace: withPolicy }, dirsApi([]));
  fireEvent.click(screen.getByRole("button", { name: "跟随全局" }));
  expect(row("审核要求").textContent).toContain("跟随全局");
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
  expect(find("PATCH", "/api/v1/workspaces/w1")?.body).toEqual({
    reviewPolicy: { mode: "append", text: "" },
  });
});

// ---- 隐私变量：这个工作区启用哪些（按变量组三态勾选） ----

const pv = (
  id: string,
  group: string | null,
  over: Record<string, unknown> = {},
) => ({
  id,
  name: id,
  desc: `${id} 的描述`,
  group,
  workspaces: [],
  kind: "text",
  maskable: true,
  policy: "ask",
  expiry: { kind: "never" },
  expired: false,
  owner: "user",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});
const VARS = [
  pv("gl", "Git 权限"),
  pv("gh", "Git 权限"),
  pv("dk", "Git 权限"),
  pv("aws", "云服务"),
  pv("hf", null, { policy: "allow" }),
];
const withVars =
  (enabled: string[], then?: Handler): Handler =>
  (c) => {
    if (c.method === "GET" && c.path === "/api/v1/variables")
      return json({ variables: VARS });
    if (c.method === "GET" && c.path === "/api/v1/workspaces/w1/variables")
      return json({ variables: enabled });
    return then?.(c);
  };
const putsVars =
  (id: string): Handler =>
  (c) =>
    c.method === "PUT" && c.path === `/api/v1/workspaces/${id}/variables`
      ? json({ variables: (c.body as { variables: string[] }).variables })
      : undefined;
const group = (name: string) =>
  screen.getByRole("checkbox", { name: new RegExp(`^${name}`) });

test("隐私变量：默认都不启用；点进二级页，勾组 = 勾上组里现有的全部，展开后可单独取消；创建后再写启用清单", async () => {
  await mount(
    {},
    withVars([], (c) => createsWorkspace(c) ?? putsVars("w2")(c)),
  );
  typePath("/work/new");
  expect(row("隐私变量").textContent).toContain("都不启用");
  expect(row("隐私变量").textContent).toContain("默认");
  fireEvent.click(row("隐私变量"));
  expect(screen.getByText("已启用 0 / 5")).toBeTruthy();

  fireEvent.click(group("Git 权限"));
  expect(screen.getByText("已启用 3 / 5")).toBeTruthy();
  expect(group("Git 权限").getAttribute("aria-checked")).toBe("true");
  // 全勾的组默认折叠；展开后单独取消一个 → 组变半选，且保持展开
  fireEvent.click(screen.getByRole("button", { name: "展开 Git 权限" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /^dk/ }));
  expect(group("Git 权限").getAttribute("aria-checked")).toBe("mixed");
  expect(screen.getByRole("checkbox", { name: /^gl/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "展开 未分组" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /^hf/ }));
  done();
  expect(row("隐私变量").textContent).toContain("已启用 3 个");
  expect(row("隐私变量").textContent).toContain("共 5 个可选");

  go();
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(onDone).toHaveBeenCalledWith(NEW_WS, true);
  expect(bodyOf("PUT", "/api/v1/workspaces/w2/variables")).toEqual({
    variables: ["gh", "gl", "hf"],
  });
  const order = calls.map((c) => `${c.method} ${c.path}`);
  expect(order.indexOf("POST /api/v1/workspaces")).toBeLessThan(
    order.indexOf("PUT /api/v1/workspaces/w2/variables"),
  );
});

test("隐私变量：没勾任何变量时创建不发启用清单的请求", async () => {
  await mount({}, withVars([], createsWorkspace));
  typePath("/work/new");
  go();
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(find("PUT", "/api/v1/workspaces/w2/variables")).toBeUndefined();
});

test("隐私变量：编辑时预填已启用的；不改不发请求，改了整份替换；「全部关闭」一键清空", async () => {
  await mount(
    { mode: "edit", workspace: WS, workspaces: [WS] },
    withVars(["gl", "hf"], putsVars("w1")),
  );
  expect(row("隐私变量").textContent).toContain("已启用 2 个");
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(WS, false));
  expect(find("PUT", "/api/v1/workspaces/w1/variables")).toBeUndefined();

  // 弹窗由调用方关；再来一次要重新挂载
  cleanup();
  calls.length = 0;
  onDone.mockClear();
  await mount(
    { mode: "edit", workspace: WS, workspaces: [WS] },
    withVars(["gl", "hf"], putsVars("w1")),
  );
  fireEvent.click(row("隐私变量"));
  fireEvent.click(group("Git 权限"));
  done();
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(bodyOf("PUT", "/api/v1/workspaces/w1/variables")).toEqual({
    variables: ["dk", "gh", "gl", "hf"],
  });
});

test("隐私变量：全部关闭 → 保存时发空清单", async () => {
  await mount(
    { mode: "edit", workspace: WS, workspaces: [WS] },
    withVars(["gl"], putsVars("w1")),
  );
  fireEvent.click(screen.getByRole("button", { name: "全部关闭" }));
  expect(row("隐私变量").textContent).toContain("都不启用");
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(bodyOf("PUT", "/api/v1/workspaces/w1/variables")).toEqual({
    variables: [],
  });
});

test("隐私变量：启用清单保存失败时弹窗留着并提示这一步，不当成整体成功", async () => {
  await mount(
    {},
    withVars(
      [],
      (c) =>
        createsWorkspace(c) ??
        (c.method === "PUT" && c.path.endsWith("/variables")
          ? json({ error: "invalid_variable" }, 400)
          : undefined),
    ),
  );
  typePath("/work/new");
  fireEvent.click(row("隐私变量"));
  fireEvent.click(group("云服务"));
  done();
  go();
  expect(await screen.findByText(/隐私变量没有保存/)).toBeTruthy();
  expect(onDone).not.toHaveBeenCalled();
});

test("隐私变量：变量读不到时这一行只说「还没有隐私变量」，保存不会发覆盖请求", async () => {
  await mount({ mode: "edit", workspace: WS, workspaces: [WS] });
  expect(row("隐私变量").textContent).toContain("还没有隐私变量");
  fireEvent.click(row("隐私变量"));
  expect(screen.getByText(/先在「设置 · 隐私变量」里添加/)).toBeTruthy();
  done();
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(find("PUT", "/api/v1/workspaces/w1/variables")).toBeUndefined();
});

test("隐私变量：搜索时自动展开命中的组；没有命中给出提示", async () => {
  await mount({}, withVars([]));
  fireEvent.click(row("隐私变量"));
  const box = screen.getByRole("textbox", { name: "筛选变量" });
  fireEvent.change(box, { target: { value: "aws" } });
  expect(screen.getByRole("checkbox", { name: /^aws/ })).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: /^gl/ })).toBeNull();
  fireEvent.change(box, { target: { value: "没有这个" } });
  expect(screen.getByText("没有匹配的变量")).toBeTruthy();
});

// ---- 项目 AGENTS.md：创建时选一个模板写进主目录 ----

const TPL = (id: string, name: string, description = "") => ({
  id,
  kind: "project-agentsmd",
  name,
  description,
  active: false,
  capabilities: null,
  capsAdd: [],
  capsRemove: [],
  updatedAt: "2026-11-06T00:00:00Z",
});
const withTemplates =
  (then?: Handler): Handler =>
  (c) => {
    if (
      c.method === "GET" &&
      c.path === "/api/v1/studio/presets" &&
      c.url.searchParams.get("kind") === "project-agentsmd"
    )
      return json({
        presets: [
          TPL("t1", "前端模板", "React + Tailwind"),
          TPL("t2", "后端模板"),
        ],
      });
    return then?.(c);
  };
const writes =
  (result: Response | ((n: number) => Response)): Handler =>
  (c) => {
    if (c.method === "POST" && c.path === "/api/v1/workspaces/w2/agents-md") {
      const n = calls.filter((x) => x.path === c.path).length;
      return typeof result === "function" ? result(n) : result;
    }
    return undefined;
  };
const pickTemplate = (name: string) => {
  fireEvent.click(row("项目 AGENTS.md"));
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
  done();
};

test("项目 AGENTS.md：默认不使用，不发写入请求；没有模板时说明还没有", async () => {
  await mount({}, withTemplates(createsWorkspace));
  typePath("/work/new");
  expect(row("项目 AGENTS.md").textContent).toContain("不使用");
  go();
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(NEW_WS, true));
  expect(find("POST", "/api/v1/workspaces/w2/agents-md")).toBeUndefined();
  cleanup();
  await mount({}, createsWorkspace);
  expect(row("项目 AGENTS.md").textContent).toContain("还没有模板");
});

test("项目 AGENTS.md：选了模板，创建工作区后再写进主目录；写入后才算完成", async () => {
  await mount(
    {},
    withTemplates(
      (c) =>
        createsWorkspace(c) ??
        writes(json({ written: true, path: "/work/new/AGENTS.md" }))(c),
    ),
  );
  typePath("/work/new");
  pickTemplate("前端模板");
  expect(row("项目 AGENTS.md").textContent).toContain("前端模板");
  go();
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(NEW_WS, true));
  expect(bodyOf("POST", "/api/v1/workspaces/w2/agents-md")).toEqual({
    presetId: "t1",
  });
  const order = calls.map((c) => `${c.method} ${c.path}`);
  expect(order.indexOf("POST /api/v1/workspaces")).toBeLessThan(
    order.indexOf("POST /api/v1/workspaces/w2/agents-md"),
  );
});

test("项目 AGENTS.md：主目录里已有文件时先问，选追加就带 append 重发", async () => {
  await mount(
    {},
    withTemplates(
      (c) =>
        createsWorkspace(c) ??
        writes((n) =>
          n === 1
            ? json({ error: "file_exists" }, 409)
            : json({ written: true, path: "/work/new/AGENTS.md" }),
        )(c),
    ),
  );
  typePath("/work/new");
  pickTemplate("前端模板");
  go();
  await screen.findByText(/主目录里已经有一个 AGENTS.md/);
  expect(onDone).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "追加到末尾" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(NEW_WS, true));
  const bodies = calls
    .filter((c) => c.path === "/api/v1/workspaces/w2/agents-md")
    .map((c) => c.body);
  expect(bodies).toEqual([
    { presetId: "t1" },
    { presetId: "t1", mode: "append" },
  ]);
});

test("项目 AGENTS.md：已有文件时选「不写入」就保持原样直接完成，选「覆盖」带 overwrite", async () => {
  const exists = writes((n) =>
    n === 1
      ? json({ error: "file_exists" }, 409)
      : json({ written: true, path: "/work/new/AGENTS.md" }),
  );
  await mount(
    {},
    withTemplates((c) => createsWorkspace(c) ?? exists(c)),
  );
  typePath("/work/new");
  pickTemplate("后端模板");
  go();
  await screen.findByText(/主目录里已经有一个 AGENTS.md/);
  fireEvent.click(screen.getByRole("button", { name: "不写入" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(NEW_WS, true));
  expect(
    calls.filter((c) => c.path === "/api/v1/workspaces/w2/agents-md"),
  ).toHaveLength(1);

  cleanup();
  calls.length = 0;
  onDone.mockClear();
  await mount(
    {},
    withTemplates((c) => createsWorkspace(c) ?? exists(c)),
  );
  typePath("/work/new");
  pickTemplate("后端模板");
  go();
  await screen.findByText(/主目录里已经有一个 AGENTS.md/);
  fireEvent.click(screen.getByRole("button", { name: "覆盖" }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(
    calls.filter((c) => c.path === "/api/v1/workspaces/w2/agents-md")[1]?.body,
  ).toEqual({ presetId: "t2", mode: "overwrite" });
});

test("项目 AGENTS.md：写入失败时弹窗留着并提示这一步；编辑工作区没有这一行", async () => {
  await mount(
    {},
    withTemplates(
      (c) => createsWorkspace(c) ?? writes(json({ error: "boom" }, 500))(c),
    ),
  );
  typePath("/work/new");
  pickTemplate("前端模板");
  go();
  await screen.findByText(/项目 AGENTS.md 没有写入/);
  expect(onDone).not.toHaveBeenCalled();
  cleanup();
  await mount({ mode: "edit", workspace: WS }, withTemplates());
  expect(screen.queryByRole("button", { name: /^项目 AGENTS.md/ })).toBeNull();
});

const SKILLS = [
  {
    name: "sql-notes",
    description: "数据分析",
    scope: "global",
    enabled: true,
  },
  { name: "deploy", description: "发布流程", scope: "project", enabled: true },
  { name: "old-one", description: "旧技能", scope: "project", enabled: false },
];
const MCPS = [
  { name: "warehouse", description: "数仓", global: true, enabled: true },
  { name: "browser", description: "浏览器", global: false, enabled: true },
];
const withCaps =
  (picked: { skill: string[]; mcp: string[] }, then?: Handler): Handler =>
  (c) => {
    if (c.method === "GET" && c.path === "/api/v1/skills")
      return json({ skills: SKILLS });
    if (c.method === "GET" && c.path === "/api/v1/mcp")
      return json({ servers: MCPS });
    if (c.method === "GET" && c.path === "/api/v1/workspaces/w1/capabilities")
      return json(picked);
    return then?.(c);
  };
const putsCaps =
  (id: string): Handler =>
  (c) =>
    c.method === "PUT" && c.path === `/api/v1/workspaces/${id}/capabilities`
      ? json(c.body)
      : undefined;
const box = (name: string) =>
  screen.getByRole("checkbox", { name: new RegExp(`^${name}`) });

test("技能与 MCP：全局的显示成已勾选且不可改，其余勾给工作区；创建后再写勾选", async () => {
  await mount(
    {},
    withCaps(
      { skill: [], mcp: [] },
      (c) => createsWorkspace(c) ?? putsCaps("w2")(c),
    ),
  );
  typePath("/work/new");
  expect(row("技能与 MCP").textContent).toContain("都不额外启用");
  expect(row("技能与 MCP").textContent).toContain("另有 2 项全局");
  fireEvent.click(row("技能与 MCP"));
  expect(box("sql-notes").getAttribute("aria-checked")).toBe("true");
  expect((box("sql-notes") as HTMLButtonElement).disabled).toBe(true);
  expect(box("deploy").getAttribute("aria-checked")).toBe("false");
  fireEvent.click(box("deploy"));
  fireEvent.click(box("browser"));
  done();
  expect(row("技能与 MCP").textContent).toContain("已勾选 2 项");

  go();
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(NEW_WS, true));
  expect(bodyOf("PUT", "/api/v1/workspaces/w2/capabilities")).toEqual({
    skill: ["deploy"],
    mcp: ["browser"],
  });
  const order = calls.map((c) => `${c.method} ${c.path}`);
  expect(order.indexOf("POST /api/v1/workspaces")).toBeLessThan(
    order.indexOf("PUT /api/v1/workspaces/w2/capabilities"),
  );
});

test("技能与 MCP：没勾任何项时创建不发勾选请求；读不到清单也不发覆盖请求", async () => {
  await mount({}, withCaps({ skill: [], mcp: [] }, createsWorkspace));
  typePath("/work/new");
  go();
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(find("PUT", "/api/v1/workspaces/w2/capabilities")).toBeUndefined();

  cleanup();
  calls.length = 0;
  onDone.mockClear();
  await mount({ mode: "edit", workspace: WS, workspaces: [WS] });
  expect(row("技能与 MCP").textContent).toContain("还没有技能或 MCP");
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(find("PUT", "/api/v1/workspaces/w1/capabilities")).toBeUndefined();
});

test("技能与 MCP：编辑时预填已勾选的；不改不发请求，改了整份替换，「全部取消」发空清单", async () => {
  const picked = { skill: ["deploy"], mcp: [] };
  await mount(
    { mode: "edit", workspace: WS, workspaces: [WS] },
    withCaps(picked, putsCaps("w1")),
  );
  expect(row("技能与 MCP").textContent).toContain("已勾选 1 项");
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(WS, false));
  expect(find("PUT", "/api/v1/workspaces/w1/capabilities")).toBeUndefined();

  cleanup();
  calls.length = 0;
  onDone.mockClear();
  await mount(
    { mode: "edit", workspace: WS, workspaces: [WS] },
    withCaps(picked, putsCaps("w1")),
  );
  fireEvent.click(row("技能与 MCP"));
  expect(box("deploy").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(box("browser"));
  done();
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(bodyOf("PUT", "/api/v1/workspaces/w1/capabilities")).toEqual({
    skill: ["deploy"],
    mcp: ["browser"],
  });

  cleanup();
  calls.length = 0;
  onDone.mockClear();
  await mount(
    { mode: "edit", workspace: WS, workspaces: [WS] },
    withCaps(picked, putsCaps("w1")),
  );
  fireEvent.click(screen.getByRole("button", { name: "全部取消" }));
  go("保存");
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(bodyOf("PUT", "/api/v1/workspaces/w1/capabilities")).toEqual({
    skill: [],
    mcp: [],
  });
});

test("技能与 MCP：勾选保存失败时弹窗留着并提示这一步，不当成整体成功", async () => {
  await mount(
    {},
    withCaps(
      { skill: [], mcp: [] },
      (c) =>
        createsWorkspace(c) ??
        (c.method === "PUT" && c.path.endsWith("/capabilities")
          ? json({ error: "unknown_skill" }, 400)
          : undefined),
    ),
  );
  typePath("/work/new");
  fireEvent.click(row("技能与 MCP"));
  fireEvent.click(box("deploy"));
  done();
  go();
  expect(await screen.findByText(/勾选没有保存/)).toBeTruthy();
  expect(onDone).not.toHaveBeenCalled();
});
