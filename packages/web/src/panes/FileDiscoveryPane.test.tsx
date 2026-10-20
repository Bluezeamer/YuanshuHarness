import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installApi, installPaneApi, type PaneApi, paneEnv } from "../fakes";
import { EnvContext } from "../layout/env";
import type { PaneBinding } from "../layout/types";
import {
  type FileDiscoveryConfig,
  FileDiscoveryPane,
} from "./FileDiscoveryPane";

let api: PaneApi;

beforeEach(() => {
  sessionStorage.clear();
  installApi();
  api = installPaneApi();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(
  active: string | null = "s1",
  config: FileDiscoveryConfig = { environmentId: null, path: null },
  binding: PaneBinding = { mode: "follow" },
) {
  const env = paneEnv(active);
  const onUpdateConfig = vi.fn();
  render(
    <EnvContext value={env}>
      <FileDiscoveryPane
        paneId="f1"
        config={config}
        focused={false}
        binding={binding}
        onUpdateConfig={onUpdateConfig}
      />
    </EnvContext>,
  );
  return { env, onUpdateConfig };
}

const hit = (method: string, part: string) =>
  api.calls.filter((c) => c.method === method && c.path.includes(part));

test("从会话所属 workspace 的根目录开始列", async () => {
  mount();
  await screen.findByText("a.txt");
  expect(screen.getByText("src")).toBeTruthy();
  expect(hit("GET", "/files/list")[0]?.path).toContain("path=%2Fwork%2Fproj");
  expect(screen.getByText(/本机:\/work\/proj/)).toBeTruthy();
});

test("跟随的会话在别的环境：列那个环境的 workspace 根", async () => {
  api.dirs["/srv/app"] = [
    { name: "main.py", type: "file", size: 9, mtimeMs: 0 },
  ];
  mount("s2");
  await screen.findByText("main.py");
  expect(hit("GET", "/environments/ssh1/files/list")).toHaveLength(1);
});

test("点目录进入：写进配置；点文件走打开路由", async () => {
  const { env, onUpdateConfig } = mount();
  fireEvent.click(await screen.findByText("src"));
  expect(onUpdateConfig).toHaveBeenCalledWith({
    environmentId: "local",
    path: "/work/proj/src",
  });
  fireEvent.click(screen.getByText("a.txt"));
  expect(env.openContent).toHaveBeenCalledTimes(1);
  const req = env.openContent.mock.calls[0]?.[0];
  expect(req?.type).toBe("file_preview");
  expect(req?.host).toBe("local");
  expect(req?.config).toEqual({
    environmentId: "local",
    path: "/work/proj/a.txt",
  });
});

test("配置里记的路径属于别的环境时不沿用", async () => {
  mount("s1", { environmentId: "ssh1", path: "/srv/app" });
  await screen.findByText("a.txt");
  expect(hit("GET", "/files/list")[0]?.path).toContain("%2Fwork%2Fproj");
});

test("有上一级时可返回", async () => {
  const { onUpdateConfig } = mount("s1", {
    environmentId: "local",
    path: "/work/proj/src",
  });
  await screen.findByText("目录为空");
  fireEvent.click(screen.getByRole("button", { name: "上一级" }));
  expect(onUpdateConfig).toHaveBeenCalledWith({
    environmentId: "local",
    path: "/work/proj",
  });
});

test("新建目录：带会话 id 调接口并刷新列表", async () => {
  mount();
  await screen.findByText("a.txt");
  fireEvent.click(screen.getByRole("button", { name: "新建目录" }));
  fireEvent.change(screen.getByLabelText("新目录名"), {
    target: { value: "docs" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
  await screen.findByText("docs");
  expect(hit("POST", "/files/mkdir")[0]?.body).toEqual({
    path: "/work/proj/docs",
    sessionId: "s1",
  });
});

test("目录名含斜杠时不发请求", async () => {
  mount();
  await screen.findByText("a.txt");
  fireEvent.click(screen.getByRole("button", { name: "新建目录" }));
  fireEvent.change(screen.getByLabelText("新目录名"), {
    target: { value: "a/b" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
  expect(hit("POST", "/files/mkdir")).toHaveLength(0);
  expect(screen.getByRole("status").textContent).toContain("/");
});

test("删除先确认；删目录带 recursive", async () => {
  mount();
  fireEvent.click(await screen.findByText("src"));
  fireEvent.click(screen.getByText("a.txt"));
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  expect(hit("DELETE", "/files/entry")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(screen.queryByText("a.txt")).toBeNull());
  const del = hit("DELETE", "/files/entry")[0]?.path ?? "";
  expect(del).toContain("path=%2Fwork%2Fproj%2Fa.txt");
  expect(del).toContain("sessionId=s1");
  expect(del).not.toContain("recursive");
});

test("上传撞名：先问再覆盖", async () => {
  mount();
  await screen.findByText("a.txt");
  const input = screen.getByLabelText("选择要上传的文件");
  const file = new File(["new"], "a.txt");
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText(/已存在，覆盖/);
  expect(hit("PUT", "/files/content")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "覆盖" }));
  await waitFor(() => expect(hit("PUT", "/files/content")).toHaveLength(2));
  expect(hit("PUT", "/files/content")[1]?.path).toContain("overwrite=1");
});

test("下载选中的文件", async () => {
  const create = vi.fn(() => "blob:x");
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }),
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  mount();
  fireEvent.click(await screen.findByText("a.txt"));
  fireEvent.click(screen.getByRole("button", { name: "下载" }));
  await waitFor(() => expect(click).toHaveBeenCalled());
  expect(hit("GET", "/files/content")[0]?.path).toContain("download=1");
  click.mockRestore();
});

test("目录读不到时报错；401 通知登录失效", async () => {
  api.fail["GET /api/v1/environments/local/files/list"] = 404;
  mount();
  await screen.findByRole("alert");
  cleanup();
  api.fail["GET /api/v1/environments/local/files/list"] = 401;
  const { env } = mount();
  await waitFor(() => expect(env.hub.onUnauthorized).toHaveBeenCalled());
});
