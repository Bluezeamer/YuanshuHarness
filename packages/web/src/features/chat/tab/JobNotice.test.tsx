import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { JobSnapshot } from "../../../api";
import { JobNoticeCard } from "./JobNotice";

afterEach(cleanup);

const job = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id: "j1",
  kind: "command",
  name: "bash",
  label: "npm run build",
  ref: null,
  state: "done",
  exitCode: 0,
  startedAt: "2026-11-17T08:00:00.000Z",
  endedAt: "2026-11-17T08:01:23.000Z",
  ...over,
});

const card = () => document.querySelector("[data-job-notice]") as HTMLElement;

test("完成：种类、简述、结果与用时各一段；退出码 0 不写", () => {
  render(<JobNoticeCard job={job()} />);
  expect(card().textContent).toBe("后台命令npm run build已完成 · 1 分 23 秒");
  expect(card().dataset.state).toBe("done");
});

test("失败：写退出码，结果用危险色", () => {
  render(
    <JobNoticeCard
      job={job({ state: "failed", exitCode: 2 })}
      onOpen={vi.fn()}
    />,
  );
  expect(card().textContent).toContain("失败 · 1 分 23 秒 · 退出码 2");
  expect(
    card().querySelector('.ch-job-state[data-tone="failed"]'),
  ).toBeTruthy();
});

test("子代理交付与重启中断各有自己的措辞", () => {
  render(
    <JobNoticeCard
      job={job({ kind: "subagent", name: "spawn_subagent", ref: "c1" })}
    />,
  );
  expect(card().textContent).toContain("子代理");
  expect(card().textContent).toContain("已交付");
  cleanup();
  render(<JobNoticeCard job={job({ state: "interrupted", exitCode: null })} />);
  expect(card().textContent).toContain("因重启中断");
});

test("给了 onOpen 才是可点的一行，点它把任务快照交出去；没给就是只读", () => {
  const onOpen = vi.fn();
  const j = job();
  render(<JobNoticeCard job={j} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button"));
  expect(onOpen).toHaveBeenCalledWith(j);
  cleanup();
  render(<JobNoticeCard job={j} />);
  expect(screen.queryByRole("button")).toBeNull();
});
