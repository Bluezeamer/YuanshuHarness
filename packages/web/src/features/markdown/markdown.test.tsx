import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Markdown } from "../chat/tab/Markdown";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string) => ({
    svg: `<svg data-testid="mm" id="${id}"><g/></svg>`,
  })),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

afterEach(() => {
  cleanup();
  mermaid.render.mockClear();
});

const FENCE = "```mermaid\ngraph TD\n  A-->B\n```";

test("流式期间 mermaid 只显示源码，不触发渲染", () => {
  render(<Markdown text={FENCE} streaming />);
  expect(screen.getByText(/graph TD/)).toBeTruthy();
  expect(document.querySelector("[data-block='mermaid']")).toBeTruthy();
  expect(mermaid.render).not.toHaveBeenCalled();
});

test("定稿后渲染一次；父组件重渲染不会重挂 mermaid", async () => {
  function Host() {
    const [n, setN] = useState(0);
    return (
      <>
        <button type="button" onClick={() => setN(n + 1)}>
          重渲染
        </button>
        <span>{n}</span>
        <Markdown text={FENCE} />
      </>
    );
  }
  const { container } = render(<Host />);
  await waitFor(() => expect(screen.getByTestId("mm")).toBeTruthy());
  expect(mermaid.render).toHaveBeenCalledTimes(1);

  const svg = container.querySelector("[data-block='mermaid'] svg");
  fireEvent.click(screen.getByRole("button", { name: "重渲染" }));
  expect(container.querySelector("[data-block='mermaid'] svg")).toBe(svg);
  expect(mermaid.render).toHaveBeenCalledTimes(1);
});

test("带语言的代码围栏渲染成卡片：行号、语言标签、复制按钮", async () => {
  render(<Markdown text={"```ts\nconst a = 1;\nlet b = 2;\n```"} />);
  const card = document.querySelector("[data-block='code']");
  expect(card).toBeTruthy();
  expect(card?.querySelector(".md-block-lang")?.textContent).toBe("ts");
  expect(
    [...(card?.querySelectorAll(".md-code-n") ?? [])].map((n) => n.textContent),
  ).toEqual(["1", "2"]);
  expect(screen.getByRole("button", { name: "复制代码" })).toBeTruthy();
  // 高亮是异步的，等关键词上色后仍保持两行
  await waitFor(() =>
    expect(card?.querySelector(".hljs-keyword")?.textContent).toBe("const"),
  );
});

test("plain 模式（用户消息）不套卡片、不渲染图片", async () => {
  render(
    <Markdown
      plain
      text={"```mermaid\ngraph TD\n  A-->B\n```\n\n![图](chart.png)"}
    />,
  );
  expect(document.querySelector("[data-block]")).toBeNull();
  expect(mermaid.render).not.toHaveBeenCalled();
  expect(document.querySelector(".ch-img-ref")?.textContent).toBe("[图片：图]");
});

test("没有语言的围栏保持轻量 pre，不套卡片", () => {
  render(<Markdown text={"```\nplain text\n```"} />);
  expect(document.querySelector("[data-block='code']")).toBeNull();
  expect(document.querySelector(".ch-md pre")?.textContent).toContain(
    "plain text",
  );
});
