import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { forgetExecutions, rememberExecutions } from "../../chat/exec/names";
import { forgetJobs, rememberJob } from "../../chat/job/names";
import { titlesChanged, useTitleRev } from "./registry";

afterEach(() => {
  cleanup();
  forgetExecutions();
  forgetJobs();
});

// 数渲染次数：标题数据变了才该重画
function Probe({ onRender }: { onRender: () => void }) {
  onRender();
  return <output aria-label="rev">{useTitleRev()}</output>;
}
const mount = () => {
  const count = { n: 0 };
  render(<Probe onRender={() => count.n++} />);
  return count;
};

test("标题数据通知：titlesChanged 让订阅的组件重画", () => {
  const count = mount();
  const rev0 = screen.getByLabelText("rev").textContent;
  act(() => titlesChanged());
  expect(screen.getByLabelText("rev").textContent).not.toBe(rev0);
  expect(count.n).toBe(2);
});

test("任务与执行体的名称缓存：新名字或改名才通知，重复写入同一个名字不通知", () => {
  const count = mount();
  act(() => rememberJob({ id: "j1", label: "npm run dev" }));
  expect(count.n).toBe(2);
  act(() => rememberJob({ id: "j1", label: "npm run dev" }));
  expect(count.n).toBe(2);
  act(() => rememberJob({ id: "j1", label: "npm run build" }));
  expect(count.n).toBe(3);

  act(() => rememberExecutions([{ id: "x1", name: "回归审阅" }]));
  expect(count.n).toBe(4);
  act(() => rememberExecutions([{ id: "x1", name: "回归审阅" }]));
  expect(count.n).toBe(4);
});
