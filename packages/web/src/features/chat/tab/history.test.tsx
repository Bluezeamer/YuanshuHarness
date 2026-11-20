// B20 历史节点浮层的交互测试：双 Esc 手势门控、指令/树两个视图、回退调用与草稿回填、失败提示。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const navApi = vi.hoisted(() => ({
  getSessionTree: vi.fn(),
  navigateSession: vi.fn(),
}));
const sessionsApi = vi.hoisted(() => ({ getUserMessages: vi.fn() }));

vi.mock("../../../api/session-nav", () => navApi);
vi.mock("../../../api/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/sessions")>()),
  getUserMessages: sessionsApi.getUserMessages,
}));
vi.mock("../audit", () => ({ AuditPane: () => null }));

import { saveToken } from "../../../api/http";
import type { SessionTree } from "../../../api/session-nav";
import { clearToasts, ToastHost } from "../../../ui";
import { HistoryNodes } from "./HistoryNodes";
import { fakeSession, mount } from "./testkit";

const AT = "2026-10-27T10:00:00.000Z";

// u1 → a1 →（分叉）u2 → a2（当前分支）/ u3 → a3（旧分支）
const treeFixture = (): SessionTree => {
  const a2 = {
    id: "a2",
    parentId: "u2",
    type: "message",
    role: "assistant" as const,
    preview: "答复二",
    timestamp: AT,
    children: [],
  };
  const u2 = {
    id: "u2",
    parentId: "a1",
    type: "message",
    role: "user" as const,
    preview: "第二轮",
    timestamp: AT,
    children: [a2],
  };
  const a3 = {
    id: "a3",
    parentId: "u3",
    type: "message",
    role: "assistant" as const,
    preview: "另一条答复",
    timestamp: AT,
    children: [],
  };
  const u3 = {
    id: "u3",
    parentId: "a1",
    type: "message",
    role: "user" as const,
    preview: "改道的第二轮",
    timestamp: AT,
    children: [a3],
  };
  const a1 = {
    id: "a1",
    parentId: "u1",
    type: "message",
    role: "assistant" as const,
    preview: "答复一",
    timestamp: AT,
    children: [u2, u3],
  };
  const u1 = {
    id: "u1",
    parentId: null,
    type: "message",
    role: "user" as const,
    preview: "第一轮",
    timestamp: AT,
    children: [a1],
  };
  return {
    leafId: "a2",
    activePath: ["a2", "u2", "a1", "u1"],
    nodes: [u1],
  };
};

const messagesFixture = () => [
  { entryId: "u1", text: "第一轮", timestamp: AT },
  { entryId: "u2", text: "第二轮", timestamp: AT },
];

const esc = (el: Element | Document = document) =>
  fireEvent.keyDown(el, { key: "Escape" });

const dialog = () => screen.queryByRole("dialog", { name: "历史节点" });

const treeRows = () => [
  ...(dialog()?.querySelectorAll<HTMLElement>(".ch-hist-trow") ?? []),
];

const rowByText = (text: string): HTMLElement => {
  const row = treeRows().find((el) => el.textContent?.includes(text));
  if (!row) throw new Error(`找不到树行：${text}`);
  return row;
};

const nodeButton = (text: string): HTMLElement => {
  const row = rowByText(text);
  const btn = row.querySelector<HTMLElement>(".ch-hist-node .u-lrow-main");
  if (!btn) throw new Error(`找不到节点按钮：${text}`);
  return btn;
};

const openDialogFromChat = async () => {
  esc();
  esc();
  await screen.findByRole("dialog", { name: "历史节点" });
};

beforeEach(() => {
  saveToken("tok");
  clearToasts();
  navApi.getSessionTree.mockReset();
  navApi.navigateSession.mockReset();
  sessionsApi.getUserMessages.mockReset();
  navApi.getSessionTree.mockResolvedValue({ ok: true, data: treeFixture() });
  sessionsApi.getUserMessages.mockResolvedValue({
    ok: true,
    data: messagesFixture(),
  });
  navApi.navigateSession.mockResolvedValue({
    ok: true,
    data: { editor: { text: "第二轮", attachments: [] }, leafId: "a1" },
  });
});

afterEach(() => {
  cleanup();
  clearToasts();
  sessionStorage.clear();
});

