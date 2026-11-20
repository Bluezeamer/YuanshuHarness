import { afterEach, expect, test, vi } from "vitest";
import {
  createWorkspaceGroup,
  deleteWorkspaceGroup,
  listWorkspaceGroups,
  patchWorkspaceGroup,
} from "./workspaceGroups";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const calls = () => fetchMock.mock.calls as [string, RequestInit][];
const bodyOf = (i: number) => JSON.parse(String(calls()[i]?.[1].body));

const group = { id: "g", name: "组", tone: 0, collapsed: false, order: 1 };

test("列表取 groups；新建 201、改名、解散的方法与请求体", async () => {
  fetchMock.mockImplementation(async () => json({ groups: [group] }));
  expect(await listWorkspaceGroups("t")).toEqual([group]);

  fetchMock.mockImplementation(async () => json(group, 201));
  await createWorkspaceGroup("t", { name: "组", tone: 2 });
  fetchMock.mockImplementation(async () => json(group));
  await patchWorkspaceGroup("t", "g 1", { collapsed: true, order: 3 });
  fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
  await deleteWorkspaceGroup("t", "g 1");

  expect(calls()[0]?.[0]).toBe("/api/v1/workspace-groups");
  expect(calls()[1]?.[0]).toBe("/api/v1/workspace-groups");
  expect(calls()[1]?.[1].method).toBe("POST");
  expect(bodyOf(1)).toEqual({ name: "组", tone: 2 });
  expect(calls()[2]?.[0]).toBe("/api/v1/workspace-groups/g%201");
  expect(calls()[2]?.[1].method).toBe("PATCH");
  expect(bodyOf(2)).toEqual({ collapsed: true, order: 3 });
  expect(calls()[3]?.[0]).toBe("/api/v1/workspace-groups/g%201");
  expect(calls()[3]?.[1].method).toBe("DELETE");
});
