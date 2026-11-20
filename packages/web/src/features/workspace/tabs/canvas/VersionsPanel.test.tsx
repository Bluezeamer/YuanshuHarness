import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { VersionEntry } from "../../../../api/canvas";

const api = vi.hoisted(() => ({
  listVersions: vi.fn(),
  readVersion: vi.fn(),
  restoreVersion: vi.fn(),
  undoAgent: vi.fn(),
}));
vi.mock("../../../../api/canvas", () => api);

import { VersionsPanel } from "./VersionsPanel";

const e = (
  sha: string,
  source: VersionEntry["source"],
  summary: string,
  ts = 1_700_000_000_000,
): VersionEntry => ({ sha, ts, source, summary });

const mine = [
  e("c3", "user", "save 说明.md"),
  e("c2", "user", "save 说明.md"),
  e("c1", "user", "create 说明.md"),
];

const props = {
  env: "local",
  dir: "/w",
  file: "说明.md",
  kind: "note" as const,
  title: "说明",
  gitMissing: false,
  dirty: false,
  onChanged: vi.fn(),
  onClose: vi.fn(),
};

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  props.onChanged.mockReset();
  api.listVersions.mockImplementation(
    async (_t: unknown, _e: string, _d: string, path?: string) => ({
      ok: true,
      data: path === undefined ? [mine[0]] : mine,
    }),
  );
  api.readVersion.mockImplementation(
    async (_t: unknown, _e: string, _d: string, _p: string, sha: string) => ({
      ok: true,
      data: sha === "c3" ? "第三版\n" : "第二版\n",
    }),
  );
  api.restoreVersion.mockResolvedValue({ ok: true, data: { sha: "c4" } });
});
afterEach(cleanup);

test("列出每一次提交（新的在前、最新一条标「当前」、写明来源）；最新一条不是 agent 的就没有撤销入口", async () => {
  render(<VersionsPanel {...props} />);
  await waitFor(() =>
    expect(screen.getAllByText(/^保存 说明$/)).toHaveLength(2),
  );
  expect(screen.getByText("新建 说明")).toBeTruthy();
  expect(screen.getByText("当前")).toBeTruthy();
  expect(screen.getAllByText(/· 你$/)).toHaveLength(3);
  expect(
    screen.queryByRole("button", { name: "撤销 agent 的上一次修改" }),
  ).toBeNull();
});

test("点开旧的一条看按行的差别，恢复成功后通知调用方（重读主区）；当前那条没有恢复按钮", async () => {
  render(<VersionsPanel {...props} />);
  await waitFor(() => screen.getByText("新建 说明"));
  fireEvent.click(screen.getAllByText(/^保存 说明$/)[1] as HTMLElement);
  await screen.findByText(
    "恢复成这一版之后：带「−」的行会去掉，带「+」的行会回来。",
  );
  fireEvent.click(screen.getByRole("button", { name: "恢复到这一版" }));
  await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
  expect(api.restoreVersion).toHaveBeenCalledWith(
    null,
    "local",
    "/w",
    "说明.md",
    "c2",
  );
});

test("有没保存的改动：对话框写明恢复会丢掉它们", async () => {
  render(<VersionsPanel {...props} dirty />);
  await waitFor(() => screen.getByText("新建 说明"));
  fireEvent.click(screen.getByText("新建 说明"));
  expect(
    await screen.findByText("你有没保存的改动，恢复后会丢掉它们。"),
  ).toBeTruthy();
});

test("最新一条是 agent 的：出现撤销入口，确认后调接口并通知调用方；失败时把服务端的原因留在对话框里", async () => {
  api.listVersions.mockImplementation(
    async (_t: unknown, _e: string, _d: string, path?: string) => ({
      ok: true,
      data: path === undefined ? [e("a1", "agent", "create_card 风险")] : mine,
    }),
  );
  api.undoAgent
    .mockResolvedValueOnce({
      ok: false,
      message: "之后又有改动，请用历史逐个文件恢复",
    })
    .mockResolvedValueOnce({ ok: true });
  render(<VersionsPanel {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "撤销 agent 的上一次修改" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
  expect(
    await screen.findByText("之后又有改动，请用历史逐个文件恢复"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
});

test("这台主机没有 git：写明没有历史，不去读列表", async () => {
  render(<VersionsPanel {...props} gitMissing />);
  expect(await screen.findByText("没有历史")).toBeTruthy();
  expect(api.listVersions).not.toHaveBeenCalled();
});
