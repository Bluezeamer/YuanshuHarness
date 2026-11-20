import type { PluginView } from "../../../../api/pluginLibrary";
import {
  Button,
  Chip,
  InlineNotice,
  Menu,
  type MenuItem,
  SettingRow,
} from "../../../../ui";
import { PlugIcon } from "../../../../ui/icons";
import { DetailHead } from "../../frame/DetailHead";
import { FormColumn } from "../../frame/layout";
import { toggleEnabled } from "./actions";
import { KIND_TEXT, kindOf, nameOf, statusOf } from "./model";
import type { PluginReady, PluginStore } from "./store";

export interface PluginDetailProps {
  plugin: PluginView;
  store: PluginStore;
  state: PluginReady;
  onRemove: () => void;
}

/**
 * pi 扩展详情。启用 / 停用与卸载都是立即动作：只对新会话或重载后的会话生效，
 * 没有「改了一半等保存」的状态，所以这页没有草稿与保存条（ys-ui-design 的 X06：动作立即执行并弹提示）。
 */
export function PluginDetail({
  plugin: p,
  store,
  state,
  onRemove,
}: PluginDetailProps) {
  const busy = state.busy[p.source] ?? null;
  const st = statusOf(p, busy);
  const kind = kindOf(p.source);

  const menu: MenuItem[] = [
    {
      id: "remove",
      label: "卸载",
      tone: "danger",
      onSelect: onRemove,
    },
  ];

  return (
    <FormColumn>
      <article aria-label={`${nameOf(p.source)} 详情`}>
        <DetailHead
          icon={<PlugIcon size={18} />}
          title={nameOf(p.source)}
          sub={<span className="t-mono">{p.source}</span>}
          status={{ text: st.text, tone: st.tone ?? "idle" }}
          actions={
            <>
              {p.installed && (
                <Button
                  variant={p.enabled ? "outline" : "primary"}
                  loading={st.key === "busy"}
                  onClick={() => void toggleEnabled(store, p)}
                >
                  {p.enabled ? "停用" : "启用"}
                </Button>
              )}
              <Menu label="更多操作" items={menu} />
            </>
          }
        />

        {!p.installed && (
          <InlineNotice tone="danger" className="pl-err">
            登记里有这个包，但包体没有装上（可能被手动删了，或上次安装中途失败）。卸载后重新安装即可。
          </InlineNotice>
        )}

        <section className="st-block" aria-label="内容">
          <header className="st-block-h t-group">内容</header>
          <SettingRow
            label="带来什么"
            description={
              p.installed && !p.enabled
                ? "已停用：它的扩展、技能和提示词模板都不进会话"
                : "整包一起加载：扩展注册的工具默认启用，技能与提示词模板也进会话"
            }
          >
            <span className="pl-counts">
              <Chip>{p.extensionCount} 个扩展</Chip>
              <Chip>{p.skillCount} 个技能</Chip>
            </span>
          </SettingRow>
          <InlineNotice tone="info">
            只对新建的会话，或在会话里重载（/reload）之后生效；正在跑的会话不变。
          </InlineNotice>
        </section>

        <section className="st-block" aria-label="来源">
          <header className="st-block-h t-group">来源</header>
          <SettingRow
            label={KIND_TEXT[kind]}
            description={
              p.version ? `包里写的版本 ${p.version}` : "包里没有写版本"
            }
          >
            <span className="t-mono pl-source">{p.source}</span>
          </SettingRow>
        </section>

        <section className="st-block" aria-label="权限">
          <header className="st-block-h t-group">权限</header>
          <InlineNotice tone="warn">
            扩展是可执行的代码，拥有 Server
            进程的全部权限。元枢的审批只管它注册的工具被调用的时候，管不到扩展代码自己做的事。只装你信任的包。
          </InlineNotice>
        </section>
      </article>
    </FormColumn>
  );
}
