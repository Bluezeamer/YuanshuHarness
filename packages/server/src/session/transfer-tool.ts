// transfer_files：模型在两个位置之间传文件（可跨主机，也可以是同一主机的两个目录）。
// 它是「单次工具调用只碰一台主机」的例外。两端都用同一套位置规则（session/address.ts）：各自一个可选的 host
// （主机或 `host:目录名`），path 永远只是路径。权限在 tool_call 阶段由 permission/extension.ts 按两端各自的归属目录判定。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { TransferError, transfer } from "../env/transfer.js";
import { recordTransfer } from "../env/transfer-jobs.js";
import type { AuditLog } from "../store/audit.js";
import type { Located } from "./address.js";
import { hostProperty } from "./host-param.js";

export const TRANSFER_TOOL = "transfer_files";

export interface TransferToolDeps {
  sessionId: string;
  /** 位置解析：两端各一次（session/address.ts 的 AddressBook.locate）。 */
  locate: (
    host: string | undefined,
    path: string | undefined,
  ) => Promise<Located>;
  audit?: AuditLog | undefined;
}

interface Params {
  from: string;
  from_host?: string;
  to: string;
  to_host?: string;
  overwrite?: boolean;
}

const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
});

const PATH_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 4096,
} as const;

export function transferExtension(deps: TransferToolDeps): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: TRANSFER_TOOL,
      label: "transfer files",
      description:
        'Copy a file or a whole directory tree from one place to another (across hosts, or between two directories on the same host); the data streams through the Server. Each end is a path plus an optional host, written like the file tools\' host parameter: omit it for the current directory, name a host for an absolute path (e.g. from_host="dev1", from="/data/train"), or name a directory (e.g. to_host="local:proj", to="models/") for a relative path. Run list_directories to see the hosts and directories of this session. Does not overwrite by default: if the destination already exists the whole call is rejected and nothing is written; pass overwrite=true to replace. A failed copy is not rolled back. To copy a file the user uploaded into a working directory, use from_host="attachment" and an absolute path such as /2026-11-16/ab12cd34-chart.png. Reading the source and writing the destination are judged separately, so the user may be asked to approve one or both.',
      parameters: {
        type: "object",
        properties: {
          from: {
            ...PATH_SCHEMA,
            description: "Source path (file or directory)",
          },
          from_host: hostProperty(
            'Host, or host:directory, that "from" is on. Omit to use the current directory. A host on its own needs an absolute path.',
          ),
          to: { ...PATH_SCHEMA, description: "Destination path" },
          to_host: hostProperty(
            'Host, or host:directory, that "to" is on. Omit to use the current directory. A host on its own needs an absolute path.',
          ),
          overwrite: {
            type: "boolean",
            description: "Replace an existing destination, default false",
          },
        },
        required: ["from", "to"],
      } as never,
      async execute(_id, params, signal) {
        const p = params as Params;
        const from = await deps.locate(p.from_host, p.from);
        const to = await deps.locate(p.to_host, p.to);
        const t0 = Date.now();
        const audit = (outcome: string, r?: { files: number; bytes: number }) =>
          recordTransfer(deps.audit, {
            from: { env: from.env, path: from.path },
            to: { env: to.env, path: to.path },
            sessionId: deps.sessionId,
            actor: "agent",
            outcome,
            durationMs: Date.now() - t0,
            ...(r ?? {}),
          });
        try {
          const r = await transfer(
            { env: from.env, path: from.path },
            { env: to.env, path: to.path },
            {
              overwrite: p.overwrite === true,
              ...(signal ? { signal } : {}),
            },
          );
          audit("ok", r);
          return text(
            `Transferred ${r.files} file(s), ${r.bytes} bytes, skipped ${r.skippedLinks} symlink(s) (neither followed nor copied): ${from.shown} -> ${to.shown}`,
          );
        } catch (err) {
          audit(
            signal?.aborted
              ? "cancelled"
              : err instanceof TransferError
                ? err.code
                : "copy_failed",
          );
          // TransferError 的 message 原样作为工具错误给模型看
          throw err;
        }
      },
    });
  };
}