describe("双 Esc 触发", () => {
  test("编辑器为空且会话空闲时，500ms 内连按两次 Esc 打开历史浮层", async () => {
    mount();
    esc();
    expect(dialog()).toBeNull();
    esc();
    await screen.findByRole("dialog", { name: "历史节点" });
    expect(navApi.getSessionTree).toHaveBeenCalledWith("s1", "tok");
    expect(sessionsApi.getUserMessages).toHaveBeenCalledWith("s1", "tok");
  });

  test("非空草稿不打开历史浮层", () => {
    mount({}, { draft: { text: "打了一半" } });
    esc();
    esc();
    expect(dialog()).toBeNull();
  });

  test("会话运行中 / 压缩中不打开，也不会中断运行", () => {
    const running = mount({ running: true });
    esc();
    esc();
    expect(dialog()).toBeNull();
    expect(running.box.actions.stop).not.toHaveBeenCalled();
    cleanup();

    mount({ compacting: true });
    esc();
    esc();
    expect(dialog()).toBeNull();
  });

  test("两次 Esc 间隔超过 500ms 不算双击", () => {
    let now = 1_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      mount();
      esc();
      now += 600;
      esc();
      expect(dialog()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test("Slash 菜单的 Esc 先关菜单，不计入双击", () => {
    mount();
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "/" } });
    // 第一次 Esc 被 Composer 的 Slash 菜单消费（preventDefault），不算双击的第一下
    esc(ta);
    // 紧接着的这一下只是双击的第一下，不应打开浮层
    esc(ta);
    expect(dialog()).toBeNull();
  });

  test("浮层已打开时 Esc 关闭且不会重新打开", async () => {
    mount();
    await openDialogFromChat();
    const focused = document.activeElement;
    expect(focused !== null && dialog()?.contains(focused)).toBe(true);
    esc(document.activeElement ?? document.body);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(navApi.navigateSession).not.toHaveBeenCalled();
  });
});

describe("指令视图", () => {
  const open = async () => {
    const box = fakeSession();
    const onClose = vi.fn();
    render(
      <>
        <HistoryNodes
          open
          onClose={onClose}
          sessionId="s1"
          session={box.session}
        />
        <ToastHost />
      </>,
    );
    await screen.findByRole("dialog", { name: "历史节点" });
    return { box, onClose };
  };

  test("列出序号 / 时间 / 首行预览，当前分支位置高亮", async () => {
    await open();
    const list = screen.getByRole("list", { name: "历史指令" });
    expect(within(list).getByText("#1")).toBeTruthy();
    expect(within(list).getByText("#2")).toBeTruthy();
    expect(within(list).getByText("第一轮")).toBeTruthy();
    expect(within(list).getByText("第二轮")).toBeTruthy();
    const current = list.querySelector<HTMLElement>('[aria-current="true"]');
    expect(current?.textContent).toContain("第二轮");
    expect(list.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    // 时间：跨天给月/日、当天给时分，两种都算有
    expect(list.querySelector(".ch-hist-time")?.textContent).toMatch(
      /\d{1,2}[:/]\d{2}/,
    );
  });

  test("点击指令调用 navigate，成功后回填草稿、关闭浮层并提示原分支保留", async () => {
    const { box, onClose } = await open();
    const row = screen.getByRole("button", { name: /第二轮/ });
    fireEvent.click(row);
    await waitFor(() =>
      expect(navApi.navigateSession).toHaveBeenCalledWith("s1", "u2", "tok"),
    );
    expect(box.actions.setDraft).toHaveBeenCalledWith("第二轮");
    expect(onClose).toHaveBeenCalledTimes(1);
    await screen.findByText("已回到该节点，原分支已保留");
  });

  test("回填带附件的指令：文字进草稿，附件以已就绪的引用加回草稿（不用重新上传）", async () => {
    navApi.navigateSession.mockResolvedValue({
      ok: true,
      data: {
        editor: {
          text: "看这张图",
          attachments: [
            {
              name: "a.png",
              mime: "image/png",
              sizeText: "1 KB",
              path: "a.png",
            },
          ],
        },
        leafId: "a1",
      },
    });
    const { box } = await open();
    fireEvent.click(screen.getByRole("button", { name: /第二轮/ }));
    await waitFor(() =>
      expect(box.actions.setDraft).toHaveBeenCalledWith("看这张图"),
    );
    expect(box.actions.addAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "a.png",
        mimeType: "image/png",
        sizeText: "1 KB",
        path: "a.png",
        status: "ready",
      }),
    );
  });

  test("409 运行中 / 压缩中：提示稍后再试，浮层保持打开", async () => {
    navApi.navigateSession.mockResolvedValue({
      ok: false,
      kind: "conflict",
    });
    const { onClose } = await open();
    fireEvent.click(screen.getByRole("button", { name: /第一轮/ }));
    await screen.findByText("运行中或压缩中，稍后再试");
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).toBeTruthy();
  });

  test("网络错误与加载失败都有提示", async () => {
    navApi.navigateSession.mockResolvedValue({ ok: false, kind: "network" });
    const { onClose } = await open();
    fireEvent.click(screen.getByRole("button", { name: /第一轮/ }));
    await screen.findByText("网络错误，回退失败，请重试");
    expect(onClose).not.toHaveBeenCalled();
  });

  test("加载失败显示错误与重试；重试成功后恢复列表", async () => {
    navApi.getSessionTree.mockResolvedValueOnce({ ok: false, kind: "server" });
    await open();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("历史节点加载失败");
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    await screen.findByText("#1");
    expect(navApi.getSessionTree).toHaveBeenCalledTimes(2);
  });

  test("没有指令时给出空状态", async () => {
    sessionsApi.getUserMessages.mockResolvedValue({ ok: true, data: [] });
    await open();
    expect(await screen.findByText("还没有历史指令")).toBeTruthy();
  });
});

