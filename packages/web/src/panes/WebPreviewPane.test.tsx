import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  normalizeUrl,
  SLOW_MS,
  sandboxFor,
  type WebPreviewConfig,
  WebPreviewPane,
  type WebSelection,
} from "./WebPreviewPane";

afterEach(cleanup);

function mount(
  config: WebPreviewConfig,
  onUpdateConfig = vi.fn(),
  onSelection?: (s: WebSelection) => void,
) {
  const ui = (c: WebPreviewConfig) => (
    <WebPreviewPane
      paneId="w1"
      config={c}
      focused={false}
      binding={{ mode: "follow" }}
      onUpdateConfig={onUpdateConfig}
      onSelection={onSelection}
    />
  );
  const r = render(ui(config));
  // 配置由外层持有：模拟 onUpdateConfig 之后外层把新地址传回来
  const set = (url: string) => r.rerender(ui({ url }));
  return { onUpdateConfig, set };
}

const frame = () => document.querySelector("iframe");

test("normalizeUrl：补协议，只放行 http 与 https", () => {
  expect(normalizeUrl("localhost:3000")?.href).toBe("http://localhost:3000/");
  expect(normalizeUrl(" example.test/a ")?.href).toBe("http://example.test/a");
  expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  expect(normalizeUrl("file:///etc/passwd")).toBeNull();
  expect(normalizeUrl("")).toBeNull();
});

test("同源页面不放开 allow-same-origin，其他源可以", () => {
  expect(sandboxFor(new URL(location.origin))).not.toContain(
    "allow-same-origin",
  );
  expect(sandboxFor(new URL("http://127.0.0.1:5999/"))).toContain(
    "allow-same-origin",
  );
});

test("没有地址时不建 iframe，只给提示", () => {
  mount({ url: "" });
  expect(frame()).toBeNull();
  expect(screen.getByText(/输入地址后回车/)).toBeTruthy();
});

test("iframe 带 sandbox 与 no-referrer", () => {
  mount({ url: "http://127.0.0.1:5999/" });
  const f = frame();
  expect(f?.getAttribute("src")).toBe("http://127.0.0.1:5999/");
  expect(f?.getAttribute("sandbox")).toContain("allow-scripts");
  expect(f?.getAttribute("referrerpolicy")).toBe("no-referrer");
});

test("输入地址回车：规范化后写进配置", () => {
  const { onUpdateConfig } = mount({ url: "" });
  const input = screen.getByLabelText("地址");
  fireEvent.change(input, { target: { value: "localhost:8080" } });
  fireEvent.submit(input);
  expect(onUpdateConfig).toHaveBeenCalledWith({
    url: "http://localhost:8080/",
  });
});

test("非法地址不写配置并提示", () => {
  const { onUpdateConfig } = mount({ url: "" });
  const input = screen.getByLabelText("地址");
  fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
  fireEvent.submit(input);
  expect(onUpdateConfig).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("http");
});

test("地址没变时再提交等于重新加载：iframe 重建", () => {
  mount({ url: "http://127.0.0.1:5999/" });
  const before = frame();
  fireEvent.click(screen.getByRole("button", { name: "打开或重新加载" }));
  expect(frame()).not.toBe(before);
});

const nav = (to: string, m: ReturnType<typeof mount>) => {
  const input = screen.getByLabelText("地址");
  fireEvent.change(input, { target: { value: to } });
  fireEvent.submit(input);
  m.set(new URL(to).href);
};

