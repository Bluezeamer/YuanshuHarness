import type { Tier } from "../permission/tier.js";
import type { Db } from "./db.js";

export type ConfigModel =
  | { mode: "follow-default" }
  | { mode: "explicit"; provider: string; model: string; reasoning: string };

// 会话配置：创建会话时由预设默认值 + 用户覆盖算出，之后可以单独调整。
// 能力与权限只属于「agent 定义 / 模式」这两个概念，所以这里存的是那次选择的最终结果。
export interface SessionConfig {
  sessionId: string;
  model: ConfigModel;
  /** 生效能力 id（tool:名字 / skills:名字 / mcp:名字）；null = 不限制 */
  capabilities: string[] | null;
  /** 审批档位；null = 没覆盖，跟随全局默认 */
  permissionTier: Tier | null;
  rev: number;
}

// 落库的是除 sessionId 与 rev 之外的部分。
export type ConfigBody = Omit<SessionConfig, "sessionId" | "rev">;

type Row = { session_id: string; config: string; rev: number };
const toConfig = (r: Row): SessionConfig => ({
  sessionId: r.session_id,
  ...(JSON.parse(r.config) as ConfigBody),
  rev: r.rev,
});

export class SessionConfigStore {
  constructor(private readonly db: Db) {}

  get(sessionId: string): SessionConfig | null {
    const r = this.db
      .prepare("SELECT * FROM session_configs WHERE session_id = ?")
      .get(sessionId) as Row | undefined;
    return r ? toConfig(r) : null;
  }

  // 乐观并发写：expectedRev 为 0 表示新建（已存在则失败），否则只在 rev 相等时更新并 +1。返回 null = rev 不匹配。
  save(
    sessionId: string,
    body: ConfigBody,
    expectedRev: number,
  ): SessionConfig | null {
    const now = new Date().toISOString();
    const json = JSON.stringify(body);
    const changes =
      expectedRev === 0
        ? this.db
            .prepare(
              `INSERT INTO session_configs (session_id, config, rev, updated_at) VALUES (?, ?, 1, ?)
               ON CONFLICT(session_id) DO NOTHING`,
            )
            .run(sessionId, json, now).changes
        : this.db
            .prepare(
              `UPDATE session_configs SET config = ?, rev = rev + 1, updated_at = ?
               WHERE session_id = ? AND rev = ?`,
            )
            .run(json, now, sessionId, expectedRev).changes;
    return changes > 0 ? this.get(sessionId) : null;
  }

  remove(sessionId: string): void {
    this.db
      .prepare("DELETE FROM session_configs WHERE session_id = ?")
      .run(sessionId);
  }
}
