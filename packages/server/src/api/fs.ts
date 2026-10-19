import { constants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const MAX_DIRS = 2000;

const can = (p: string, mode: number) =>
  access(p, mode).then(
    () => true,
    () => false,
  );

export async function fsApi(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { path?: string; hidden?: string } }>(
    "/api/v1/fs/dirs",
    async (req, reply) => {
      const raw = req.query.path ?? os.homedir();
      const invalid = () => reply.code(400).send({ error: "invalid_path" });
      if (typeof raw !== "string" || !path.isAbsolute(raw)) return invalid();
      let dir: string;
      try {
        dir = await realpath(raw);
        if (!(await stat(dir)).isDirectory()) return invalid();
      } catch {
        return invalid();
      }

      const readable = await can(dir, constants.R_OK | constants.X_OK);
      const writable = await can(dir, constants.W_OK | constants.X_OK);
      const showHidden = req.query.hidden === "1";
      const dirs: string[] = [];
      let truncated = false;
      if (readable) {
        let entries: import("node:fs").Dirent[] = [];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          // 探测后权限变化：按不可读目录处理
        }
        const names: string[] = [];
        for (const e of entries) {
          if (!showHidden && e.name.startsWith(".")) continue;
          if (e.isDirectory()) names.push(e.name);
          else if (e.isSymbolicLink()) {
            // 悬空链接与指向文件的链接 stat 后被排除
            const isDir = await stat(path.join(dir, e.name)).then(
              (s) => s.isDirectory(),
              () => false,
            );
            if (isDir) names.push(e.name);
          }
        }
        names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        truncated = names.length > MAX_DIRS;
        dirs.push(...names.slice(0, MAX_DIRS));
      }
      const parent = path.dirname(dir);
      return {
        path: dir,
        parent: parent === dir ? null : parent,
        dirs,
        readable,
        writable,
        truncated,
      };
    },
  );
}
