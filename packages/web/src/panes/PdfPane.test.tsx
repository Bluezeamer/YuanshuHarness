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
import { type PdfConfig, PdfPane } from "./PdfPane";

// pdf.js 在 jsdom 里跑不起来：换成只记录「渲染了哪一页、用什么缩放」的替身。
const pdf = vi.hoisted(() => ({
  numPages: 3,
  invalid: false,
  rendered: [] as number[],
  scales: [] as number[],
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: pdf.invalid
      ? Promise.reject(new Error("invalid"))
      : Promise.resolve({
          numPages: pdf.numPages,
          getPage: async (n: number) => ({
            getViewport: ({ scale }: { scale: number }) => {
              pdf.scales.push(scale);
              return { width: 100 * scale, height: 140 * scale };
            },
            render: () => {
              pdf.rendered.push(n);
              return { promise: Promise.resolve(), cancel: () => {} };
            },
          }),
        }),
    destroy: async () => {},
  }),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "worker.js",
}));

let api: PaneApi;

beforeEach(() => {
  sessionStorage.clear();
  pdf.numPages = 3;
  pdf.invalid = false;
  pdf.rendered = [];
  pdf.scales = [];
  installApi();
  api = installPaneApi();
  api.files["/work/proj/d.pdf"] = {
    type: "application/pdf",
    bytes: bytes("%PDF-1.4"),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const doc = (over: Partial<PdfConfig> = {}): PdfConfig => ({
  environmentId: "local",
  path: "/work/proj/d.pdf",
  page: 1,
  scale: 1,
  ...over,
});

function mount(config: PdfConfig) {
  const env = paneEnv();
  const onUpdateConfig = vi.fn();
  render(
    <EnvContext value={env}>
      <PdfPane
        paneId="d1"
        config={config}
        focused={false}
        binding={{ mode: "follow" }}
        onUpdateConfig={onUpdateConfig}
      />
    </EnvContext>,
  );
  return { env, onUpdateConfig };
}

test("没选文件时给提示", () => {
  mount({ environmentId: null, path: null, page: 1, scale: 1 });
  expect(screen.getByText(/用 PDF 阅读器打开/)).toBeTruthy();
});

test("读取整个文件并渲染第一页，显示页码", async () => {
  mount(doc());
  await screen.findByText("1 / 3");
  await waitFor(() => expect(pdf.rendered).toEqual([1]));
  const get = api.calls.find((c) => c.path.includes("d.pdf"));
  expect(get?.range).toBeNull();
  expect(screen.getByText("d.pdf")).toBeTruthy();
});

test("翻页写进配置，首尾页对应按钮禁用", async () => {
  const { onUpdateConfig } = mount(doc());
  await screen.findByText("1 / 3");
  const prev = screen.getByRole("button", { name: "上一页" });
  expect((prev as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(onUpdateConfig).toHaveBeenCalledWith(doc({ page: 2 }));
  cleanup();
  mount(doc({ page: 3 }));
  await screen.findByText("3 / 3");
  const next = screen.getByRole("button", { name: "下一页" });
  expect((next as HTMLButtonElement).disabled).toBe(true);
});

test("配置里的页码超出范围时夹到最后一页", async () => {
  mount(doc({ page: 9 }));
  await screen.findByText("3 / 3");
  await waitFor(() => expect(pdf.rendered).toEqual([3]));
});

test("缩放：按档位增减，渲染用对应倍数", async () => {
  const { onUpdateConfig } = mount(doc());
  await screen.findByText("100%");
  fireEvent.click(screen.getByRole("button", { name: "放大" }));
  expect(onUpdateConfig).toHaveBeenCalledWith(doc({ scale: 1.25 }));
  fireEvent.click(screen.getByRole("button", { name: "缩小" }));
  expect(onUpdateConfig).toHaveBeenCalledWith(doc({ scale: 0.75 }));
  cleanup();
  pdf.scales = [];
  mount(doc({ scale: 2 }));
  await screen.findByText("200%");
  await waitFor(() => expect(pdf.scales.at(-1)).toBe(3));
});

test("不是 PDF、读取失败、登录失效都有提示", async () => {
  pdf.invalid = true;
  mount(doc());
  expect((await screen.findByRole("alert")).textContent).toContain(
    "不是有效的 PDF",
  );
  cleanup();
  pdf.invalid = false;
  mount(doc({ path: "/work/proj/none.pdf" }));
  expect((await screen.findByRole("alert")).textContent).toContain("不存在");
  cleanup();
  api.fail["GET /api/v1/environments/local/files/content"] = 401;
  const { env } = mount(doc());
  await waitFor(() => expect(env.hub.onUnauthorized).toHaveBeenCalled());
});
