import { type FormEvent, useState } from "react";
import type { McpConfigInfo, McpServerInfo, SecretInfo } from "../api";
import { actionBtn, field } from "../settings/shared";
import { EntryList, fromRows, toRows } from "./EntryList";

// 新建（有 name 输入）与编辑（名称只读）共用；onSubmit 返回错误文本或 null。
export function McpForm({
  initial,
  secrets,
  onSubmit,
  onCancel,
}: {
  initial?: McpServerInfo;
  secrets: SecretInfo[];
  onSubmit(name: string, config: McpConfigInfo): Promise<string | null>;
  onCancel?(): void;
}) {
  const c = initial?.config;
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "http">(
    c?.transport ?? "stdio",
  );
  const [command, setCommand] = useState(
    c?.transport === "stdio" ? c.command : "",
  );
  // args 一行一个，避免空格拆分把带空格的参数切碎。
  const [args, setArgs] = useState(
    c?.transport === "stdio" ? c.args.join("\n") : "",
  );
  const [url, setUrl] = useState(c?.transport === "http" ? c.url : "");
  const [env, setEnv] = useState(toRows(c?.transport === "stdio" ? c.env : []));
  const [headers, setHeaders] = useState(
    toRows(c?.transport === "http" ? c.headers : []),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const config: McpConfigInfo =
      transport === "stdio"
        ? {
            transport,
            command: command.trim(),
            args: args.split("\n").filter((l) => l !== ""),
            env: fromRows(env),
          }
        : { transport, url: url.trim(), headers: fromRows(headers) };
    setBusy(true);
    setError(await onSubmit(name.trim(), config));
    setBusy(false);
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-xs font-semibold">
        名称
        <input
          value={name}
          readOnly={initial !== undefined}
          onChange={(e) => setName(e.target.value)}
          placeholder="字母数字、_ 或 -，最长 32 位"
          className={field}
        />
      </label>
      <fieldset className="m-0 flex gap-4 border-0 p-0">
        <legend className="mb-1 p-0 text-xs font-semibold">传输方式</legend>
        {(
          [
            ["stdio", "本机子进程（stdio）"],
            ["http", "远程服务（streamable-http）"],
          ] as const
        ).map(([id, label]) => (
          <label key={id} className="flex items-center gap-2">
            <input
              type="radio"
              name="mcp-transport"
              checked={transport === id}
              onChange={() => setTransport(id)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {transport === "stdio" ? (
        <>
          <label className="flex flex-col gap-1 text-xs font-semibold">
            命令
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="如 npx"
              className={`${field} font-mono`}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">
            参数（一行一个）
            <textarea
              rows={3}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              className={`${field} font-mono`}
            />
          </label>
          <EntryList
            label="环境变量"
            rows={env}
            secrets={secrets}
            onChange={setEnv}
          />
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-xs font-semibold">
            地址
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="MCP 服务地址（含协议与路径）"
              className={`${field} font-mono`}
            />
          </label>
          <EntryList
            label="请求头"
            rows={headers}
            secrets={secrets}
            onChange={setHeaders}
          />
        </>
      )}
      {error && (
        <p role="alert" className="m-0 font-semibold text-acc">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className={actionBtn}>
          {initial ? "保存" : "登记"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={actionBtn}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}