describe("树视图", () => {
  const open = async () => {
    const box = fakeSession();
    const onClose = vi.fn();
    render(
      <>
        <HistoryNodes
          open
          onClose={onClose}
          sessionId="s1"
          session={box.session}
        />
        <ToastHost />
      </>,
    );
    await screen.findByRole("dialog", { name: "历史节点" });
    fireEvent.click(screen.getByRole("radio", { name: "树" }));
    return { box, onClose, list: screen.getByRole("list", { name: "会话树" }) };
  };

  test("渲染缩进连接线，activePath 高亮，leaf 标当前", async () => {
    await open();
    expect(
      treeRows().map((r) => r.querySelector(".ch-hist-prev")?.textContent),
    ).toEqual([
      "第一轮",
      "答复一",
      "第二轮",
      "答复二",
      "改道的第二轮",
      "另一条答复",
    ]);
    expect(
      treeRows().map(
        (r) => r.querySelector(".ch-hist-prefix")?.textContent ?? "",
      ),
    ).toEqual(["", "", "├─", "│   ", "└─", "    "]);
    // 当前分支四个节点高亮，旧分支不高亮
    const activeRows = dialog()?.querySelectorAll(".ch-hist-trow[data-active]");
    expect(activeRows).toHaveLength(4);
    const current = dialog()?.querySelector(".ch-hist-trow[data-current]");
    expect(current?.textContent).toContain("答复二");
    expect(current?.textContent).toContain("当前");
  });

  test("压缩节点用「压缩」标记，正文不重复服务端前缀", async () => {
    const a1 = {
      id: "a1",
      parentId: "c1",
      type: "message",
      role: "assistant" as const,
      preview: "压缩后的答复",
      timestamp: AT,
      children: [],
    };
    const c1 = {
      id: "c1",
      parentId: "u1",
      type: "compaction",
      preview: "前文摘要",
      timestamp: AT,
      children: [a1],
    };
    const u1 = {
      id: "u1",
      parentId: null,
      type: "message",
      role: "user" as const,
      preview: "第一轮",
      timestamp: AT,
      children: [c1],
    };
    navApi.getSessionTree.mockResolvedValue({
      ok: true,
      data: { leafId: "a1", activePath: ["a1", "c1", "u1"], nodes: [u1] },
    });
    await open();
    const row = treeRows().find((r) => r.textContent?.includes("前文摘要"));
    expect(row?.querySelector(".ch-hist-kind")?.textContent).toBe("压缩");
  });

  test("分叉点可折叠：折叠隐藏旧分支并提示节点数，展开后还原", async () => {
    await open();
    expect(treeRows()).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "折叠分支" }));
    expect(treeRows()).toHaveLength(2);
    expect(dialog()?.textContent).toContain("4 个节点");
    fireEvent.click(screen.getByRole("button", { name: "展开分支" }));
    expect(treeRows()).toHaveLength(6);
  });

  test("选中节点后「回到这里」回退；非 user 节点不回填草稿", async () => {
    navApi.navigateSession.mockResolvedValue({
      ok: true,
      data: { leafId: "a1" },
    });
    const { box, onClose } = await open();
    fireEvent.click(nodeButton("改道的第二轮"));
    const go = screen.getByRole("button", {
      name: "回到这里",
    }) as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() =>
      expect(navApi.navigateSession).toHaveBeenCalledWith("s1", "u3", "tok"),
    );
    expect(box.actions.setDraft).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    await screen.findByText("已回到该节点，原分支已保留");
  });

  test("回车确认选中的节点；当前 leaf 不能重复回退", async () => {
    const { box } = await open();
    const current = nodeButton("答复二");
    fireEvent.click(current);
    expect(
      (screen.getByRole("button", { name: "回到这里" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(navApi.navigateSession).not.toHaveBeenCalled();

    const target = nodeButton("第二轮");
    fireEvent.click(target);
    fireEvent.keyDown(target, { key: "Enter" });
    await waitFor(() =>
      expect(navApi.navigateSession).toHaveBeenCalledWith("s1", "u2", "tok"),
    );
    expect(box.actions.setDraft).toHaveBeenCalledWith("第二轮");
  });
});
