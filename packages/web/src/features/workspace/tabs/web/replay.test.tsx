import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ReplaySession, ReplayStep } from "../../../../api/browser";
import { ReplayView } from "./ReplayView";

const api = vi.hoisted(() => ({
  getReplaySessions: vi.fn(),
  getReplaySteps: vi.fn(),
  getReplayFrame: vi.fn(),
}));
vi.mock("../../../../api/browser", async (orig) => ({
  ...(await orig<typeof import("../../../../api/browser")>()),
  ...api,
}));

const session = (sessionId: string, steps = 3): ReplaySession => ({
  sessionId,
  steps,
  firstTs: "2026-11-12T08:00:00.000Z",
  lastTs: "2026-11-12T08:05:00.000Z",
});
const step = (id: number, summary = `动作 ${id}`): ReplayStep => ({
  id,
  pageId: "p1",
  ts: new Date(2026, 10, 12, 9, 0, id).toISOString(),
  tool: "browser_click",
  summary,
  url: "https://a.test/",
  title: "测试页",
});

const titles = new Map([
  ["s1", "修登录"],
  ["s2", "查文档"],
]);
const ok = <T,>(data: T) => ({ ok: true as const, data });

let created = 0;
const revoked: string[] = [];

/** 渲染并等首批读取（会话、步、画面）落定。 */
async function mount(anchor: string | null = "s1") {
  const view = render(
    <ReplayView workspaceId="w1" anchor={anchor} titles={titles} />,
  );
  await settle();
  return view;
}
const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  created = 0;
  revoked.length = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => `blob:frame-${++created}`,
    revokeObjectURL: (u: string) => revoked.push(u),
  });
  for (const fn of Object.values(api)) fn.mockReset();
  api.getReplaySessions.mockResolvedValue(
    ok([session("s1"), session("s2", 2)]),
  );
  api.getReplaySteps.mockImplementation(async (_t, _w, sid: string) =>
    ok(sid === "s1" ? [step(1), step(2), step(3)] : [step(11), step(12)]),
  );
  api.getReplayFrame.mockImplementation(async () => new Blob(["x"]));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const note = () => document.querySelector(".ws-wb-rp-note")?.textContent ?? "";
const count = () => document.querySelector(".ws-wb-rp-count")?.textContent;
const button = (name: string) => screen.getByRole("button", { name });

test("没有任何回放：说明卡片，翻页控件都不可用", async () => {
  api.getReplaySessions.mockResolvedValue(ok([]));
  await mount();
  expect(screen.getByText("还没有回放")).toBeTruthy();
  expect((button("播放") as HTMLButtonElement).disabled).toBe(true);
  expect((button("上一步") as HTMLButtonElement).disabled).toBe(true);
  expect((button("下一步") as HTMLButtonElement).disabled).toBe(true);
  expect(count()).toBe("0 / 0");
  expect(api.getReplaySteps).not.toHaveBeenCalled();
});

test("读取失败：说明读不到，不当成没有回放", async () => {
  api.getReplaySessions.mockResolvedValue({ ok: false, kind: "network" });
  await mount();
  expect(screen.getByText("读不到回放")).toBeTruthy();
  expect(screen.queryByText("还没有回放")).toBeNull();
});

test("默认看锚点会话的最后一步：画面、说明、进度", async () => {
  await mount("s1");
  expect(api.getReplaySteps).toHaveBeenCalledWith(null, "w1", "s1");
  expect(count()).toBe("3 / 3");
  expect(note()).toContain("动作 3");
  expect(note()).toContain("09:00:03");
  expect(note()).toContain("测试页");
  const img = document.querySelector("img.ws-wb-canvas") as HTMLImageElement;
  expect(img.src).toMatch(/^blob:frame-/);
  expect(img.alt).toContain("第 3 步");
});

test("锚点没有回放：看最近有动作的那个会话", async () => {
  await mount("zzz");
  expect(api.getReplaySteps).toHaveBeenCalledWith(null, "w1", "s1");
});

