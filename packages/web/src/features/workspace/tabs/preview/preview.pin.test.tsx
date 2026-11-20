import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mount, qa } from "../../layout/harness";
import {
  fmOf,
  mainOf,
  resetSingletons,
  seedWorld,
  tabsOf,
} from "../files/harness";
import { registerFilesTab } from "../files/register";
import { world } from "../files/testkit";
import { getTabDef, registerTab } from "../registry";
import { registerPreviewTab } from "./register";

vi.mock(
  "../../../../api/files",
  async () => (await import("../files/testkit")).fakeFilesApi,
);
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {} }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "worker.js",
}));
vi.mock("mermaid", () => ({
  default: { render: vi.fn(), initialize: vi.fn() },
}));
// 编辑器在 jsdom 里跑不起来：换成一个按钮，点了就上报「有未保存改动」
vi.mock("./TextView", () => ({
  TextView: ({ onDirtyChange }: { onDirtyChange?: (d: boolean) => void }) => (
    <button type="button" onClick={() => onDirtyChange?.(true)}>
      模拟编辑
    </button>
  ),
}));

const originals = { files: getTabDef("files"), preview: getTabDef("preview") };

beforeEach(() => {
  seedWorld();
  world.put("local", "/w/a.md", "# a\n");
  world.put("local", "/w/b.md", "# b\n");
  registerFilesTab();
  registerPreviewTab();
});

afterEach(() => {
  cleanup();
  resetSingletons();
  registerTab("files", originals.files);
  registerTab("preview", originals.preview);
});

const previews = (store: Parameters<typeof tabsOf>[0]) =>
  tabsOf(store).filter((t) => t.type === "preview");

test("临时预览里开始编辑：自动固定，之后单击别的文件不会换掉它", async () => {
  const { store } = await mount();
  const fm = fmOf("server");
  await screen.findByText("a.md");
  fireEvent.click(mainOf(fm, "a.md"));
  expect(previews(store)[0]?.temp).toBe(true);
  expect(qa(".ws-pn-tab[data-type='preview'][data-temp='true']")).toHaveLength(
    1,
  );

  const edit = await screen.findByText("模拟编辑");
  await act(async () => {
    fireEvent.click(edit);
  });
  expect(previews(store)[0]?.temp).toBeUndefined();

  fireEvent.click(mainOf(fm, "b.md"));
  expect(previews(store).map((t) => [t.path, t.temp === true])).toEqual([
    ["/w/a.md", false],
    ["/w/b.md", true],
  ]);
});

test("已固定的预览里编辑：不动标记", async () => {
  const { store } = await mount();
  const fm = fmOf("server");
  await screen.findByText("a.md");
  fireEvent.keyDown(mainOf(fm, "a.md"), { key: "Enter" });
  const edit = await screen.findByText("模拟编辑");
  await act(async () => {
    fireEvent.click(edit);
  });
  expect(previews(store)[0]?.temp).toBeUndefined();
});
