import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { McpSessionStatus } from "../mcp/session-status.js";
import { SudoProbe } from "../permission/sudo.js";
import type { SubagentSpec } from "../store/subagents.js";
import { buildExtensions, type ExtensionHost } from "./extensions.js";
import type { PoolDeps } from "./pool.js";

// 扩展装配的特征测试：把每个扩展跑一遍，只记它注册的工具与订阅的事件。
// 钉住「装哪些、什么顺序、什么条件下装」（B0 搬家前后快照一致）；装配是纯函数，host 用假的。

type Brief = { tools: string[]; events: string[]; other: string[] };

function brief(factory: ExtensionFactory): Brief {
  const out: Brief = { tools: [], events: [], other: [] };
  const pi = new Proxy(
    {},
    {
      get: (_t, prop) => (arg: unknown) => {
        if (prop === "registerTool")
          out.tools.push((arg as { name: string }).name);
        else if (prop === "on") out.events.push(String(arg));
        else out.other.push(String(prop));
      },
    },
  );
  void factory(pi as never);
  return out;
}

const fmt = (list: ExtensionFactory[]) =>
  list.map((f) => {
    const b = brief(f);
    return [
      b.tools.length ? `tools:${b.tools.join(",")}` : "",
      b.events.length ? `on:${b.events.join(",")}` : "",
      b.other.length ? `other:${b.other.join(",")}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  });

const fake = <T>(): T => ({}) as T;
const FULL: Partial<PoolDeps> = {
  hooks: fake(),
  secrets: fake(),
  browser: fake(),
  jobs: fake(),
  calls: fake(),
  reviewerFactory: fake(),
  references: fake(),
  canvas: fake(),
};
const SPEC: SubagentSpec = {
  agentPresetId: "a",
  directoryIds: [],
  primaryDirectoryId: "",
  tierCap: "rules",
};
const WS = {
  id: "w",
  name: "w",
  path: "/w",
  environmentId: "local",
  tier: "rules",
} as never;

function build(
  extra: Partial<PoolDeps>,
  args: {
    mcp?: boolean;
    spec?: SubagentSpec;
    subagents?: boolean;
  } = {},
) {
  const host: ExtensionHost = {
    deps: { directories: fake(), rules: fake(), ...extra } as PoolDeps,
    entries: new Map(),
    sudoProbe: new SudoProbe(),
    subagentHooks: () =>
      args.subagents ? ({ tools: () => () => {} } as never) : null,
    observe: () => {},
    envOf: () => null,
    visibleDirectories: () => [],
    workspaceIdOf: () => null,
    directoryViews: () => [],
    switchDirectory: () => {
      throw new Error("not used");
    },
    addressBookOf: () =>
      ({
        refOf: () => "local:w",
        directory: () => WS,
      }) as never,
    switchSkillNotice: async () => "",
    sessionTier: () => "rules",
    effectiveTier: () => "rules",
    toolDescriptionOverrides: () => undefined,
    liveRender: () => null,
    modeChoices: () => [],
    setActiveMode: () => {},
    bindDelivery: () => {},
    delivery: {
      baselineTools: () => [],
      activeMode: () => null,
      modeCount: () => 0,
      canPost: () => false,
      promptSlots: () => ({}),
    },
    permissionCtxOf: () => {
      throw new Error("not used");
    },
    primaryDirectory: () => WS as never,
    connectionName: () => undefined,
  };
  const mcp = args.mcp
    ? {
        servers: () => [],
        config: () => ({ servers: [], errors: [], failed: [] }),
        home: null,
        status: new McpSessionStatus(),
        loaded: { sig: null, names: new Set<string>() },
      }
    : null;
  return fmt(buildExtensions(host, "sid", WS, [], mcp, args.spec));
}

describe("扩展装配", () => {
  test("只有基础依赖的根会话", () => {
    expect(build({})).toMatchInlineSnapshot(`
      [
        "on:before_agent_start",
        "on:context_with_system",
        "on:before_agent_start",
        "on:before_agent_start,tool_call",
        "tools:call_tool",
        "tools:switch_mode",
        "tools:ask_user",
        "tools:get_goal,create_goal,update_goal",
        "tools:todo_write",
        "tools:read,write,edit,bash,ls,find,grep",
        "tools:list_directories,switch_directory on:before_agent_start",
        "tools:transfer_files",
        "on:tool_call",
      ]
    `);
  });

  test("依赖齐全的根会话（含 MCP、subagent 工具）", () => {
    expect(build(FULL, { mcp: true, subagents: true })).toMatchInlineSnapshot(`
      [
        "on:before_agent_start",
        "on:context_with_system",
        "on:before_agent_start",
        "on:session_start,before_agent_start,tool_call,turn_start,mcp_servers_change,session_shutdown other:registerToolRenderer,registerCommand",
        "on:before_agent_start,tool_call",
        "tools:call_tool",
        "tools:switch_mode",
        "on:tool_call,tool_result,input,agent_settled",
        "tools:ask_user",
        "tools:get_goal,create_goal,update_goal",
        "tools:todo_write",
        "tools:read,write,edit,bash,ls,find,grep",
        "on:before_agent_start",
        "on:tool_result",
        "tools:browser_open,browser_pages,browser_close,browser_snapshot,browser_click,browser_type,browser_press,browser_dialog,browser_move,browser_scroll,browser_drag,browser_nav,browser_upload,browser_screenshot,browser_console,browser_assets,browser_dom,browser_network,browser_exec,browser_storage,browser_request,browser_route,browser_emulate,browser_cdp,browser_handoff,browser_show",
        "",
        "tools:job_start,job_list,job_stop,job_remind",
        "tools:canvas_edit",
        "on:tool_call",
        "tools:list_directories,switch_directory on:before_agent_start",
        "tools:transfer_files",
        "on:tool_call",
        "on:tool_execution_start,tool_execution_end,message_update,context,before_provider_request,message_end",
      ]
    `);
  });

  test("子会话：没有 askUser 与浏览器，有无人值守的权限扩展", () => {
    expect(
      build(FULL, { mcp: true, subagents: true, spec: SPEC }),
    ).toMatchInlineSnapshot(`
      [
        "on:before_agent_start",
        "on:context_with_system",
        "on:before_agent_start",
        "on:session_start,before_agent_start,tool_call,turn_start,mcp_servers_change,session_shutdown other:registerToolRenderer,registerCommand",
        "on:before_agent_start,tool_call",
        "tools:call_tool",
        "on:tool_call,tool_result,input,agent_settled",
        "tools:todo_write",
        "tools:read,write,edit,bash,ls,find,grep",
        "on:before_agent_start",
        "on:tool_result",
        "",
        "tools:job_start,job_list,job_stop,job_remind",
        "tools:canvas_edit",
        "on:tool_call",
        "tools:list_directories on:before_agent_start",
        "tools:transfer_files",
        "on:tool_call",
        "on:tool_execution_start,tool_execution_end,message_update,context,before_provider_request,message_end",
      ]
    `);
  });
});

describe("canvas_edit 的缺省目录", () => {
  test("会话切到别的目录后，不写 directory 仍落在逻辑 local 目录", async () => {
    const dirs = new Map([
      [
        "local-1",
        {
          id: "local-1",
          name: "主目录",
          path: "/w/local",
          environmentId: "local",
        },
      ],
      [
        "remote-1",
        {
          id: "remote-1",
          name: "远端",
          path: "/w/remote",
          environmentId: "ssh-1",
        },
      ],
    ]);
    const repos: Array<{ environmentId: string; path: string }> = [];
    // 当前已切到 remote：current() 给的是它，缺省不能跟着走。
    const host: ExtensionHost = {
      deps: {
        directories: { get: (id: string) => dirs.get(id) },
        rules: fake(),
        canvas: {
          repo: (environmentId: string, p: string) => {
            repos.push({ environmentId, path: p });
            return {};
          },
        },
      } as unknown as PoolDeps,
      entries: new Map([["sid", { directoryId: "remote-1" } as never]]),
      sudoProbe: new SudoProbe(),
      subagentHooks: () => null,
      observe: () => {},
      envOf: () => null,
      visibleDirectories: () => [...dirs.values()] as never,
      workspaceIdOf: () => null,
      directoryViews: () =>
        [
          { id: "local-1", role: "local", current: false },
          { id: "remote-1", role: "remote", current: true },
        ] as never,
      switchDirectory: () => {
        throw new Error("not used");
      },
      addressBookOf: () =>
        ({
          refOf: (w: { name: string }) => `local:${w.name}`,
          directory: (ref: string) => {
            const hit = [...dirs.values()].find(
              (w) => `local:${w.name}` === ref,
            );
            if (!hit) throw new Error(`Directory "${ref}" not found.`);
            return hit;
          },
        }) as never,
      switchSkillNotice: async () => "",
      sessionTier: () => "rules",
      effectiveTier: () => "rules",
      toolDescriptionOverrides: () => undefined,
      liveRender: () => null,
      modeChoices: () => [],
      setActiveMode: () => {},
      bindDelivery: () => {},
      delivery: {
        baselineTools: () => [],
        activeMode: () => null,
        modeCount: () => 0,
        canPost: () => false,
        promptSlots: () => ({}),
      },
      permissionCtxOf: () => {
        throw new Error("not used");
      },
      primaryDirectory: () => dirs.get("local-1") as never,
      connectionName: () => undefined,
    };
    const canvasExt = buildExtensions(host, "sid", WS, [], null).find((f) =>
      brief(f).tools.includes("canvas_edit"),
    ) as ExtensionFactory;
    let run: ((id: string, p: unknown) => Promise<unknown>) | null = null;
    void canvasExt({
      registerTool: (t: {
        name: string;
        execute: (id: string, p: unknown) => Promise<unknown>;
      }) => {
        if (t.name === "canvas_edit") run = t.execute;
      },
      on: () => {},
    } as never);
    // 仓库是假的：只关心缺省落到哪个目录，调用在 applyOps 里失败，忽略结果。
    const exec = run as unknown as (id: string, p: unknown) => Promise<unknown>;
    await exec("t1", { ops: [{ op: "create_canvas", name: "b" }] }).catch(
      () => {},
    );
    expect(repos[0]).toEqual({ environmentId: "local", path: "/w/local" });
  });

  test("directory 写 <host>:<name>：解析走地址簿；缺省主目录不在可见清单里时报画布不可用", async () => {
    const local = {
      id: "local-1",
      name: "主目录",
      path: "/w/local",
      environmentId: "local",
    };
    const remote = {
      id: "remote-1",
      name: "远端",
      path: "/w/remote",
      environmentId: "ssh-1",
    };
    const repos: Array<{ environmentId: string; path: string }> = [];
    const make = (visible: unknown[], primary: unknown) =>
      ({
        deps: {
          directories: { get: () => undefined },
          rules: fake(),
          canvas: {
            repo: (environmentId: string, p: string) => {
              repos.push({ environmentId, path: p });
              // 仓库是假的，跑不到 applyOps 的落盘：只关心选的是哪个目录
              return { settle: async () => {}, isClean: async () => false };
            },
          },
        } as unknown as PoolDeps,
        entries: new Map([["sid", { directoryId: "remote-1" } as never]]),
        sudoProbe: new SudoProbe(),
        subagentHooks: () => null,
        observe: () => {},
        envOf: () => null,
        visibleDirectories: () => visible as never,
        workspaceIdOf: () => null,
        directoryViews: () => visible as never,
        switchDirectory: () => {
          throw new Error("not used");
        },
        addressBookOf: () =>
          ({
            refOf: (w: { environmentId: string; name: string }) =>
              `${w.environmentId === "local" ? "local" : "dev1"}:${w.name}`,
            directory: (ref: string) => {
              if (!ref.includes(":"))
                throw new Error("A directory is written <host>:<name>.");
              const hit = [local, remote].find(
                (w) =>
                  `${
                    w.environmentId === "local" ? "local" : "dev1"
                  }:${w.name}` === ref,
              );
              if (!hit) throw new Error(`Directory "${ref}" not found.`);
              return hit;
            },
          }) as never,
        switchSkillNotice: async () => "",
        sessionTier: () => "rules",
        effectiveTier: () => "rules",
        toolDescriptionOverrides: () => undefined,
        liveRender: () => null,
        modeChoices: () => [],
        setActiveMode: () => {},
        bindDelivery: () => {},
        delivery: {
          baselineTools: () => [],
          activeMode: () => null,
          modeCount: () => 0,
          canPost: () => false,
          promptSlots: () => ({}),
        },
        permissionCtxOf: () => {
          throw new Error("not used");
        },
        primaryDirectory: () => primary as never,
        connectionName: () => undefined,
      }) as ExtensionHost;

    const run = async (host: ExtensionHost, args: Record<string, unknown>) => {
      const ext = buildExtensions(host, "sid", WS, [], null).find((f) =>
        brief(f).tools.includes("canvas_edit"),
      ) as ExtensionFactory;
      let exec:
        | ((
            id: string,
            p: unknown,
          ) => Promise<{ content: { text: string }[]; isError?: boolean }>)
        | null = null;
      void ext({
        registerTool: (t: {
          name: string;
          execute: (id: string, p: unknown) => Promise<never>;
        }) => {
          if (t.name === "canvas_edit") exec = t.execute;
        },
        on: () => {},
      } as never);
      const call = exec as unknown as (
        id: string,
        p: unknown,
      ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
      return call("t1", args);
    };

    // 点名另一个目录：落在它上面（结果里的引用写法由 canvas/tool.test.ts 钉住）
    await run(make([local, remote], local), {
      directory: "dev1:远端",
      ops: [{ op: "create_canvas", name: "b" }],
    });
    expect(repos[0]).toEqual({ environmentId: "ssh-1", path: "/w/remote" });

    // 名字与 id 都不认：报错原文来自地址簿
    const bad = await run(make([local, remote], local), {
      directory: "远端",
      ops: [{ op: "create_canvas", name: "b" }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain(
      "A directory is written <host>:<name>",
    );

    // 缺省是主目录；主目录不在可见清单里（子代理在别的目录）就是拿不到
    const missing = await run(make([remote], local), {
      ops: [{ op: "create_canvas", name: "b" }],
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("画布不可用");
    expect(missing.content[0]?.text).toContain("local:主目录");
  });
});
