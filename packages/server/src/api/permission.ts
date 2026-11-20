import type { FastifyInstance } from "fastify";
import { BOUNDARIES, NO_REMEMBER_COMMANDS } from "../permission/boundaries.js";

// 权限硬边界的只读清单（ADR-0070）：来源是判定代码里的同一份常量，不可经 API 修改。
export async function permissionApi(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/permission/boundaries", async () => ({
    boundaries: BOUNDARIES,
    noRemember: NO_REMEMBER_COMMANDS,
  }));
}
