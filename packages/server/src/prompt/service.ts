import type { ExecEnv } from "../env/types.js";
import { type Mode, modePrompt } from "../permission/mode.js";
import type { BlockStore } from "../store/blocks.js";
import { type Assembled, assemble, type BlockRef } from "./assemble.js";
import {
  type GlobalConventions,
  readProjectConventions,
} from "./conventions.js";

export interface PromptWhere {
  env: ExecEnv;
  cwd: string;
  // workspace 的 injectConventions 选项。
  injectProject: boolean;
}

// 把存储里的块、全局约定、项目约定喂给纯函数 assemble。
export class PromptService {
  constructor(
    private readonly blocks: BlockStore,
    private readonly conventions: GlobalConventions,
  ) {}

  // 引用到已删除的块直接跳过：块被删后 agent 仍可用。
  async assemble(
    blockIds: string[],
    where: PromptWhere | null,
    mode: Mode = "build",
  ): Promise<Assembled> {
    const refs: BlockRef[] = [];
    for (const id of blockIds) {
      const b = this.blocks.get(id);
      if (b) refs.push(b);
    }
    const project =
      where?.injectProject === true
        ? await readProjectConventions(where.env, where.cwd)
        : null;
    return assemble({
      blocks: refs,
      globalConventions: this.conventions.read(),
      projectConventions: project,
      modePrompt: modePrompt(mode),
    });
  }
}
