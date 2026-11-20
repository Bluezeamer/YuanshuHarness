// 协作区（subagent.md §8）：每个根会话一个目录，内部按子代理 id 分子目录，在数据目录下，不在项目里。
// 同一棵树的会话都可读，子代理只写自己的子目录。模型看不到真实路径：它是虚拟主机 collab
// （与附件区同一类），一棵树里的所有会话都按 host="collab" 加 `/` 开头的路径寻址。
import {
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { VirtualEnv } from "../env/virtual.js";
import { isInside } from "../permission/paths.js";
import { COLLAB_ENV_ID } from "../store/environments.js";

export interface Report {
  path: string;
  bytes: number;
}

/** 团队公告板：团队根目录下的一个文件，写入只能经 post（team.md §3） */
export const BOARD_FILE = "board.md";

export class CollabArea {
  private real: string | null = null;

  /** canEditBoard：团队成员全部停止时，lead 才可以直接改公告板里已有的内容 */
  constructor(
    private readonly dir: string,
    private readonly canEditBoard: (rootId: string) => boolean = () => false,
  ) {
    this.env = new VirtualEnv(dir, COLLAB_ENV_ID);
  }

  /** 这棵目录树的虚拟环境：文件工具、地址解析与权限判定都经它。 */
  readonly env: VirtualEnv;

  // 权限层拿到的是解析过符号链接的真实路径，所以这里也用真实路径比较。目录还不存在时不创建，
  // 也不缓存（等它建好再取）：先解析父目录，再接上目录名。
  private base(): string {
    if (this.real !== null) return this.real;
    try {
      this.real = realpathSync(this.dir);
      return this.real;
    } catch {
      return path.join(
        realpathSync(path.dirname(this.dir)),
        path.basename(this.dir),
      );
    }
  }

  /** 这棵树的协作区根目录 */
  treeDir(rootId: string): string {
    return path.join(this.base(), rootId);
  }

  /** 某个子代理自己的子目录 */
  ownDir(rootId: string, childId: string): string {
    return path.join(this.treeDir(rootId), childId);
  }

  boardPath(rootId: string): string {
    return path.join(this.treeDir(rootId), BOARD_FILE);
  }

  /** 真实绝对路径 → 虚拟主机 collab 里的路径（`/` 加相对树根的路径）。 */
  virtualPath(rootId: string, abs: string): string {
    return `/${path.relative(this.treeDir(rootId), abs)}`;
  }

  /** 子代理启动时先把自己的子目录建出来：目录树里有它，list_directories 与 ls 才看得到。 */
  ensureOwn(rootId: string, childId: string): void {
    mkdirSync(this.ownDir(rootId, childId), { recursive: true });
  }

  /**
   * 内置放行：同一棵树的会话都能读；子代理（selfId 非空）只能写自己的子目录，根会话不写
   * （团队成员全部停止时例外：lead 可以改公告板）。p 须是解析过符号链接的绝对路径。
   */
  allows(
    rootId: string,
    selfId: string | null,
    access: "read" | "write",
    p: string,
  ): boolean {
    if (access === "read") return isInside(this.treeDir(rootId), p);
    if (selfId === null)
      return p === this.boardPath(rootId) && this.canEditBoard(rootId);
    return isInside(this.ownDir(rootId, selfId), p);
  }

  /** 在某个成员（子代理、团队成员、工作流运行）自己的子目录里写一个文件，返回路径与字节数。 */
  writeOwn(
    rootId: string,
    ownerId: string,
    name: string,
    text: string,
  ): Report {
    mkdirSync(this.ownDir(rootId, ownerId), { recursive: true });
    const file = path.join(this.ownDir(rootId, ownerId), name);
    writeFileSync(file, text);
    return { path: file, bytes: statSync(file).size };
  }

  /** 写下某个子代理的报告，返回文件路径与字节数。 */
  writeReport(rootId: string, childId: string, text: string): Report {
    return this.writeOwn(rootId, childId, "report.md", text);
  }

  /** 随根会话删除 */
  remove(rootId: string): void {
    rmSync(this.treeDir(rootId), { recursive: true, force: true });
  }
}
