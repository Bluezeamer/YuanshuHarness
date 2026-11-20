import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { HtmlView } from "./HtmlView";

afterEach(cleanup);

test("页面原文放进 srcdoc，能跑脚本，但沙箱不给同源（读不到应用的令牌）", () => {
  const { container } = render(<HtmlView html="<h1>hi</h1>" />);
  const frame = container.querySelector("iframe") as HTMLIFrameElement;
  expect(frame.getAttribute("srcdoc")).toBe("<h1>hi</h1>");
  const flags = frame.getAttribute("sandbox")?.split(" ") ?? [];
  expect(flags).toContain("allow-scripts");
  expect(flags).not.toContain("allow-same-origin");
});
