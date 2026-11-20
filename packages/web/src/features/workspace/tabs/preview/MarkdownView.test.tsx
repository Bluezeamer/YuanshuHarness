import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ImageBase } from "../../../markdown/imageRef";
import { MarkdownView } from "./MarkdownView";

const readBlob = vi.hoisted(() => vi.fn());
vi.mock("../../../../api/files", () => ({ readBlob }));

beforeEach(() => {
  readBlob.mockReset();
  readBlob.mockResolvedValue({
    ok: true,
    data: new Blob(["x"], { type: "image/png" }),
  });
});
afterEach(cleanup);

test("给了 onWikilink：[[…]] 是可点的链接，点一下回调目标（不跳转）；代码里的照原样；普通链接与危险协议照旧", () => {
  const open = vi.fn();
  render(
    <MarkdownView
      text={
        "见 [[产品/用户研究|研究]] 与 [[想法.canvas]]，`[[代码]]`，[站](https://x.dev) [坏](javascript:alert(1))"
      }
      onWikilink={open}
    />,
  );
  fireEvent.click(screen.getByText("研究"));
  expect(open).toHaveBeenLastCalledWith("产品/用户研究");
  fireEvent.click(screen.getByText("想法.canvas"));
  expect(open).toHaveBeenLastCalledWith("想法.canvas");
  expect(open).toHaveBeenCalledTimes(2);
  expect(screen.getByText("[[代码]]").tagName).toBe("CODE");
  expect(screen.getByText("站").getAttribute("href")).toBe("https://x.dev");
  expect(screen.getByText("站").getAttribute("target")).toBe("_blank");
  expect(screen.getByText("坏").getAttribute("href") ?? "").not.toContain(
    "javascript",
  );
});

test("不给 onWikilink（画布卡片、普通 markdown 预览）：[[…]] 就是文字", () => {
  render(<MarkdownView text="见 [[设计原则]]" />);
  expect(screen.getByText("见 [[设计原则]]")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});

const fileBase: ImageBase = { kind: "file", env: "h1", dir: "/w/docs" };

test("给了 imageBase：相对路径的图片按 md 所在目录读出来显示，点击放大；svg 同样走 <img>", async () => {
  render(
    <MarkdownView
      text={"![图一](./a.assets/image-1.png)\n\n![矢量](./a.assets/v.svg)"}
      imageBase={fileBase}
    />,
  );
  await waitFor(() =>
    expect(document.querySelectorAll(".md-img img")).toHaveLength(2),
  );
  expect(readBlob.mock.calls.map((c) => [c[1], c[2]])).toEqual([
    ["h1", "/w/docs/a.assets/image-1.png"],
    ["h1", "/w/docs/a.assets/v.svg"],
  ]);
  expect(document.querySelector(".md-img img")?.getAttribute("alt")).toBe(
    "图一",
  );
  fireEvent.click(document.querySelector(".md-img") as HTMLElement);
  expect(document.querySelector(".u-viewer, [role='dialog']")).toBeTruthy();
});

test("读不到的图片：显示占位，不抛错", async () => {
  readBlob.mockResolvedValue({ ok: false, kind: "not_found" });
  render(<MarkdownView text="![丢了](./x.png)" imageBase={fileBase} />);
  await waitFor(() =>
    expect(
      document.querySelector(".md-img-note[data-state='fail']")?.textContent,
    ).toBe("[图片：丢了] 文件不存在"),
  );
});

test("绝对路径没带主机：占位里写明原因", async () => {
  render(<MarkdownView text="![乙](/tmp/b.png)" imageBase={fileBase} />);
  await waitFor(() =>
    expect(
      document.querySelector(".md-img-note[data-state='fail']")?.textContent,
    ).toBe("[图片：乙] 绝对路径缺少主机名，应写成 file:主机:/绝对路径"),
  );
});

test("外链 http(s) 图片不加载（不向第三方发请求），显示成可点开的占位", () => {
  render(
    <MarkdownView
      text="![远程](https://example.com/a.png)"
      imageBase={fileBase}
    />,
  );
  const link = screen.getByText("[图片：远程]");
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("href")).toBe("https://example.com/a.png");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(document.querySelector("img")).toBeNull();
  expect(readBlob).not.toHaveBeenCalled();
});

test("没给 imageBase（画布卡片）：相对路径图片只是占位，不去读", () => {
  render(<MarkdownView text="![卡片里的](./a.png)" light />);
  expect(screen.getByText("[图片：卡片里的]").tagName).toBe("SPAN");
  expect(readBlob).not.toHaveBeenCalled();
});

test("笔记（canvas 形态）：图片走画布接口，地址相对 .canvas/，响应变成图片", async () => {
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(url);
      return new Response(new Blob(["x"], { type: "image/png" }), {
        status: 200,
      });
    }),
  );
  render(
    <MarkdownView
      text="![图](./访谈.assets/image-1.png)"
      imageBase={{
        kind: "canvas",
        env: "local",
        project: "/w/proj",
        note: "产品/访谈.md",
      }}
    />,
  );
  await waitFor(() =>
    expect(document.querySelector(".md-img img")).toBeTruthy(),
  );
  const u = new URL(fetched[0] as string, "http://x");
  expect(u.pathname).toBe("/api/v1/canvas/local/image");
  expect(u.searchParams.get("dir")).toBe("/w/proj");
  expect(u.searchParams.get("file")).toBe("产品/访谈.assets/image-1.png");
  expect(readBlob).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