test("上一步 / 下一步 / 滑块切换，两端按钮禁用", async () => {
  await mount();
  expect((button("下一步") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button("上一步"));
  expect(count()).toBe("2 / 3");
  expect(note()).toContain("动作 2");
  fireEvent.change(screen.getByRole("slider", { name: "回放进度" }), {
    target: { value: "0" },
  });
  expect(count()).toBe("1 / 3");
  expect(note()).toContain("动作 1");
  expect((button("上一步") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button("下一步"));
  expect(count()).toBe("2 / 3");
});

test("翻到哪一步就顺手取前后几步的画面，已取过的不再取", async () => {
  await mount();
  // 看第 3 步：取第 2、3 步（前 1、后 2，到头为止）
  expect(api.getReplayFrame.mock.calls.map((c) => c[3]).sort()).toEqual([2, 3]);
  fireEvent.click(button("上一步"));
  await settle();
  fireEvent.click(button("上一步"));
  await settle();
  expect(api.getReplayFrame.mock.calls.map((c) => c[3]).sort()).toEqual([
    1, 2, 3,
  ]);
});

test("往前翻时也顺手取后面两步的画面", async () => {
  api.getReplaySteps.mockResolvedValue(
    ok([step(1), step(2), step(3), step(4), step(5), step(6)]),
  );
  await mount();
  api.getReplayFrame.mockClear();
  fireEvent.change(screen.getByRole("slider", { name: "回放进度" }), {
    target: { value: "0" },
  });
  await settle();
  // 第 1 步：自己 + 后面两步（前面没有）
  expect(api.getReplayFrame.mock.calls.map((c) => c[3]).sort()).toEqual([
    1, 2, 3,
  ]);
});

test("这一步的画面已经没有了：说明一句，不当成还在加载", async () => {
  api.getReplayFrame.mockImplementation(async (_t, _w, _s, id: number) =>
    id === 3 ? null : new Blob(["x"]),
  );
  await mount();
  expect(screen.getByText("这一步的画面已经没有了")).toBeTruthy();
  expect(document.querySelector("img.ws-wb-canvas")).toBeNull();
  fireEvent.click(button("上一步"));
  expect(screen.queryByText("这一步的画面已经没有了")).toBeNull();
});

test("自动播放：每隔一会儿进一步，到头自己停；在最后一步按播放从头来", async () => {
  vi.useFakeTimers();
  await mount();
  fireEvent.click(button("上一步"));
  fireEvent.click(button("上一步"));
  await settle();
  expect(count()).toBe("1 / 3");

  fireEvent.click(button("播放"));
  expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  expect(count()).toBe("2 / 3");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  expect(count()).toBe("3 / 3");
  // 到头：下一次计时发现没有下一步就停
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();

  fireEvent.click(button("播放")); // 在最后一步：回到第一步重新播
  expect(count()).toBe("1 / 3");
  fireEvent.click(button("暂停"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(count()).toBe("1 / 3");
});

test("自动播放：下一步的画面还没到就等，到了再进", async () => {
  vi.useFakeTimers();
  let release: (b: Blob) => void = () => {};
  api.getReplayFrame.mockImplementation((_t, _w, _s, id: number) =>
    id === 3
      ? new Promise<Blob>((r) => {
          release = r;
        })
      : Promise.resolve(new Blob(["x"])),
  );
  await mount();
  fireEvent.click(button("上一步"));
  fireEvent.click(button("上一步"));
  await settle();
  // 此刻在第 1 步；第 3 步的画面卡着
  fireEvent.click(button("下一步"));
  await settle();
  expect(count()).toBe("2 / 3");
  fireEvent.click(button("播放"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3600);
  });
  expect(count()).toBe("2 / 3");
  await act(async () => release(new Blob(["x"])));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  expect(count()).toBe("3 / 3");
});

test("换会话：重新取那个会话的步，旧会话的画面释放，播放停下", async () => {
  await mount();
  fireEvent.click(button("上一步"));
  await settle();
  fireEvent.click(button("播放"));
  expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();

  fireEvent.click(screen.getByRole("combobox", { name: "回放的会话" }));
  fireEvent.click(await screen.findByRole("option", { name: /查文档/ }));
  await settle();
  expect(api.getReplaySteps).toHaveBeenCalledWith(null, "w1", "s2");
  expect(count()).toBe("2 / 2");
  expect(note()).toContain("动作 12");
  expect(revoked.length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
});

test("换会话时旧会话的步不能拿去取新会话的画面", async () => {
  await mount();
  api.getReplayFrame.mockClear();
  fireEvent.click(screen.getByRole("combobox", { name: "回放的会话" }));
  fireEvent.click(await screen.findByRole("option", { name: /查文档/ }));
  await settle();
  const asked = api.getReplayFrame.mock.calls.filter((c) => c[2] === "s2");
  expect(asked.length).toBeGreaterThan(0);
  for (const c of asked) expect([11, 12]).toContain(c[3]);
});

test("会话来回切：回到原来的会话要重新取画面", async () => {
  await mount();
  const pick = async (name: RegExp) => {
    fireEvent.click(screen.getByRole("combobox", { name: "回放的会话" }));
    fireEvent.click(await screen.findByRole("option", { name }));
    await settle();
  };
  await pick(/查文档/);
  await pick(/修登录/);
  expect(count()).toBe("3 / 3");
  expect(document.querySelector("img.ws-wb-canvas")).not.toBeNull();
});

test("换会话后，旧会话迟到的画面不再保留（不泄漏 object URL）", async () => {
  let late: (b: Blob) => void = () => {};
  api.getReplayFrame.mockImplementation((_t, _w, sid: string) =>
    sid === "s1"
      ? new Promise<Blob>((r) => {
          late = r;
        })
      : Promise.resolve(new Blob(["x"])),
  );
  await mount();
  fireEvent.click(screen.getByRole("combobox", { name: "回放的会话" }));
  fireEvent.click(await screen.findByRole("option", { name: /查文档/ }));
  await settle();
  const before = created;
  await act(async () => late(new Blob(["x"])));
  expect(created).toBe(before);
});

test("刷新不会把你选的会话换回默认的", async () => {
  await mount("s1");
  fireEvent.click(screen.getByRole("combobox", { name: "回放的会话" }));
  fireEvent.click(await screen.findByRole("option", { name: /查文档/ }));
  await settle();
  fireEvent.click(button("刷新回放"));
  await settle();
  expect(api.getReplaySteps).toHaveBeenLastCalledWith(null, "w1", "s2");
  expect(note()).toContain("动作 12");
});

test("刷新：原来在最后一步就跟到新的最后一步", async () => {
  await mount();
  api.getReplaySteps.mockResolvedValue(
    ok([step(1), step(2), step(3), step(4)]),
  );
  fireEvent.click(button("刷新回放"));
  await settle();
  expect(count()).toBe("4 / 4");
  expect(note()).toContain("动作 4");
});

test("刷新：原来在中间，按步找回原来那一步（旧步被挤掉后序号会变）", async () => {
  await mount();
  fireEvent.click(button("上一步")); // 第 2 步（id 2）
  await settle();
  api.getReplaySteps.mockResolvedValue(ok([step(2), step(3), step(4)]));
  fireEvent.click(button("刷新回放"));
  await settle();
  expect(count()).toBe("1 / 3");
  expect(note()).toContain("动作 2");
});

test("卸载时释放所有画面", async () => {
  const view = await mount();
  expect(created).toBeGreaterThan(0);
  view.unmount();
  expect(revoked.length).toBe(created);
});
