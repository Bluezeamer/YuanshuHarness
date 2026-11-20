// 模型可见的协作区文字：开场说明、报告行、团队成员的开场与建队结果。
// 协作区是虚拟主机 collab：文字里只出现 host="collab" 加 `/` 开头的路径，不出现 Server 的真实路径。
import { expect, test } from "vitest";
import { deliveredText, openingBrief } from "../subagent/messages.js";
import { createdText, memberBrief } from "../team/messages.js";

const brief = (collab?: { ownPath: string }) =>
  openingBrief({
    task: "T",
    fork: false,
    depth: 1,
    maxDepth: 3,
    mode: null,
    where: { ref: "local:proj", path: "/srv/proj" },
    ...(collab ? { collab } : {}),
  });

test("开场说明：协作区一行写虚拟主机 collab 与自己的路径", () => {
  expect(brief({ ownPath: "/019a1b" })).toContain(
    '- Shared folder: the virtual host collab. You can write files under /019a1b/ (write and edit with host="collab", no approval needed); every session in this tree can read all of it (read, ls, find and grep with host="collab"). Use it for material that is too long for your delivery summary.',
  );
  // 没有协作区时不带这一行
  expect(brief()).not.toContain("Shared folder");
});

test("报告行：按虚拟主机地址给出路径，字节数照旧", () => {
  expect(
    deliveredText(
      "job-1",
      "done",
      { path: "/data/collab/r1/c1/report.md", bytes: 42 },
      undefined,
      "/c1/report.md",
    ),
  ).toBe(
    '[Subagent job-1 delivered]\ndone\nFull report: host="collab", path="/c1/report.md" (42 bytes). Read it only if you need the detail.\nSend it a follow-up with message_subagent { "id": "job-1", "text": ... } if you need more.',
  );
  expect(deliveredText("job-1", "done")).not.toContain("Full report:");
});

test("团队成员：公告板、共享文件夹与自己的文件夹都写成 collab 地址", () => {
  const ctx = {
    childId: "c1",
    root: "r1",
    depth: 1,
    maxDepth: 3,
    fork: false,
    mode: null,
    collab: { ownPath: "/c1" },
  };
  const text = memberBrief({ name: "alpha", board: "", ctx });
  expect(text).toContain('Team board: host="collab", path="/board.md"');
  expect(text).toContain(
    '- Shared folder: the virtual host collab. Every session in the team can read all of it (read, ls, find and grep with host="collab").',
  );
  expect(text).toContain(
    'Your own folder, where you can write files without approval: host="collab", path="/c1/"',
  );
});

test("建队结果：板子的地址写成 collab 地址", () => {
  expect(createdText(["alpha"])).toContain(
    'The board is host="collab", path="/board.md".',
  );
});
