import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { JobInfo, JobLogChunk } from "../../../api";
import { JobView } from "./JobView";
import { forgetJobs } from "./names";

const info = (over: Partial<JobInfo> = {}): JobInfo => ({
  id: "j1",
  sessionId: "s1",
  kind: "command",
  name: "bash",
  label: "npm run build",
  ref: null,
  state: "running",
  exitCode: null,
  remindMs: 0,
  input: "npm run build\n  && echo done",
  startedAt: new Date(Date.now() - 12_000).toISOString(),
  endedAt: null,
  ...over,
});

interface World {
  job: JobInfo | number;
  /** 每次取日志依次给的回应；用完了重复最后一个 */
  chunks: JobLogChunk[];
  logCalls: string[];
  stops: number;
}

function install(w: Partial<World> = {}): World {
  const world: World = {
    job: info(),
    chunks: [{ text: "", from: 0, next: 0, headCut: false, ended: false }],
    logCalls: [],
    stops: 0,
    ...w,
  };
  let served = 0;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const reply = (v: object, status = 200) =>
      new Response(JSON.stringify(v), { status });
    if (input.includes("/log")) {
      world.logCalls.push(input);
      const c = world.chunks[Math.min(served++, world.chunks.length - 1)];
      return reply(c as object);
    }
    if (input.endsWith("/stop") && init?.method === "POST") {
      world.stops++;
      return reply({ job: null });
    }
    if (typeof world.job === "number") return reply({}, world.job);
    return reply({ job: world.job });
  });
  return world;
}

beforeEach(() => {
  vi.useFakeTimers();
  forgetJobs();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const settle = () => act(async () => {});
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const q = (s: string) => document.querySelector(s) as HTMLElement | null;

test("在跑：一行头写状态与用时，完整命令原样显示，输出随时间增量接上", async () => {
  const world = install({
    chunks: [
      { text: "step 1\n", from: 0, next: 7, headCut: false, ended: false },
      { text: "step 2\n", from: 7, next: 14, headCut: false, ended: false },
    ],
  });
  render(<JobView jobId="j1" />);
  await settle();
  expect(q('[data-jv="state"]')?.textContent).toBe("运行中");
  expect(q('[data-jv="input"]')?.textContent).toBe(
    "npm run build\n  && echo done",
  );
  expect(q('[data-jv="meta"]')?.textContent).toBe("12.0 秒");
  expect(q('[data-jv="log"]')?.textContent).toBe("step 1\n");
  await tick(1000);
  expect(q('[data-jv="log"]')?.textContent).toBe("step 1\nstep 2\n");
  // 第一次不带 from，之后带上服务端给的 next
  expect(world.logCalls[0]).toMatch(/\/log$/);
  expect(world.logCalls[1]).toMatch(/\/log\?from=7$/);
});

test("日志里的终端控制序列与进度条覆写被整理掉", async () => {
  install({
    chunks: [
      {
        text: "\u001b[32mok\u001b[0m\n10%\r100%\n",
        from: 0,
        next: 20,
        headCut: false,
        ended: true,
      },
    ],
  });
  render(<JobView jobId="j1" />);
  await settle();
  expect(q('[data-jv="log"]')?.textContent).toBe("ok\n100%\n");
});

test("失败的任务：头里写失败与退出码，读完日志就不再取", async () => {
  const world = install({
    job: info({
      state: "failed",
      exitCode: 2,
      endedAt: new Date().toISOString(),
    }),
    chunks: [{ text: "boom\n", from: 0, next: 5, headCut: false, ended: true }],
  });
  render(<JobView jobId="j1" />);
  await settle();
  expect(q('[data-jv="state"]')?.textContent).toBe("失败");
  expect(q('[data-jv="meta"]')?.textContent).toContain("退出码 2");
  expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  await tick(5000);
  expect(world.logCalls).toHaveLength(1);
});

test("没有输出：在跑写「还没有输出」，结束写「没有输出」", async () => {
  install();
  render(<JobView jobId="j1" />);
  await settle();
  expect(q('[data-jv="empty"]')?.textContent).toBe("还没有输出…");
  cleanup();
  install({
    job: info({
      state: "done",
      exitCode: 0,
      endedAt: new Date().toISOString(),
    }),
    chunks: [{ text: "", from: 0, next: 0, headCut: false, ended: true }],
  });
  render(<JobView jobId="j1" />);
  await settle();
  expect(q('[data-jv="empty"]')?.textContent).toBe("没有输出");
});

test("只给了尾部时提示已省略更早的输出", async () => {
  install({
    chunks: [
      { text: "tail\n", from: 900, next: 905, headCut: true, ended: false },
    ],
  });
  render(<JobView jobId="j1" />);
  await settle();
  expect(document.body.textContent).toContain("已省略更早的输出");
});

test("停止两步确认：第一次只上膛，确认后发请求", async () => {
  const world = install();
  render(<JobView jobId="j1" />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "停止" }));
  expect(world.stops).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "确认停止" }));
  await settle();
  expect(world.stops).toBe(1);
});

test("非命令的工具任务：块标题是「参数」，JSON 排成缩进", async () => {
  install({
    job: info({
      kind: "tool",
      name: "mcp_fetch",
      input: '{"url":"https://x.dev"}',
    }),
  });
  render(<JobView jobId="j1" />);
  await settle();
  expect(q('[data-jv="input"]')?.textContent).toBe(
    '{\n  "url": "https://x.dev"\n}',
  );
  expect(screen.getByRole("button", { name: "复制参数" })).toBeTruthy();
});

test("任务不存在：给出说明而不是空白", async () => {
  install({ job: 404 });
  render(<JobView jobId="j1" />);
  await settle();
  expect(screen.getByText("这个任务不存在")).toBeTruthy();
});

test("在跑的任务每 2 秒重取状态，结束后头跟着变、停止按钮消失", async () => {
  const world = install({
    chunks: [{ text: "", from: 0, next: 0, headCut: false, ended: false }],
  });
  render(<JobView jobId="j1" />);
  await settle();
  world.job = info({
    state: "done",
    exitCode: 0,
    endedAt: new Date().toISOString(),
  });
  await tick(2000);
  expect(q('[data-jv="state"]')?.textContent).toBe("已完成");
  expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
});
