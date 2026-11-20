// 文件标签组件测试的共用夹具：种子文件树、选择器、状态复位。只被 *.test.tsx 引用。
// 各测试文件仍需自己写 vi.mock("<相对路径>/api/files", ...)，vi.mock 不能从夹具里转发。
import {
  act,
  createEvent,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import type { DropEntry } from "../../../chat/tab/dropFiles";
import {
  dragStart,
  drop,
  mount,
  over,
  paneByHost,
  q,
  qa,
} from "../../layout/harness";
import { panesOf } from "../../model/l2";
import type { Tab } from "../../model/types";
import type { LayoutStore } from "../../store/layoutStore";
import { endFileDrag } from "./dndStore";
import { world } from "./testkit";
import { resetTransfers, tuning } from "./transfer";

/** 工作区的两台主机：server（服务端环境 id 为 local）的 /w，与 gpu 的 /g */
export function seedWorld(): void {
  world.reset();
  world.seed("local", {
    "/w/README.md": 120,
    "/w/package.json": 80,
    "/w/.env": 5,
    "/w/src/index.ts": 300,
    "/w/docs": null,
  });
  world.seed("gpu", { "/g/train.py": 2048, "/g/data": null });
  tuning.pollMs = 5;
}

/** 清掉模块级单例（拖拽物、传输），免得上一个用例的状态漏进下一个 */
export function resetSingletons(): void {
  endFileDrag();
  resetTransfers();
}

export const fmOf = (host: string) =>
  q(".ws-fm", paneByHost(host)) as HTMLElement;
export const rowOf = (fm: HTMLElement, name: string) =>
  qa(".ws-fm-row", fm).find((r) => r.dataset.name === name) as HTMLElement;
export const mainOf = (fm: HTMLElement, name: string) =>
  q(".u-lrow-main", rowOf(fm, name)) as HTMLElement;
/** 点开工具条上的菜单（新建 / 更多）再点其中一项 */
export async function pickMenu(
  fm: HTMLElement,
  trigger: string,
  item: string | RegExp,
): Promise<void> {
  fireEvent.click(within(fm).getByLabelText(trigger));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

export const listOf = (fm: HTMLElement) => q(".ws-fm-list", fm) as HTMLElement;
export const crumbOf = (fm: HTMLElement, path: string) =>
  q(`.ws-fm-crumb button[data-path="${path}"]`, fm) as HTMLElement;
export const names = (fm: HTMLElement) =>
  qa(".ws-fm-row", fm).map((r) => r.dataset.name);

export function tabsOf(store: LayoutStore): Tab[] {
  const st = store.getState().doc.windows;
  const win = st.list[st.active];
  return win ? panesOf(win).flatMap((p) => p.tabs) : [];
}
export const filesTab = (store: LayoutStore, host: string) =>
  tabsOf(store).find((t) => t.type === "files" && t.host === host) as Tab;

/** gpu 窗格默认停在终端标签，切到文件标签，让两台主机的文件管理器同时在屏 */
export async function showGpuFiles(): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.click(
      within(paneByHost("gpu")).getByRole("tab", { name: /^文件/ }),
    );
  });
  await screen.findByText("train.py");
  return fmOf("gpu");
}

/** 拖拽用例的种子：两台主机都有 README.md 与 docs，server 的 src/auth 有三个文件 */
export function seedDndWorld(): void {
  seedWorld();
  world.seed("gpu", { "/g/README.md": 50, "/g/docs": null });
  world.seed("local", {
    "/w/src/auth/token.ts": 100,
    "/w/src/auth/refresh.ts": 60,
    "/w/src/auth/middleware.ts": 40,
  });
}

export const ghost = () => document.querySelector<HTMLElement>(".ws-xghost");
export const strip = () => document.querySelector<HTMLElement>(".ws-xfer");
export const calls = (prefix: string) =>
  world.calls.filter((c) => c.startsWith(prefix));

/** 两个文件管理器同时在屏：server 在 /w，gpu 在 /g */
export async function mountBoth() {
  const m = await mount();
  await within(fmOf("server")).findByText("README.md");
  await showGpuFiles();
  return m;
}

/** 拖起一行，悬停并落在 target 上 */
export function dragOnto(row: HTMLElement, target: HTMLElement) {
  dragStart(row);
  over(target, 10, 10);
  drop(target, 10, 10);
}

/** 系统文件拖入的素材：字符串值是文件内容，对象值表示文件夹（与从资源管理器拖进来的一致） */
export type DropTree = { [name: string]: string | DropTree };

/** 一个文件/文件夹 entry：文件夹用 readEntries 分批返回（第二批是空数组） */
function entryOf(name: string, node: string | DropTree): DropEntry {
  if (typeof node === "string") {
    const file = new File([node], name);
    return {
      isFile: true,
      isDirectory: false,
      name,
      file: (ok) => ok(file),
    };
  }
  const children = Object.entries(node).map(([n, v]) => entryOf(n, v));
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let done = false;
      return {
        readEntries: (ok) => {
          if (done) ok([]);
          else {
            done = true;
            ok(children);
          }
        },
      };
    },
  };
}

/** jsdom 里拖外部文件：dataTransfer 带 types: ["Files"] 与 webkitGetAsEntry 的 entry */
function fileTransfer(tree: DropTree) {
  const entries = Object.entries(tree).map(([n, v]) => entryOf(n, v));
  return {
    types: ["Files"],
    items: entries.map((entry) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
    })),
    files: [] as File[],
    dropEffect: "",
    effectAllowed: "",
    setData() {},
  };
}

function fireFileDrag(
  type: "dragOver" | "drop",
  el: Element,
  tree: DropTree,
  x = 10,
  y = 10,
): boolean {
  const ev = createEvent[type](el, { dataTransfer: fileTransfer(tree) });
  Object.defineProperty(ev, "clientX", { value: x });
  Object.defineProperty(ev, "clientY", { value: y });
  return fireEvent(el, ev);
}

/** 外部文件悬停：返回「落点是否接受」 */
export const overFiles = (el: HTMLElement, tree: DropTree, x = 10, y = 10) =>
  !fireFileDrag("dragOver", el, tree, x, y);

/** 外部文件落下 */
export const dropFiles = (el: HTMLElement, tree: DropTree, x = 10, y = 10) =>
  fireFileDrag("drop", el, tree, x, y);
