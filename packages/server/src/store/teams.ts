import type { Db } from "./db.js";

export interface TeamRow {
  leadId: string;
  /** 公告板上最后一条的编号 */
  boardSeq: number;
  /** 建队时 lead 所在的目录：team_diff 的基线按它的环境与根目录取 */
  directoryId: string;
  createdAt: string;
}

export interface MemberRow {
  /** 成员的会话 id（也是 subagents 表里的 child_id） */
  childId: string;
  leadId: string;
  name: string;
  agentName: string;
  createdAt: string;
}

type TeamRaw = {
  lead_id: string;
  board_seq: number;
  directory_id: string;
  created_at: string;
};
type MemberRaw = {
  child_id: string;
  lead_id: string;
  name: string;
  agent_name: string;
  created_at: string;
};

const toTeam = (r: TeamRaw): TeamRow => ({
  leadId: r.lead_id,
  boardSeq: r.board_seq,
  directoryId: r.directory_id,
  createdAt: r.created_at,
});
const toMember = (r: MemberRaw): MemberRow => ({
  childId: r.child_id,
  leadId: r.lead_id,
  name: r.name,
  agentName: r.agent_name,
  createdAt: r.created_at,
});

/** 团队整体改动的追踪键（changes/tracker.ts）：建队时拍基线，team_diff 对比当前 */
export const teamChangeKey = (leadId: string): string => `team:${leadId}`;

export class TeamStore {
  constructor(private readonly db: Db) {}

  /** 会话所在的团队（lead 的会话 id）：自己是 lead 或成员；不在团队里是 undefined */
  leadOf(id: string): string | undefined {
    return this.get(id) ? id : this.member(id)?.leadId;
  }

  create(leadId: string, directoryId: string): void {
    this.db
      .prepare(
        "INSERT INTO teams (lead_id, directory_id, created_at) VALUES (?, ?, ?)",
      )
      .run(leadId, directoryId, new Date().toISOString());
  }

  get(leadId: string): TeamRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM teams WHERE lead_id = ?")
      .get(leadId) as TeamRaw | undefined;
    return r && toTeam(r);
  }

  /** 下一条公告的编号 */
  nextSeq(leadId: string): number {
    this.db
      .prepare("UPDATE teams SET board_seq = board_seq + 1 WHERE lead_id = ?")
      .run(leadId);
    return this.get(leadId)?.boardSeq ?? 1;
  }

  addMember(m: Omit<MemberRow, "createdAt">): void {
    this.db
      .prepare(
        "INSERT INTO team_members (child_id, lead_id, name, agent_name, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(m.childId, m.leadId, m.name, m.agentName, new Date().toISOString());
  }

  members(leadId: string): MemberRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM team_members WHERE lead_id = ? ORDER BY created_at, child_id",
        )
        .all(leadId) as MemberRaw[]
    ).map(toMember);
  }

  member(childId: string): MemberRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM team_members WHERE child_id = ?")
      .get(childId) as MemberRaw | undefined;
    return r && toMember(r);
  }

  memberByName(leadId: string, name: string): MemberRow | undefined {
    const r = this.db
      // 名字不分大小写（重名校验也不分），模型写错大小写时仍找得到
      .prepare(
        "SELECT * FROM team_members WHERE lead_id = ? AND name = ? COLLATE NOCASE",
      )
      .get(leadId, name) as MemberRaw | undefined;
    return r && toMember(r);
  }

  removeMember(childId: string): void {
    this.db.prepare("DELETE FROM team_members WHERE child_id = ?").run(childId);
  }

  /** 解散，或 lead 会话被删除：花名册一并清掉 */
  removeTeam(leadId: string): void {
    this.db.prepare("DELETE FROM team_members WHERE lead_id = ?").run(leadId);
    this.db.prepare("DELETE FROM teams WHERE lead_id = ?").run(leadId);
  }
}
