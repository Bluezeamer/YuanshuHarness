# ADR-0003: 概念模型：agent 定义、环境、workspace、会话

状态：已定稿
日期：2026-10-16
可逆性：难逆
取代：无
被取代：——
引用入口：ARCHITECTURE「系统组成」与「数据流」；VISION「做什么」第 5、6 条

## 背景
需要一组稳定的核心概念，权限、能力分配、会话持久化、subagent 都建立在它们之上。
关键问题是"agent 工作的位置"怎么表达，以及 agent 能否在不同位置之间切换。

## 候选方案
### 方案 A：会话绑定唯一的环境与目录
最简单。代价：想换环境只能另开会话，无法在一次任务里本机与远程来回切换。
### 方案 B：workspace 作为一等公民，会话可挂多个并切换
workspace 是环境里的一个目录，有显式 cwd。代价：多一层概念，要处理切换时的感知与权限。
### 方案 C：环境为一等公民，cwd 作为运行时参数
不登记 workspace。代价：项目级的 skill、MCP、AGENTS.md、权限规则没有地方挂靠。

## 决定
方案 B，概念如下：
- **agent 定义**：提示词（分组拼接）、能力清单、模型（供应商、模型、默认推理强度）。
  纯数据，与环境无关。
- **环境**：一条普通记录，基础环境不特殊。
- **workspace**：环境内的一个目录，必须有显式 cwd，远程也不例外。
  每个 workspace 记录所属环境的稳定 id；`list_workspaces` 向 agent 展示每个 workspace 所属的环境
  （以及是否 local、是否生效），使其能区分同环境与跨环境。环境 id 在登记时分配，
  不推断两条记录是否指向同一台物理机。
- **会话**：一个 agent 定义加若干挂载的 workspace，其中一个生效。
  agent 定义在会话生命周期内固定。
- **local**：会话相对的标签，指会话创建时所选首个 workspace（local-workspace）所在的环境，
  可能就是一个容器。其余环境相对它是"远程"。
- **切换**：agent 经 `list_workspaces` 与 `switch_workspace` 工具切换生效的 workspace，
  切换时在上下文末尾追加环境通知。
- **subagent**：用某个 agent 定义新开的独立会话，记录双向父子关系。
- 只有用户（经 WebUI）可以新增环境与 workspace。"登记环境"保持为原子能力，
  将来可经审批授予 agent，本期不做。
- 多个会话可共享同一 workspace，本期不加锁。

## 理由
- 权限判断需要明确的 cwd，才能区分"在目录内"与"在目录外"。
- 项目级的 skill、MCP、AGENTS.md、规则需要一个挂靠点，就是 workspace。
- 一个任务内本机与远程来回切换是实际需求；缓存前缀的顾虑可由尾部通知化解。
- agent 定义是纯数据，session、subagent、以后的编排都能复用同一份定义。
- 工具以 workspace 而非环境命名：切换的对象是"环境加目录"，同一环境可挂多个 workspace。

## 影响
- 权限档位挂在 workspace 上，随生效 workspace 切换。
- 非全局的 MCP 固定在 local-workspace 运行，不随切换改变。
- 同一 workspace 的多会话并发写同一批文件时，冲突本期由用户自行规避。
- 排除：会话中途切换 agent 定义；agent 自行新增环境（本期）。
