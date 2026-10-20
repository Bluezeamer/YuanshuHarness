import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  bytes,
  installApi,
  installPaneApi,
  type PaneApi,
  paneEnv,
} from "../fakes";
import { EnvContext } from "../layout/env";
import {
  type FilePreviewConfig,
  FilePreviewPane,
  PREVIEW_LIMIT,
} from "./FilePreviewPane";

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

function mount(config: FilePreviewConfig) {
  const env = paneEnv();
  render(
    <EnvContext value={env}>
      <FilePreviewPane
        paneId="p1"
        config={config}
        focused={false}
        binding={{ mode: "follow" }}
        onUpdateConfig={vi.fn()}
      />
    </EnvContext>,
  );
  return env;
}

const at = (path: string): FilePreviewConfig => ({
  environmentId: "local",
  path,
});

test("没选文件时给提示", () => {
  mount({ environmentId: null, path: null });
  expect(screen.getByText(/点一个文件/)).toBeTruthy();
});

test("文本文件只读展示，带行号列表", async () => {
  api.files["/work/proj/n.txt"] = {
    type: "text/plain",
    bytes: bytes("one\ntwo\nthree"),
  };
  mount(at("/work/proj/n.txt"));
  await screen.findByText("two");
  expect(document.querySelectorAll(".code-ol li")).toHaveLength(3);
  expect(screen.getByText("local:/work/proj/n.txt")).toBeTruthy();
});

test("只请求前部：带 Range，超出时提示总大小", async () => {
  const big = "x".repeat(PREVIEW_LIMIT + 10);
  api.files["/work/proj/big.log"] = { type: "text/plain", bytes: bytes(big) };
  mount(at("/work/proj/big.log"));
  const note = await screen.findByRole("status");
  expect(note.textContent).toContain("只显示前");
  const call = api.calls.find((c) => c.path.includes("big.log"));
  expect(call?.range).toBe(`bytes=0-${PREVIEW_LIMIT - 1}`);
});

test("二进制文件给提示，不乱码", async () => {
  api.files["/work/proj/a.bin"] = {
    type: "application/octet-stream",
    bytes: new Uint8Array([1, 0, 2, 0, 3]),
  };
  mount(at("/work/proj/a.bin"));
  const note = await screen.findByRole("status");
  expect(note.textContent).toContain("二进制文件");
  expect(document.querySelector(".code-ol")).toBeNull();
});

test("octet-stream 但没有 NUL 的按文本显示", async () => {
  api.files["/work/proj/Makefile"] = {
    type: "application/octet-stream",
    bytes: bytes("all:\n\techo hi"),
  };
  mount(at("/work/proj/Makefile"));
  await screen.findByText("all:");
});

test("PDF 提供「用 PDF 阅读器打开」", async () => {
  api.files["/work/proj/d.pdf"] = {
    type: "application/pdf",
    bytes: bytes("%PDF-1.4"),
  };
  const env = mount(at("/work/proj/d.pdf"));
  fireEvent.click(
    await screen.findByRole("button", { name: "用 PDF 阅读器打开" }),
  );
  const req = env.openContent.mock.calls[0]?.[0];
  expect(req?.type).toBe("pdf");
  expect(req?.config).toEqual({
    environmentId: "local",
    path: "/work/proj/d.pdf",
    page: 1,
    scale: 1,
  });
});

test("读取失败按原因提示；401 通知登录失效", async () => {
  mount(at("/work/proj/none.txt"));
  expect((await screen.findByRole("alert")).textContent).toContain("不存在");
  cleanup();
  api.fail["GET /api/v1/environments/local/files/content"] = 401;
  api.files["/work/proj/a.txt"] = { type: "text/plain", bytes: bytes("x") };
  const env = mount(at("/work/proj/a.txt"));
  await waitFor(() => expect(env.hub.onUnauthorized).toHaveBeenCalled());
});
