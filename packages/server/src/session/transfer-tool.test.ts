import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import type { AuditInput, AuditLog } from "../store/audit.js";
import type { Directory } from "../store/directories.js";
import { makeAddressBook } from "./address-testkit.js";
import { transferExtension } from "./transfer-tool.js";

describe("transfer_files：执行与审计", () => {
  let root = "";
  let A: Directory;
  let B: Directory;
  let DEV: Directory;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-xtool-")));
    mkdirSync(path.join(root, "a"));
    mkdirSync(path.join(root, "b"));
    mkdirSync(path.join(root, "dev"));
    A = w("id-a", "A", path.join(root, "a"));
    B = w("id-b", "B", path.join(root, "b"));
    DEV = w("id-dev", "dev", path.join(root, "dev"), "e1");
    writeFileSync(path.join(root, "a", "f.txt"), "hello");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function tool(current: Directory, envs: Record<string, LocalEnv> = {}) {
    const records: AuditInput[] = [];
    const audit = {
      record: (r: AuditInput) => records.push(r),
    } as unknown as AuditLog;
    const local = envs.local ?? new LocalEnv();
    const dev = envs.dev ?? new LocalEnv();
    const book = makeAddressBook({
      dirs: [A, B, DEV],
      currentId: current.id,
      primaryId: A.id,
      envOf: (d) =>
        d.environmentId === "e1"
          ? (dev as unknown as LocalEnv)
          : (local as unknown as LocalEnv),
      connectionName: (id) => (id === "e1" ? "dev1" : undefined),
    });
    let execute:
      | ((id: string, p: unknown, s?: AbortSignal) => Promise<unknown>)
      | undefined;
    transferExtension({
      sessionId: "sess-1",
      locate: (h, p) => book.locate(h, p),
      audit,
    })({
      registerTool: (t: { name: string; execute: typeof execute }) => {
        expect(t.name).toBe("transfer_files");
        execute = t.execute;
      },
      on: () => {},
    } as never);
    return {
      records,
      run: (p: Record<string, unknown>, s?: AbortSignal) =>
        (execute as NonNullable<typeof execute>)("c1", p, s),
    };
  }

  test("成功：结果文字带两端的 host:path 与统计，审计 actor=agent、带会话 id", async () => {
    const t = tool(A);
    const r = (await t.run({
      from: "f.txt",
      to_host: "local",
      to: path.join(root, "b", "g.txt"),
    })) as { content: { text: string }[] };
    expect(readFileSync(path.join(root, "b", "g.txt"), "utf8")).toBe("hello");
    expect(r.content[0]?.text).toBe(
      `Transferred 1 file(s), 5 bytes, skipped 0 symlink(s) (neither followed nor copied): local:${path.join(root, "a", "f.txt")} -> local:${path.join(root, "b", "g.txt")}`,
    );
    expect(t.records).toMatchObject([
      {
        sessionId: "sess-1",
        actor: "agent",
        kind: "transfer",
        environmentId: "local",
        detail: { outcome: "ok", files: 1, bytes: 5 },
      },
    ]);
  });

  test("跨主机：两端地址各取各自的主机名与路径", async () => {
    const t = tool(A);
    await t.run({
      from_host: "local:A",
      from: "f.txt",
      to_host: "dev1",
      to: path.join(root, "dev", "g.txt"),
    });
    expect(readFileSync(path.join(root, "dev", "g.txt"), "utf8")).toBe("hello");
    expect(t.records[0]).toMatchObject({
      // 审计的环境取目标端（这里用的是本地实现的替身，id 仍是 local）
      environmentId: "local",
      detail: { outcome: "ok", files: 1, bytes: 5 },
    });
  });

  test("TransferError 的 message 原样抛出，审计记它的 code", async () => {
    const t = tool(A);
    await expect(
      t.run({
        from: "f.txt",
        to_host: "local",
        to: path.join(root, "b", "g.txt"),
      }),
    ).rejects.toThrow(`目标已存在 1 个文件：${path.join(root, "b", "g.txt")}`);
    expect(t.records[0]).toMatchObject({
      detail: { outcome: "conflict", result: "error" },
    });
  });

  test("中途取消：审计记 cancelled", async () => {
    const t = tool(A);
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      t.run(
        {
          from: "f.txt",
          to_host: "local",
          to: path.join(root, "b", "h.txt"),
        },
        ctl.signal,
      ),
    ).rejects.toThrow();
    expect(t.records[0]).toMatchObject({ detail: { outcome: "cancelled" } });
  });

  test("host 管这次调用的路径：点名目录时相对路径从那个目录起", async () => {
    const t = tool(A);
    const r = (await t.run({
      from: "f.txt",
      from_host: "local:A",
      to_host: "local:B",
      to: "from-host.txt",
    })) as { content: { text: string }[] };
    expect(readFileSync(path.join(root, "b", "from-host.txt"), "utf8")).toBe(
      "hello",
    );
    expect(r.content[0]?.text).toContain(
      `local:${path.join(root, "a", "f.txt")} -> local:${path.join(root, "b", "from-host.txt")}`,
    );
  });

  test("地址解析不了 / 主机不可用：报错，不算一次传输，不记审计", async () => {
    const t = tool(A);
    await expect(
      t.run({ from: "f.txt", to_host: "ghost", to: "/x" }),
    ).rejects.toThrow('Unknown host "ghost"');
    expect(t.records).toEqual([]);

    // 目标主机不可用（envOf 返回 null）
    const book = makeAddressBook({
      dirs: [A, B],
      currentId: "id-a",
      primaryId: "id-a",
      envOf: (d) => (d.environmentId === "local" ? (null as never) : null),
    });
    let execute: ((id: string, p: unknown) => Promise<unknown>) | undefined;
    transferExtension({
      sessionId: "sess-2",
      locate: (h, p) => book.locate(h, p),
    })({
      registerTool: (t2: { execute: typeof execute }) => {
        execute = t2.execute;
      },
      on: () => {},
    } as never);
    await expect(
      (execute as NonNullable<typeof execute>)("c1", {
        from: "f.txt",
        to: "x",
      }),
    ).rejects.toThrow('Host "local" is not available.');
  });

  test("声明里有 from_host / to_host，描述照抄", () => {
    const got: Record<string, unknown>[] = [];
    transferExtension({
      sessionId: "s",
      locate: async () => {
        throw new Error("unused");
      },
    })({
      registerTool: (t: { parameters: unknown }) =>
        got.push(t.parameters as never),
      on: () => {},
    } as never);
    const props = (
      got[0] as { properties: Record<string, { description: string }> }
    ).properties;
    expect(props.from?.description).toBe("Source path (file or directory)");
    expect(props.to?.description).toBe("Destination path");
    expect(props.from_host?.description).toBe(
      'Host, or host:directory, that "from" is on. Omit to use the current directory. A host on its own needs an absolute path.',
    );
    expect(props.to_host?.description).toBe(
      'Host, or host:directory, that "to" is on. Omit to use the current directory. A host on its own needs an absolute path.',
    );
  });
});

const w = (
  id: string,
  name: string,
  dir: string,
  environmentId = "local",
): Directory => ({ id, name, path: dir, environmentId, createdAt: "t" });
