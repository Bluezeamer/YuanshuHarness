import { cleanup, fireEvent, render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { afterEach, expect, test, vi } from "vitest";
import {
  copyAsMarkdown,
  copyStreamAsMarkdown,
  rehypeSourceRange,
  sourceRef,
} from "./copySource";
import { REMARK_PLUGINS } from "./remark";

afterEach(cleanup);

const SOURCE = `# 标题

第一段有 **加粗** 和 \`代码\`。

- 甲
- 乙
- 丙

\`\`\`js
const a = 1;
\`\`\`

最后一段。`;

function mount(source = SOURCE) {
  const view = render(
    <div
      data-testid="root"
      onCopy={(e) => copyAsMarkdown(e, source)}
      className="md-prose"
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={[rehypeSourceRange]}
      >
        {source}
      </ReactMarkdown>
    </div>,
  );
  const root = view.getByTestId("root");
  // 选区：从 a 的某处到 b 的某处
  const select = (a: Node, ao: number, b: Node, bo: number) => {
    const sel = window.getSelection() as Selection;
    sel.setBaseAndExtent(a, ao, b, bo);
  };
  const copy = () => {
    const setData = vi.fn();
    const notPrevented = fireEvent.copy(root, {
      clipboardData: { setData },
    });
    return {
      text: setData.mock.calls[0]?.[1] as string | undefined,
      notPrevented,
    };
  };
  const text = (selector: string) =>
    root.querySelector(selector)?.firstChild as Node;
  return { root, select, copy, text };
}

test("选中整段：复制的是 Markdown 原文（加粗、行内代码的标记还在）", () => {
  const { root, select, copy } = mount();
  const p = root.querySelector("p") as HTMLElement;
  select(p, 0, p, p.childNodes.length);
  const r = copy();
  expect(r.text).toBe("第一段有 **加粗** 和 `代码`。");
  expect(r.notPrevented).toBe(false);
});

test("跨几块：标题、段落、列表、代码围栏整块取原文，块之间沿用原文的空行", () => {
  const { root, select, copy } = mount();
  const last = root.querySelector("p:last-of-type") as HTMLElement;
  select(root, 0, last, last.childNodes.length);
  expect(copy().text).toBe(SOURCE);
});

test("紧凑列表里选中几项：各项带着列表标记，项与项之间是单换行", () => {
  const { root, select, copy } = mount();
  const items = root.querySelectorAll("li");
  select(items[0] as Node, 0, items[1] as Node, 1);
  expect(copy().text).toBe("- 甲\n- 乙");
});

test("选区整个落在一个块的内部（选一句话）：不接管，走浏览器默认复制", () => {
  const { root, select, copy } = mount();
  const t = root.querySelector("p")?.firstChild as Node;
  select(t, 1, t, 4);
  const r = copy();
  expect(r.text).toBeUndefined();
  expect(r.notPrevented).toBe(true);
});

test("两头只选了一部分：整块的取原文，被截到的那段是纯文字", () => {
  const { root, select, copy } = mount();
  const h = root.querySelector("h1")?.firstChild as Node;
  const last = root.querySelector("p:last-of-type")?.firstChild as Node;
  // 从标题第 1 个字之后、到最后一段第 2 个字
  select(h, 1, last, 2);
  const text = copy().text ?? "";
  expect(text.startsWith("题")).toBe(true);
  expect(text).toContain("第一段有 **加粗** 和 `代码`。");
  expect(text).toContain("- 甲\n- 乙\n- 丙");
  expect(text).toContain("```js\nconst a = 1;\n```");
  expect(text.endsWith("最后")).toBe(true);
});

test("没有选中任何内容：不接管", () => {
  const { copy } = mount();
  window.getSelection()?.removeAllRanges();
  expect(copy().text).toBeUndefined();
});

test("选区里碰到没有标注的元素（自定义渲染出来的东西）：放弃接管", () => {
  const { root, select, copy } = mount();
  const extra = document.createElement("div");
  extra.textContent = "外来元素";
  root.appendChild(extra);
  select(root, 0, extra, 1);
  expect(copy().text).toBeUndefined();
});

// ── 对话流：一串渲染块，中间夹着工具行 ──

const A = "## 小结\n\n**接口**改好了。";
const B = "再补一句：[文档](https://x.dev/d)。\n\n- 甲\n- 乙";

function mountStream() {
  const view = render(
    <div data-testid="stream" onCopy={copyStreamAsMarkdown}>
      {[A, B].map((src, i) => (
        <div key={src}>
          <div className="md-prose" ref={sourceRef(src)} data-testid={`md${i}`}>
            <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              rehypePlugins={[rehypeSourceRange]}
            >
              {src}
            </ReactMarkdown>
          </div>
          {i === 0 && <div data-testid="tool">读取了 2 个文件</div>}
        </div>
      ))}
    </div>,
  );
  const stream = view.getByTestId("stream");
  const copy = () => {
    const setData = vi.fn();
    const notPrevented = fireEvent.copy(stream, { clipboardData: { setData } });
    return {
      text: setData.mock.calls[0]?.[1] as string | undefined,
      notPrevented,
    };
  };
  const select = (a: Node, ao: number, b: Node, bo: number) =>
    (window.getSelection() as Selection).setBaseAndExtent(a, ao, b, bo);
  return { view, stream, copy, select };
}

test("对话流：选区跨过工具行连着两段回复，两段各还原成原文，工具行的文字照常带上", () => {
  const { view, copy, select } = mountStream();
  const first = view.getByTestId("md0");
  const last = view.getByTestId("md1");
  select(first, 0, last, last.childNodes.length);
  const r = copy();
  expect(r.text).toBe(`${A}\n\n读取了 2 个文件\n\n${B}`);
  expect(r.notPrevented).toBe(false);
});

test("对话流：选区从某段回复的中间一块开始、到下一段结束，前一段只取选中的那几块", () => {
  const { view, copy, select } = mountStream();
  const h = view.getByTestId("md0").querySelector("p") as HTMLElement;
  const last = view.getByTestId("md1");
  // 从第一段回复的最后一个整块（段落）开始
  select(h, 0, last, last.childNodes.length);
  expect(copy().text).toBe(`**接口**改好了。\n\n读取了 2 个文件\n\n${B}`);
});

test("对话流：选区只落在一个渲染块里的一句话：不接管", () => {
  const { view, copy, select } = mountStream();
  const p = view.getByTestId("md0").querySelector("p") as HTMLElement;
  select(p.lastChild as Node, 1, p.lastChild as Node, 3);
  const r = copy();
  expect(r.text).toBeUndefined();
  expect(r.notPrevented).toBe(true);
});

test("对话流：选区只碰到工具行：不接管", () => {
  const { view, copy, select } = mountStream();
  const tool = view.getByTestId("tool").firstChild as Node;
  select(tool, 0, tool, 3);
  expect(copy().notPrevented).toBe(true);
});
