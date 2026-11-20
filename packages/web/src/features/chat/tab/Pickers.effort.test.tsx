// 推理强度（在模型选单底部）的关闭与「选当前档」行为。
// Pickers.test.tsx 已覆盖档位列表与写回内容。
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { mount } from "./testkit";
import { installWorld } from "./testkit.world";

vi.mock("../audit", () => ({ AuditPane: () => null }));

const meta = { title: "t", agentName: "编码实现", status: "running" as const };
const q = (sel: string) => document.querySelector(sel) as HTMLElement;
const modelDialog = () => screen.queryByRole("dialog", { name: "选择模型" });
const level = (name: string) =>
  within(screen.getByRole("dialog", { name: "选择模型" })).getByRole("radio", {
    name,
  });

async function ready() {
  const w = installWorld();
  mount({}, { meta });
  await waitFor(() =>
    expect(q("[data-modelname]").textContent).not.toBe("默认模型"),
  );
  return w;
}

test("选档后弹层关闭并写回；再选当前档只关闭，不重复发请求", async () => {
  const w = await ready();
  fireEvent.click(q("[data-modelpick]"));
  expect(modelDialog()).not.toBeNull();
  fireEvent.click(level("高"));
  expect(modelDialog()).toBeNull();
  await waitFor(() => expect(w.patches).toHaveLength(1));
  await waitFor(() => expect(q("[data-effortname]").textContent).toBe("高"));

  fireEvent.click(q("[data-modelpick]"));
  fireEvent.click(level("高"));
  expect(modelDialog()).toBeNull();
  await act(async () => {});
  expect(w.patches).toHaveLength(1);
});

test("Esc 关闭选单，不改档位", async () => {
  const w = await ready();
  fireEvent.click(q("[data-modelpick]"));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(modelDialog()).toBeNull();
  await act(async () => {});
  expect(w.patches).toHaveLength(0);
  expect(q("[data-effortname]").textContent).toBe("中");
});
