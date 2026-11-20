// 虚拟环境：只提供文件原语（复用本机 fs），命令一律不执行。
// 附件区（attachment）与协作区（collab）都是它：目录挂在它下面；权限层会先把命令类工具挡掉，
// exec 抛错是第二道保险。
import { ATTACHMENT_ENV_ID } from "../store/environments.js";
import { LocalFs } from "./local.js";
import type { ExecEnv, ExecOptions } from "./types.js";

export class VirtualEnv extends LocalFs implements ExecEnv {
  readonly id: string;
  readonly kind = "virtual" as const;

  constructor(
    private readonly root: string,
    id: string = ATTACHMENT_ENV_ID,
  ) {
    super();
    this.id = id;
  }

  // 家目录就是这个虚拟主机的根：`~/x` 这类写法只会落在它内部。
  override homedir = async () => this.root;

  async exec(
    _command: string,
    _cwd: string,
    _opts: ExecOptions,
  ): Promise<{ exitCode: number }> {
    throw new Error("虚拟环境不提供命令执行");
  }
}
