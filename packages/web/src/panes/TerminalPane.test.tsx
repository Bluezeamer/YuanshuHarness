import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../api";
import {
  bytes,
  FakeWS,
  installApi,
  installPaneApi,
  type PaneApi,
  paneEnv,
} from "../fakes";
import { EnvContext } from "../layout/env";
import { type TerminalConfig, TerminalPane } from "./TerminalPane";

// xterm 要真实的布局与 canvas，jsdom 里换成记录写入与回调的替身。
const xt = vi.hoisted(() => {
  class FakeTerm {
    cols = 80;
    rows = 24;
    written: Uint8Array[] = [];
    lines: string[] = [];
    disposed = false;
    focused = false;
    dataCb: (d: string) => void = () => {};
    resizeCb: (s: { cols: number; rows: number }) => void = () => {};
    loadAddon() {}
    open() {}
    focus() {
      this.focused = true;
    }
    dispose() {
      this.disposed = true;
    }
    write(d: Uint8Array) {
      this.written.push(d);
    }
    writeln(s: string) {
      this.lines.push(s);
    }
    onData(cb: (d: string) => void) {
      this.dataCb = cb;
    }
    onResize(cb: (s: { cols: number; rows: number }) => void) {
      this.resizeCb = cb;
    }
  }
  return { FakeTerm, all: [] as InstanceType<typeof FakeTerm>[] };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class extends xt.FakeTerm {
    constructor() {
      super();
      xt.all.push(this);
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

let api: PaneApi;
const last = () => {
  const t = xt.all.at(-1);
  if (!t) throw new Error("还没有创建 xterm");
  return t;
};
const text = (u: Uint8Array) => new TextDecoder().decode(u);
const status = () => screen.getByRole("status").textContent ?? "";

beforeEach(() => {
  FakeWS.all = [];
  xt.all = [];
  sessionStorage.clear();
  saveToken("tok");
  installApi();
  api = installPaneApi();
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(paneId = "t1", active: string | null = "s1") {
  const env = paneEnv(active);
  const onUpdateConfig = vi.fn();
  const config: TerminalConfig = { label: null };
  render(
    <EnvContext value={env}>
      <TerminalPane
        paneId={paneId}
        config={config}
        focused={false}
        binding={{ mode: "follow" }}
        onUpdateConfig={onUpdateConfig}
      />
    </EnvContext>,
  );
  return { env, onUpdateConfig };
}

const connected = async (n = 1) => {
  await waitFor(() => expect(FakeWS.all.length).toBeGreaterThanOrEqual(n));
  return FakeWS.last;
};

test("在会话的 workspace 里开终端：带环境、目录、尺寸、会话，并写入 tab 标签", async () => {
  const { onUpdateConfig } = mount();
  const ws = await connected();
  const post = api.calls.find((c) => c.method === "POST");
  expect(post?.body).toEqual({
    environmentId: "local",
    cwd: "/work/proj",
    cols: 80,
    rows: 24,
    sessionId: "s1",
  });
  expect(ws.url).toContain("/api/v1/terminals/term1/stream");
  expect(ws.protocols).toEqual(["yuanshu.v1", "bearer.tok"]);
  expect(status()).toBe("连接中");
  expect(onUpdateConfig).toHaveBeenCalledWith({ label: "本机:proj" });
  ws.serve({ type: "ready", cols: 80, rows: 24 });
  await waitFor(() => expect(status()).toBe("运行中"));
  expect(sessionStorage.getItem("yuanshu.terminal.t1")).toBe("term1");
});

test("输入、输出、改尺寸都走 WebSocket", async () => {
  mount();
  const ws = await connected();
  ws.serve({ type: "ready", cols: 80, rows: 24 });
  await waitFor(() => expect(status()).toBe("运行中"));
  const x = last();
  x.dataCb("ls\r");
  x.resizeCb({ cols: 100, rows: 30 });
  expect(ws.sent).toEqual([
    { type: "input", data: "ls\r" },
    { type: "resize", cols: 100, rows: 30 },
  ]);
  ws.serveBytes(bytes("hi"));
  expect(x.written.map(text)).toEqual(["hi"]);
});

test("重连到已有终端时，尺寸与服务端记的不一致就补发 resize", async () => {
  mount();
  const ws = await connected();
  ws.serve({ type: "ready", cols: 120, rows: 40 });
  await waitFor(() => expect(ws.sent).toHaveLength(1));
  expect(ws.sent[0]).toEqual({ type: "resize", cols: 80, rows: 24 });
});

test("shell 退出：显示退出码，可重新打开", async () => {
  mount();
  const ws = await connected();
  ws.serve({ type: "ready", cols: 80, rows: 24 });
  ws.serve({ type: "exit", exitCode: 3 });
  await waitFor(() => expect(status()).toBe("已退出（退出码 3）"));
  expect(sessionStorage.getItem("yuanshu.terminal.t1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重新打开" }));
  await connected(2);
  expect(api.terminalsMade).toBe(2);
});

test("连接断开后可重连，沿用同一个终端不再新建", async () => {
  mount();
  const ws = await connected();
  ws.serve({ type: "ready", cols: 80, rows: 24 });
  await waitFor(() => expect(status()).toBe("运行中"));
  ws.drop();
  await waitFor(() => expect(status()).toBe("连接已断开"));
  fireEvent.click(screen.getByRole("button", { name: "重连" }));
  const again = await connected(2);
  expect(again.url).toBe(ws.url);
  expect(api.terminalsMade).toBe(1);
});

test("刷新页面后按 pane 记的终端 id 接回去", async () => {
  sessionStorage.setItem("yuanshu.terminal.t1", "term9");
  mount();
  const ws = await connected();
  expect(ws.url).toContain("/terminals/term9/stream");
  expect(api.terminalsMade).toBe(0);
});

test("记着的终端已被回收：连不上就新开一个并提示", async () => {
  sessionStorage.setItem("yuanshu.terminal.t1", "gone");
  mount();
  const old = await connected();
  old.drop();
  const fresh = await connected(2);
  expect(fresh.url).toContain("/terminals/term1/stream");
  expect(last().lines.join("")).toContain("原终端已不存在");
});

test("同一会话可以开多个终端：每个 pane 各自一个", async () => {
  mount("t1");
  mount("t2");
  await connected(2);
  expect(api.terminalsMade).toBe(2);
  expect(FakeWS.all.map((w) => w.url).join()).toContain("term1");
  expect(FakeWS.all.map((w) => w.url).join()).toContain("term2");
});

test("pane 关闭时关掉服务端终端，并释放 xterm", async () => {
  mount();
  const ws = await connected();
  ws.serve({ type: "ready", cols: 80, rows: 24 });
  await waitFor(() => expect(status()).toBe("运行中"));
  const x = last();
  cleanup();
  await waitFor(() =>
    expect(
      api.calls.some(
        (c) => c.method === "DELETE" && c.path === "/api/v1/terminals/term1",
      ),
    ).toBe(true),
  );
  expect(x.disposed).toBe(true);
  expect(ws.closed).toBe(true);
});

test("创建失败：达到上限时给出原因", async () => {
  api.fail["POST /api/v1/terminals"] = 429;
  mount();
  expect((await screen.findByRole("alert")).textContent).toContain("上限");
  expect(FakeWS.all).toHaveLength(0);
});

test("401 通知登录失效", async () => {
  api.fail["POST /api/v1/terminals"] = 401;
  const { env } = mount();
  await waitFor(() => expect(env.hub.onUnauthorized).toHaveBeenCalled());
});
