// 元枢自己的会话设置（压缩与重试）：文件在 `<ysHome>/settings.json`，没写的键跟随 pi 的配置。
// defaults 是「不看我们文件时 pi 自己会用的值」——现建一份 SettingsManager 读，不缓存：
// 用户在 `~/.pi` 里改过之后界面上要能看到。

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import { isObject } from "../lib/validate.js";
import {
  AGENT_SETTINGS_GROUPS,
  AGENT_SETTINGS_RANGE,
  AgentSettingsError,
  type AgentSettingsFile,
  type AgentSettingsPatch,
} from "../session/agent-settings.js";
import { bad, toHttp } from "./lib/reply.js";

/** 现读 pi 的设置：与会话工厂同参数（项目设置不读）。 */
function piDefaults() {
  const manager = SettingsManager.create(process.cwd(), getAgentDir(), {
    projectTrusted: false,
  });
  const compaction = manager.getCompactionSettings();
  const retry = manager.getRetrySettings();
  return {
    compaction: {
      enabled: compaction.enabled,
      reserveTokens: compaction.reserveTokens,
      keepRecentTokens: compaction.keepRecentTokens,
    },
    retry: { enabled: retry.enabled, maxRetries: retry.maxRetries },
  };
}

export function agentSettingsApi(
  app: FastifyInstance,
  opts: { file: AgentSettingsFile },
): void {
  const { file } = opts;
  const view = () => {
    const read = file.read();
    return {
      file: file.file,
      values: read.values,
      problems: read.problems,
      defaults: piDefaults(),
      ranges: AGENT_SETTINGS_RANGE,
    };
  };

  app.get("/api/v1/agent-settings", async () => view());

  // body 就是补丁：键缺省 = 不动，null = 删掉这一项（回到跟随 pi）。
  app.put("/api/v1/agent-settings", async (req, reply) => {
    if (!isObject(req.body)) return bad(reply);
    const body = req.body;
    const unknown = Object.keys(body).filter(
      (k) => !(AGENT_SETTINGS_GROUPS as readonly string[]).includes(k),
    );
    if (unknown.length > 0)
      return bad(reply, "bad_request", `未知的设置项：${unknown.join(", ")}`);
    const patch: AgentSettingsPatch = {};
    // 分组里的未知键与取值范围由 file.update 校验（同一份规则）
    for (const group of AGENT_SETTINGS_GROUPS) {
      const section = body[group];
      if (section === undefined) continue;
      if (!isObject(section))
        return bad(reply, "bad_request", `${group} 必须是对象`);
      patch[group] = section as never;
    }
    try {
      file.update(patch);
    } catch (err) {
      if (err instanceof AgentSettingsError) return toHttp(reply, err);
      throw err;
    }
    return view();
  });
}