test("后退/前进沿地址栏发起的跳转走，到头时禁用", () => {
  const m = mount({ url: "http://127.0.0.1:5001/" });
  const back = screen.getByRole("button", { name: "后退" });
  const fwd = screen.getByRole("button", { name: "前进" });
  expect((back as HTMLButtonElement).disabled).toBe(true);
  expect((fwd as HTMLButtonElement).disabled).toBe(true);

  nav("http://127.0.0.1:5002/", m);
  expect((back as HTMLButtonElement).disabled).toBe(false);

  fireEvent.click(back);
  expect(m.onUpdateConfig).toHaveBeenLastCalledWith({
    url: "http://127.0.0.1:5001/",
  });
  m.set("http://127.0.0.1:5001/");
  expect((back as HTMLButtonElement).disabled).toBe(true);
  expect((fwd as HTMLButtonElement).disabled).toBe(false);

  fireEvent.click(fwd);
  expect(m.onUpdateConfig).toHaveBeenLastCalledWith({
    url: "http://127.0.0.1:5002/",
  });
});

test("在新标签打开：noopener noreferrer，指向当前地址", () => {
  mount({ url: "http://127.0.0.1:5999/x" });
  const a = screen.getByRole("link", { name: "在新标签打开" });
  expect(a.getAttribute("href")).toBe("http://127.0.0.1:5999/x");
  expect(a.getAttribute("target")).toBe("_blank");
  expect(a.getAttribute("rel")).toBe("noopener noreferrer");
});

test("加载中不提示嵌入问题；load 后给出禁止嵌入的说明与兜底", () => {
  mount({ url: "http://127.0.0.1:5999/" });
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.load(frame() as HTMLIFrameElement);
  const note = screen.getByRole("status");
  expect(note.textContent).toContain("X-Frame-Options");
  expect(note.querySelector("a")?.getAttribute("rel")).toBe(
    "noopener noreferrer",
  );
});

test("超时仍未 load：提示连不上或禁止嵌入", () => {
  vi.useFakeTimers();
  try {
    mount({ url: "http://127.0.0.1:5999/" });
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(SLOW_MS + 10);
    });
    expect(screen.getByRole("status").textContent).toContain("加载很久了");
  } finally {
    vi.useRealTimers();
  }
});

test("跨源页面读不到选区：不触发 onSelection，也不抛错", () => {
  const onSelection = vi.fn();
  mount({ url: "http://127.0.0.1:5999/" }, vi.fn(), onSelection);
  const f = frame() as HTMLIFrameElement;
  // jsdom 里没有真实跨源；模拟浏览器对跨源 contentDocument 的行为
  Object.defineProperty(f, "contentDocument", { get: () => null });
  expect(() => fireEvent.load(f)).not.toThrow();
  expect(onSelection).not.toHaveBeenCalled();
});

test("可读到选区时回调文本与地址", () => {
  const onSelection = vi.fn();
  mount({ url: "http://127.0.0.1:5999/p" }, vi.fn(), onSelection);
  const f = frame() as HTMLIFrameElement;
  // jsdom 对带 http src 的 iframe 给的是空壳文档，所以只桩 pane 用到的那层接口。
  let mouseup: (() => void) | undefined;
  const doc = {
    addEventListener: (type: string, cb: () => void) => {
      if (type === "mouseup") mouseup = cb;
    },
    getSelection: () => ({ toString: () => "  选中的文字 " }),
  };
  Object.defineProperty(f, "contentDocument", { get: () => doc });
  fireEvent.load(f);
  expect(mouseup).toBeDefined();
  mouseup?.();
  expect(onSelection).toHaveBeenCalledWith({
    text: "选中的文字",
    url: "http://127.0.0.1:5999/p",
  });
});

test("选区为空白时不回调", () => {
  const onSelection = vi.fn();
  mount({ url: "http://127.0.0.1:5999/p" }, vi.fn(), onSelection);
  const f = frame() as HTMLIFrameElement;
  let mouseup: (() => void) | undefined;
  Object.defineProperty(f, "contentDocument", {
    get: () => ({
      addEventListener: (_t: string, cb: () => void) => {
        mouseup = cb;
      },
      getSelection: () => ({ toString: () => "   " }),
    }),
  });
  fireEvent.load(f);
  mouseup?.();
  expect(onSelection).not.toHaveBeenCalled();
});
