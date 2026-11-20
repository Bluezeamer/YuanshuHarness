// 回放：agent 改变页面的动作做完后存一张画面加一行说明，事后按时间线翻看。
// 行记在根会话名下；每个会话只留最近 maxSteps 步，挤掉的最旧步连图片一起删。

import type {
  BrowserStepStore,
  SessionSteps,
  StepRow,
} from "../../store/browser-steps.js";
import type { PageRegistry } from "../pages/registry.js";
import type { FrameStore } from "./frames.js";

export const REPLAY_MAX_STEPS = 300;

export interface ReplayDeps {
  steps: BrowserStepStore;
  frames: FrameStore;
  /** 只用 peek：休眠页或已关闭的页面没有句柄，这一步就不记。 */
  registry: Pick<PageRegistry, "peek">;
  rootOf(sessionId: string): string;
  maxSteps?: number; // 测试用，默认 REPLAY_MAX_STEPS
}

export interface StepInput {
  sessionId: string;
  workspaceKey: string;
  pageId: string;
  tool: string;
  summary: string;
}

export class Replay {
  constructor(private readonly deps: ReplayDeps) {}

  /** 记一步：截一张当前画面（handle.screenshot()）、取 url 与标题、写行与图片、挤掉的旧步的图片一并删。**永远不抛**：回放是附属功能，截图失败（页面刚关、崩了）不能让 agent 的动作失败；这是全文件唯一的 try/catch。 */
  async record(input: StepInput): Promise<void> {
    const handle = this.deps.registry.peek(input.pageId);
    if (!handle) return;
    const sessionId = this.deps.rootOf(input.sessionId);
    try {
      // 先截图：截图失败就什么都不写。
      const jpeg = await handle.screenshot();
      const { id, dropped } = this.deps.steps.insert(
        {
          workspaceKey: input.workspaceKey,
          sessionId,
          pageId: input.pageId,
          ts: new Date().toISOString(),
          tool: input.tool,
          summary: input.summary,
          url: handle.url(),
          title: await handle.title(),
        },
        this.deps.maxSteps ?? REPLAY_MAX_STEPS,
      );
      this.deps.frames.save(sessionId, id, jpeg);
      this.deps.frames.remove(sessionId, dropped);
    } catch {
      // 回放记不下来不影响动作本身。
    }
  }

  sessions(workspaceKey: string): SessionSteps[] {
    return this.deps.steps.listSessions(workspaceKey);
  }

  steps(workspaceKey: string, sessionId: string): StepRow[] {
    return this.deps.steps.list(workspaceKey, sessionId);
  }

  /** 只返回数据库里确有这一步的图片。 */
  frame(
    workspaceKey: string,
    sessionId: string,
    stepId: number,
  ): Buffer | null {
    if (!this.deps.steps.get(workspaceKey, sessionId, stepId)) return null;
    return this.deps.frames.read(sessionId, stepId);
  }

  /** 会话删除：行与整个图片目录一起清。 */
  removeSession(sessionId: string): void {
    this.deps.steps.removeSession(sessionId);
    this.deps.frames.removeSession(sessionId);
  }
}
