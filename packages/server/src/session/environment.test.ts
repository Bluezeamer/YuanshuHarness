import { expect, test } from "vitest";
import {
  cwdSection,
  environmentSection,
  formatStarted,
  localFacts,
  probeFacts,
} from "./environment.js";
import { lineDiff } from "./state-map.js";

const started = "2026-11-08T01:12:00.000Z";
const local = {
  name: "local",
  facts: "Darwin 25.3.0, arm64",
  disconnected: false,
  directories: [{ ref: "local:proj", path: "/Users/me/proj" }],
};
const gpu = {
  name: "gpu-box",
  facts: "Linux 6.5.0-27-generic, x86_64",
  disconnected: false,
  directories: [{ ref: "gpu-box:train", path: "/data/train" }],
};

test("创建时间按给定时区写成「日期 时间 (UTC±hh:mm)」，非法时间不写", () => {
  expect(formatStarted(started, 480)).toBe("2026-11-08 09:12 (UTC+08:00)");
  expect(formatStarted(started, 0)).toBe("2026-11-08 01:12 (UTC+00:00)");
  expect(formatStarted(started, -330)).toBe("2026-11-07 19:42 (UTC-05:30)");
  expect(formatStarted("不是时间")).toBeNull();
});

test("只有本机：表头带创建时间与提醒，段首句说明目录写作 <host>:<name>", () => {
  const text = environmentSection({
    startedAt: started,
    offsetMinutes: 480,
    hosts: [local],
  });
  expect(text).toContain("Session started: 2026-11-08 09:12 (UTC+08:00).");
  expect(text).toContain("do not infer the current year from memory");
  expect(text).toContain("run `date`");
  expect(text).toContain('- "local": Darwin 25.3.0, arm64');
  expect(text).toContain(
    "A directory is written <host>:<name>; relative paths and bash use the current directory",
  );
  expect(text).not.toContain("exactly one host");
});

test("多台主机：每台一行，没探测到系统的写「system not detected yet」", () => {
  const text = environmentSection({
    startedAt: started,
    offsetMinutes: 480,
    hosts: [
      local,
      gpu,
      {
        name: "staging",
        facts: null,
        disconnected: false,
        directories: [],
      },
    ],
  });
  expect(text).toContain("Hosts in this session, with their directories.");
  expect(text).toContain('- "gpu-box": Linux 6.5.0-27-generic, x86_64\n');
  expect(text).toContain('- "staging": system not detected yet');
});

test("每台主机下列出它的目录（引用写法与路径），不标当前目录", () => {
  const text = environmentSection({
    startedAt: null,
    hosts: [
      {
        ...local,
        directories: [
          { ref: "local:proj", path: "/Users/me/proj" },
          { ref: "local:docs", path: "/Users/me/docs" },
        ],
      },
      gpu,
    ],
  });
  expect(text).toContain(
    [
      '- "local": Darwin 25.3.0, arm64',
      "  - local:proj  /Users/me/proj",
      "  - local:docs  /Users/me/docs",
      '- "gpu-box": Linux 6.5.0-27-generic, x86_64',
      "  - gpu-box:train  /data/train",
    ].join("\n"),
  );
});

test("用户断开的主机仍在清单里，并告诉模型让用户去激活、别重试", () => {
  const text = environmentSection({
    startedAt: null,
    hosts: [local, { ...gpu, disconnected: true }],
  });
  expect(text).toContain(
    '- "gpu-box": Linux 6.5.0-27-generic, x86_64 — DISCONNECTED by the user.',
  );
  expect(text).toContain("Settings → Remote connections");
  expect(text).toContain("do not retry");
});

test("没有创建时间就不写时间行；没有主机整段不出", () => {
  const text = environmentSection({ startedAt: null, hosts: [local] });
  expect(text).not.toContain("Session started");
  expect(environmentSection({ startedAt: started, hosts: [] })).toBeNull();
});

test("接入 / 断开 / 移除主机各自只改对应的行，状态通知里是干净的差异", () => {
  const at = { startedAt: started, offsetMinutes: 480 };
  const one = environmentSection({ ...at, hosts: [local] }) ?? "";
  const two = environmentSection({ ...at, hosts: [local, gpu] }) ?? "";
  const cut =
    environmentSection({
      ...at,
      hosts: [local, { ...gpu, disconnected: true }],
    }) ?? "";
  // 接入：新增这台主机与它的目录
  expect(lineDiff(one, two)).toBe(
    [
      '+ - "gpu-box": Linux 6.5.0-27-generic, x86_64',
      "+   - gpu-box:train  /data/train",
    ].join("\n"),
  );
  // 断开：只换 gpu-box 那一行
  const diff = lineDiff(two, cut).split("\n");
  expect(diff).toHaveLength(2);
  expect(diff[0]).toBe('- - "gpu-box": Linux 6.5.0-27-generic, x86_64');
  expect(diff[1]).toContain("DISCONNECTED by the user");
  // 重新激活：反向，回到原文
  expect(lineDiff(cut, two).split("\n")[1]).toBe(
    '+ - "gpu-box": Linux 6.5.0-27-generic, x86_64',
  );
  // 同一份输入文本稳定：创建时间不变就不会有差异
  expect(environmentSection({ ...at, hosts: [local, gpu] })).toBe(two);
});

test("本机系统事实是「内核名 版本, 架构」；ssh 探测的「 · 」换成逗号", () => {
  expect(localFacts()).toMatch(/^\S+ \S+, \S+$/);
  expect(probeFacts("Linux 6.5.0-27-generic · x86_64")).toBe(
    "Linux 6.5.0-27-generic, x86_64",
  );
});

test("子代理的 <cwd> 写它自己工作的目录，并说明不能切换", () => {
  expect(
    cwdSection({ ref: "dev1:train", path: "/data/train" }, { sub: true }),
  ).toBe(
    "The session works in the directory dev1:train (/data/train). It cannot switch directories; relative paths and bash use it.",
  );
});

test("<cwd> 段只有主目录的引用与路径：不说当前目录在哪，因为切换不由它负责", () => {
  expect(cwdSection({ ref: "local:proj", path: "/Users/me/proj" })).toBe(
    "The session starts in its main directory local:proj (/Users/me/proj). The current directory starts there; relative paths and bash use the current directory.",
  );
});
