import { Button, Dot, type DotProps } from "../../../../ui";

type Tone = NonNullable<DotProps["tone"]>;

/** 环境行：技能分发与 MCP 运行位置共用。状态点、环境名、版本、状态文字、一个动作。 */
export function EnvRow({
  host,
  version,
  tone,
  state,
  action,
}: {
  host: string;
  version?: string | null;
  tone: Tone;
  state: string;
  action?: { label: string; disabled?: boolean; onClick: () => void };
}) {
  return (
    <li className="tp-env">
      <Dot tone={tone} />
      <span className="t-entry">{host}</span>
      <span className="t-mono">{version ?? ""}</span>
      <span className="t-aux tp-env-state">{state}</span>
      {action ? (
        <Button
          size="sm"
          variant="outline"
          disabled={action.disabled ?? false}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ) : (
        <span />
      )}
    </li>
  );
}
