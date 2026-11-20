// 图片预览的基准尺寸：载入后把原始宽度交给 CSS（--nat-w），缩放比例（--tab-zoom）由 CSS 乘上去。
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ImageView } from "./ImageView";

afterEach(cleanup);

const img = () => document.querySelector("img") as HTMLImageElement;

test("载入前不带原始宽度；载入后写进 --nat-w（取 naturalWidth）", () => {
  render(<ImageView src="blob:x" alt="a.png" />);
  expect(img().style.getPropertyValue("--nat-w")).toBe("");

  Object.defineProperty(img(), "naturalWidth", { value: 640 });
  fireEvent.load(img());
  expect(img().style.getPropertyValue("--nat-w")).toBe("640");
  expect(img().getAttribute("alt")).toBe("a.png");
});

test("图片换了（载入事件再来一次）：以新图的宽度为准", () => {
  const { rerender } = render(<ImageView src="blob:1" alt="a" />);
  Object.defineProperty(img(), "naturalWidth", {
    value: 640,
    configurable: true,
  });
  fireEvent.load(img());
  rerender(<ImageView src="blob:2" alt="a" />);
  Object.defineProperty(img(), "naturalWidth", {
    value: 320,
    configurable: true,
  });
  fireEvent.load(img());
  expect(img().style.getPropertyValue("--nat-w")).toBe("320");
});
