# ADR-0050: 隐私变量实现：库结构、登记接口与长度策略

状态：实施中  
日期：2026-10-20  
可逆性：难逆  
取代：无  
被取代：——  
引用入口：ROADMAP 第 8 条；[ADR-0007](0007-private-variables.md)（设计权威）

## 背景
ADR-0007 定了隐私变量机制：占位符引用、Server 持有并替换、输出回显遮罩、授权档位。本篇定库结构、登记接口、名字与长度策略。占位符替换见 ADR-0051，权限与范围检查见 ADR-0052，输出遮罩见 ADR-0053，sudo 见 ADR-0054。

## 决定

### 数据结构（迁移 v8）
复用 `secrets` 表与 AES-256-GCM 加密（ADR-0033），`kind` 增加取值 `variable`，新增列：
- `purpose TEXT`：用途说明，≤500 字符
- `scope_kind TEXT`：适用范围，`any` / `domain` / `sudo`，缺省 `any`
- `scope_target TEXT`：`domain` 时为小写域名，其余为空
- `tier TEXT`：授权档位 `rules` / `auto` / `full`，缺省 `rules`

不设 `min_length` 列：长度是登记与遮罩时的计算结果，不是存储属性。

### 变量不与凭据混用
`kind='variable'` 的行只经 `/api/v1/variables` 管理。凭据侧的 `list / get / reveal / remove` 都排除变量：变量不出现在 `/api/v1/secrets`，不能经它删除，也不能被 ssh 环境引用。反向亦然。

### 名字
占位符名 `^[A-Za-z][A-Za-z0-9_]{0,63}$`：字母开头，同时是合法的 shell 变量名片段。名字与凭据共用 `name UNIQUE`，重名返回 409。

### 长度策略
- 登记下限 4 字符，上限 16KB。sudo 密码常较短，不能一刀切要求 16。
- 遮罩下限 8 字符：短于它的值，输出回显不做替换，否则 4 位值会误伤任意文本。
- 不拒绝短值，而是在元数据里返回 `maskable: false`，WebUI 登记时明确提示“此值过短，输出里的回显不会被遮罩”。
- 遮罩是确定性精确匹配；base64 等编码后的回显匹配不到，是已知局限（ADR-0007）。

### 范围表示
`scope_kind` 枚举加 `scope_target` 匹配串，权限引擎直接比较，不解析自由文本：
- `any`：不限
- `domain`：命令里出现该域名（含子域名）才算在范围内
- `sudo`：只用于 sudo 密码，见 ADR-0054

### API
- `GET /api/v1/variables`：列表，只含元数据与 `maskable`
- `POST /api/v1/variables`：`{name, value, purpose?, scopeKind?, scopeTarget?, tier?}`，201 返回元数据
- `PATCH /api/v1/variables/:id`：部分更新，不带 `value` 则保留原值
- `DELETE /api/v1/variables/:id`：204，不存在 404

任何响应都不含 `value`。错误码：`invalid_name` / `invalid_value` / `invalid_purpose` / `invalid_scope` / `invalid_tier` / `name_exists` / `not_found`。

### 提示词中的清单
`before_agent_start` 扩展在可用清单变化时，往下一轮末尾追加一条 `variables-notice` 消息，列出名字、用途、范围、授权档位，不含值，不改前缀。清单不变不重复注入。

## 理由
- 复用 secrets 表与加密，不另建表；用 `kind` 区分，避免第二套密钥管理。
- 变量与凭据用途不同、权限模型不同，接口分开，互相不可见，防止误用 ssh 凭据当变量，或反过来。
- 用 `maskable` 标志代替拒绝短值：sudo 密码本来就短，拒绝会让该功能用不了。

## 影响
- 迁移 v8 对已有 ssh_key / password 行填缺省值，无数据丢失。
- 本机主密钥丢失则变量同样不可恢复，与 ADR-0033 一致。
- 排除：出口网关（固定决策 3）、MCP 密钥注入（后续）。
