import path from "node:path";
import type { EnvHub } from "../env/hub.js";
import { HttpError } from "../lib/http-error.js";
import {
  cleanName,
  type DirectoryStore,
  resolveDirectory,
} from "../store/directories.js";
import { LOCAL_ENV_ID } from "../store/environments.js";

type DirectoryInputErrorCode =
  | "invalid_environment"
  | "invalid_path"
  | "invalid_name"
  | "env_unreachable"
  | "name_exists";

const STATUS: Record<DirectoryInputErrorCode, number> = {
  invalid_environment: 400,
  invalid_path: 400,
  invalid_name: 400,
  env_unreachable: 502,
  name_exists: 409,
};

export class DirectoryInputError extends HttpError {
  constructor(
    readonly code: DirectoryInputErrorCode,
    message: string = code,
  ) {
    super(code, message, STATUS[code]);
  }
}

export interface ResolvedDirectory {
  environmentId: string;
  path: string;
  name: string;
}

/**
 * 一个目录入参的解析结果：本机走文件系统，远程走环境原语（必须 POSIX 绝对路径、真实存在且是目录）。不写库。
 * 名字在这里定下：用户没给就取路径末段并自动去重（app、app-2…），给了重名就拒绝。
 */
export class DirectoryResolver {
  constructor(
    private readonly deps: { hub: EnvHub; directories: DirectoryStore },
  ) {}

  async resolve(input: {
    environmentId?: unknown;
    path?: unknown;
    name?: unknown;
  }): Promise<ResolvedDirectory> {
    const environmentId =
      input.environmentId === undefined ? LOCAL_ENV_ID : input.environmentId;
    if (typeof environmentId !== "string")
      throw new DirectoryInputError("invalid_environment");
    const remote = environmentId !== LOCAL_ENV_ID;
    let dirPath: string;
    if (!remote) {
      const dir = resolveDirectory(input.path);
      if (!dir.ok) throw new DirectoryInputError("invalid_path", dir.message);
      dirPath = dir.path;
    } else {
      // 远程目录经环境原语解析：必须是 POSIX 绝对路径、真实存在且是目录。
      const env = this.deps.hub.getSsh(environmentId);
      if (!env) throw new DirectoryInputError("invalid_environment");
      let real: string | null;
      try {
        if (
          typeof input.path !== "string" ||
          !path.posix.isAbsolute(input.path)
        )
          real = null;
        else {
          const resolved = await env.realpath(input.path);
          real =
            resolved !== null && (await env.stat(resolved))?.isDirectory
              ? resolved
              : null;
        }
      } catch {
        throw new DirectoryInputError("env_unreachable");
      }
      if (real === null) throw new DirectoryInputError("invalid_path");
      dirPath = real;
    }
    const base = remote ? path.posix : path;
    const given =
      input.name === undefined
        ? cleanName(base.basename(dirPath) || dirPath)
        : cleanName(input.name);
    if (given === null) throw new DirectoryInputError("invalid_name");
    // 用户给的名字重名要报错；默认名（路径末段）自动去重。
    if (input.name !== undefined) {
      if (this.deps.directories.nameTaken(environmentId, given))
        throw new DirectoryInputError("name_exists");
      return { environmentId, path: dirPath, name: given };
    }
    return {
      environmentId,
      path: dirPath,
      name: this.deps.directories.uniqueName(environmentId, given),
    };
  }
}
