import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  normalizeUrl,
  sandboxFor,
  type WebPreviewConfig,
  WebPreviewPane,
} from "./WebPreviewPane";

afterEach(cleanup);

function mount(config: WebPreviewConfig, onUpdateConfig = vi.fn()) {
  render(
    <WebPreviewPane
      paneId="w1"
      config={config}
      focused={false}
      binding={{ mode: "follow" }}
      onUpdateConfig={onUpdateConfig}
    />,
  );
  return { onUpdateConfig };
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
