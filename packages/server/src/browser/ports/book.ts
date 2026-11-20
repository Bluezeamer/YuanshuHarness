// 「这个工作区在这个环境上见过的端口」：bash 输出里认出来的地址记在这里，浏览器打开对应服务时据此免审批。
// 只记在内存里，重启即忘（和已批准站点一样）。

// 每个工作区留多少条：够覆盖一批开发服务器的重启，又不至于被长跑输出堆满。
const PER_WORKSPACE_MAX = 64;

interface Entry {
  envId: string;
  port: number;
}

const key = (envId: string, port: number) => `${envId}\u0000${port}`;

export class PortBook {
  private readonly byWorkspace = new Map<string, Entry[]>();

  /** 记一笔；同一 (工作区, 环境, 端口) 重复记不增加；每个工作区最多留 64 条，超出丢最早记的。 */
  note(workspaceKey: string, envId: string, port: number): void {
    const list = this.byWorkspace.get(workspaceKey) ?? [];
    const k = key(envId, port);
    if (list.some((e) => key(e.envId, e.port) === k)) return;
    list.push({ envId, port });
    if (list.length > PER_WORKSPACE_MAX) list.shift();
    this.byWorkspace.set(workspaceKey, list);
  }

  has(workspaceKey: string, envId: string, port: number): boolean {
    const list = this.byWorkspace.get(workspaceKey);
    return list
      ? list.some((e) => e.envId === envId && e.port === port)
      : false;
  }

  /** 该工作区所有记录，按记下的先后。 */
  list(workspaceKey: string): Entry[] {
    return [...(this.byWorkspace.get(workspaceKey) ?? [])];
  }

  forget(workspaceKey: string): void {
    this.byWorkspace.delete(workspaceKey);
  }
}
