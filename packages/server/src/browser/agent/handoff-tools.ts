// 接管（browser_handoff）与展示（browser_show）：两个找用户的工具。
// handoff 的方向由页面此刻的操作者定：agent 的页面请用户接管，用户的页面请求使用它（用户点「交给 agent」才切操作权）；
// show 不阻塞、不改操作权，只让在线的界面弹一条提示。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  guarded,
  INTENT_DESCRIPTION,
  intentArg,
  pageIdArg,
  stringArg,
  text,
} from "./args.js";
import {
  askHandoff,
  type HandoffDirection,
  type HandoffOutcome,
} from "./handoff.js";
import type { Kit } from "./kit.js";

// 页面交回 agent 之后，回给模型的那一行 ACTION 说明。
const HANDOFF_ACTION = {
  operate: "handoff: user finished and returned the page",
  claim: "handoff: user handed the page to the agent",
} as const;

// browser_show 的 note 上限：一句说明，不是正文。
const NOTE_MAX = 300;

/** 接管与展示：browser_handoff、browser_show。 */
export function registerHandoffTools(
  pi: Parameters<ExtensionFactory>[0],
  kit: Kit,
): void {
  const deps = kit.deps;
  const sessionId = kit.sessionId;
  const { acted, content } = kit;

  const handoffText = async (
    outcome: HandoffOutcome,
    pageId: string,
    direction: HandoffDirection,
    intent: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    if (outcome.kind === "done") {
      // 交还：只有用户点「我已操作完成」（claim 方向是「交给 agent」）才把操作权给回 agent，epoch 由注册表加一。
      // 基线不作废：用户手动操作造成的变化会出现在这次的 diff 里（登录之后地址变了就自然走完整路径）。
      deps.registry.control(pageId, "agent");
      await acted(
        "browser_handoff",
        pageId,
        direction === "claim"
          ? "用户把页面交给了 agent"
          : "用户接管完成，页面已交还 agent",
      );
      // 等用户期间页面可能被休眠或随浏览器崩了，等待前的句柄不能再用：重新取（休眠的会唤醒）。
      // 用户交还时界面上可能还挂着对话框：不拦。
      const fresh = await deps.registry.use(pageId, sessionId, "observe", {
        allowDialog: true,
      });
      const out = await content({
        pageId,
        handle: fresh,
        action: HANDOFF_ACTION[direction],
        ...(intent === undefined ? {} : { intent }),
        ...(signal === undefined ? {} : { signal }),
      });
      // 用户顺带写的话接在页面内容之后，别让模型漏看。
      return outcome.note === undefined
        ? out
        : `${out}\n用户补充：${outcome.note}`;
    }
    if (outcome.kind === "refused") {
      if (direction === "claim")
        return outcome.reason.trim() === ""
          ? "用户拒绝了使用这个页面的请求"
          : `用户拒绝了使用这个页面的请求：${outcome.reason}`;
      return outcome.reason.trim() === ""
        ? "用户拒绝了接管请求。"
        : `用户拒绝了接管请求：${outcome.reason}`;
    }
    return outcome.kind === "timeout" ? "用户没有回应" : "已取消";
  };

  pi.registerTool({
    name: "browser_handoff",
    label: "请用户接管页面",
    description:
      "这个页面有两种用法。页面是你的（agent 在操作）：请用户接管，等你需要的操作（如登录、过人机校验）完成后交还。页面此刻是用户在操作的：就是请求使用它，用户点「交给 agent」才会切给你（你不能自行夺取）。默认阻塞到用户答复；想同时干别的就用 job_start 把它放后台。拿到页面时附页面内容（与交出前的状态做对比，用户手动改动会出现在里面；登录之后地址变了就重新读页面）。用户拒绝、超时或取消时原样告诉你。",
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description:
            "为什么需要用户接管 / 为什么要用这个页面，如「需要登录」",
        },
        intent: {
          type: "string",
          maxLength: 500,
          description: INTENT_DESCRIPTION,
        },
      },
      required: ["pageId", "reason"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as {
        pageId?: unknown;
        reason?: unknown;
        intent?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const reason = stringArg(
        p.reason,
        "reason",
        "写清为什么需要用户接管，如「需要登录」",
      );
      const intent = intentArg(p.intent);
      return guarded(async () => {
        // 用户接管时本来就要面对对话框：不拦。
        const handle = await deps.registry.use(pageId, sessionId, "observe", {
          allowDialog: true,
        });
        const pageTitle = await handle.title();
        const url = handle.url();
        // 聊天里的提问卡片与页面上的横幅谁先答谁生效；另一边随之撤销。
        // 等答复期间不能被休眠；任何结果（包括提问本身出错）都要复位。
        const wait = deps.registry.beginHandoff(pageId, reason);
        const asking = new AbortController();
        let outcome: HandoffOutcome;
        // 方向按开始时的操作者定：用户正在操作这个页面 = 请求使用它。
        const direction =
          deps.registry.get(pageId)?.controller === "user"
            ? "claim"
            : "operate";
        try {
          outcome = await Promise.race([
            askHandoff(
              deps.ask,
              { pageTitle, url, reason, direction },
              asking.signal,
            ),
            wait.answered,
          ]);
        } finally {
          asking.abort();
          wait.end();
        }
        return text(
          await handoffText(outcome, pageId, direction, intent, signal),
        );
      });
    },
  });

  pi.registerTool({
    name: "browser_show",
    label: "展示页面给用户",
    description:
      "不阻塞地向用户展示一个页面：做完活想让用户直接看到并给反馈时用它，只展示你希望用户看的那一个。调用立刻返回，不改页面的操作权，也不返回页面内容；工作区里在线的界面会收到提示，用户点「查看」才切过去，你不会收到用户是否查看的通知。要等用户反馈请用 ask_user。",
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        note: {
          type: "string",
          maxLength: NOTE_MAX,
          description: `可选：给用户的一句话说明（最多 ${NOTE_MAX} 字）`,
        },
      },
      required: ["pageId"],
    } as never,
    async execute(_id, params) {
      const p = params as { pageId?: unknown; note?: unknown };
      const pageId = pageIdArg(p.pageId);
      const note =
        p.note === undefined
          ? ""
          : stringArg(p.note, "note", "note 是可选的一句说明文字");
      return guarded(async () => {
        // 不 registry.use：展示不该唤醒休眠页，也不要求租约。
        const view = deps.registry.get(pageId);
        if (!view || view.workspaceKey !== deps.workspaceKey())
          throw new Error(`页面 ${pageId} 不存在或不在本工作区`);
        const delivered = deps.show({
          pageId,
          title: view.title,
          url: view.url,
          note,
        });
        // 展示不改页面，所以不调 acted（它还会记一步回放画面）；用户点「查看」就是确认。
        deps.audit?.({
          tool: "browser_show",
          pageId,
          summary: `展示页面给用户${note === "" ? "" : `：${note}`}`,
        });
        return text(
          delivered > 0
            ? `已向 ${delivered} 个在线界面发出展示提示；用户点「查看」才会切到这个页面，你不会收到用户是否查看的通知。需要用户反馈请用 ask_user。`
            : "没有在线的界面，提示未送达，用户现在看不到这个页面。",
        );
      });
    },
  });
}
