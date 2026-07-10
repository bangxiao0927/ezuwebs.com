这份文档补两块内容：

1. 数据库表结构设计
2. 事件流协议设计

这是一份面向下一版架构的数据与协议设计参考，不是当前仓库的数据实现说明。当前 repo 重点仍然是事件协议、session reduction 和 demo runtime/UI 闭环；这里讨论的是在引入真实后端、持久化和远程 runtime 后更完整的数据模型应该怎样设计。

目标是服务一个“多模型 + 交互式 AI 编程工作台”的重构版本。重点不是和当前 repo 完全一致，而是给下一版架构一个可落地的数据和协议基础。

====================
一、先定设计原则
====================

数据库和事件协议要围绕下面几个目标设计：

1. 会话可恢复
用户刷新页面、切换设备、回到旧会话时，能恢复上下文。

2. 执行可追踪
每一次 AI 规划、每一个文件修改、每一条命令执行，都要有记录。

3. 用户交互可回放
用户做过哪些选择、确认过哪些高风险操作，要能追溯。

4. 运行时和 UI 解耦
前端不要依赖模型原始文本，而是依赖统一事件流。

5. 支持后续扩展
以后你可能会加：
- 多模型路由
- 多设备同步
- 远程 runtime
- 项目版本快照
- 协作模式

所以一开始表结构和协议要留边界。

====================
二、数据库总体拆分
====================

建议把数据分成 6 类：

1. 用户和项目
2. 会话和消息
3. 计划和动作
4. 交互和审批
5. 运行时和预览
6. 文件快照和 diff

如果你前期想简单一些，也可以先用 PostgreSQL 一套表全放下，等后面量大再拆。

推荐基础存储：
- PostgreSQL：主业务数据
- Object Storage / R2：大文件快照、日志归档、导出
- Redis 或内存层：临时事件扇出、流状态缓存

如果你在 Cloudflare 上做：
- D1 可以做早期版本
- Durable Objects 适合会话内实时状态
- R2 存快照

但如果你想走更标准的产品路线，Postgres 仍然是最稳的主数据库。

====================
三、推荐表结构
====================

下面用逻辑模型来写，不绑定具体 ORM。

--------------------------------
1. users
--------------------------------

用途：
- 用户身份
- 配额
- 偏好设置

建议字段：

- id
- email
- name
- avatar_url
- plan
- created_at
- updated_at

--------------------------------
2. projects
--------------------------------

用途：
- 一个用户可能有多个项目
- 一个项目可以有多个 session

建议字段：

- id
- user_id
- name
- description
- runtime_type
  可选值：browser / remote
- default_model_profile
- latest_session_id
- created_at
- updated_at

说明：
- `runtime_type` 决定这个项目默认跑在 browser runtime 还是远程 runtime。
- `default_model_profile` 对应一套模型路由策略。

--------------------------------
3. sessions
--------------------------------

用途：
- 一个项目下的一次连续会话
- 承载聊天、计划、动作和交互状态

建议字段：

- id
- project_id
- title
- summary
- status
  可选值：active / completed / paused / errored
- active_plan_version
- active_runtime_snapshot_id
- started_at
- last_activity_at
- created_at
- updated_at

说明：
- 不要把全部实时状态都塞数据库字段里。
- 结构化大状态建议拆表，或存在 session_state 表。

--------------------------------
4. session_messages
--------------------------------

用途：
- 保存聊天消息和系统消息

建议字段：

- id
- session_id
- role
  可选值：user / assistant / system / tool
- content
- content_format
  可选值：plain / markdown / json
- model_name
- parent_message_id
- created_at

说明：
- assistant 的“流式增量”不一定要逐片落库，建议最终合并后存完整消息。
- 如需调试，可额外存 raw_response。

--------------------------------
5. session_message_parts
--------------------------------

用途：
- 如果你要保留流式轨迹，就单独存增量 chunk

建议字段：

- id
- message_id
- part_type
  可选值：delta / reasoning / tool_call / tool_result
- content
- sequence
- created_at

说明：
- 这张表不是 MVP 必需，但对调试多模型和事件重放很有价值。

--------------------------------
6. plans
--------------------------------

用途：
- 保存结构化计划
- 支持 plan 迭代和版本化

建议字段：

- id
- session_id
- version
- source_message_id
- status
  可选值：draft / active / superseded / completed
- created_by
  可选值：planner / system / user
- created_at

--------------------------------
7. plan_steps
--------------------------------

用途：
- 保存计划的具体步骤

建议字段：

- id
- plan_id
- step_key
- title
- description
- status
  可选值：pending / in_progress / completed / blocked
- requires_approval
- sort_order
- created_at
- updated_at

--------------------------------
8. actions
--------------------------------

用途：
- 保存执行动作，是系统里最关键的表之一

建议字段：

- id
- session_id
- plan_step_id
- source
  可选值：planner / coder / reviewer / system
- type
  可选值：
  file.write / file.patch / command.run / interaction.choice /
  interaction.confirm / interaction.input / preview.open
- payload_json
- status
  可选值：pending / running / completed / failed / cancelled
- error_message
- sequence
- started_at
- completed_at
- created_at
- updated_at

说明：
- `payload_json` 里存结构化参数，不同 action 共用一张表更灵活。
- `sequence` 很重要，方便按实际执行顺序恢复。

--------------------------------
9. action_logs
--------------------------------

用途：
- 保存动作执行中的中间日志

建议字段：

- id
- action_id
- log_type
  可选值：stdout / stderr / system / diff / preview
- content
- sequence
- created_at

说明：
- 命令输出、patch 摘要、失败堆栈都可以存这里。

--------------------------------
10. interactions
--------------------------------

用途：
- 保存用户需要介入的交互点

建议字段：

- id
- session_id
- action_id
- type
  可选值：choice / confirm / input / conflict
- title
- question
- payload_json
- status
  可选值：pending / resolved / cancelled / expired
- created_at
- resolved_at

--------------------------------
11. interaction_responses
--------------------------------

用途：
- 保存用户对交互点的回答

建议字段：

- id
- interaction_id
- user_id
- response_json
- created_at

说明：
- choice 的选项 id
- confirm 的 true/false
- input 的文本内容
- conflict 的处理策略
都可以放在 `response_json`

--------------------------------
12. runtime_snapshots
--------------------------------

用途：
- 保存运行时状态摘要

建议字段：

- id
- session_id
- runtime_type
- cwd
- active_preview_url
- active_port
- file_count
- process_summary_json
- created_at

说明：
- 不建议把完整文件树直接放这张表
- 这里只存快速恢复 UI 所需的摘要

--------------------------------
13. file_snapshots
--------------------------------

用途：
- 保存关键文件快照
- 支持恢复和对比

建议字段：

- id
- session_id
- path
- content
- content_hash
- source
  可选值：user / agent / system
- snapshot_type
  可选值：baseline / before_action / after_action / manual_save
- created_at

说明：
- 早期可以只存关键文件，不一定把每次所有文件都全量存下来。

--------------------------------
14. file_diffs
--------------------------------

用途：
- 保存差异，降低存储压力，也方便审计

建议字段：

- id
- session_id
- action_id
- path
- diff_text
- created_at

--------------------------------
15. model_runs
--------------------------------

用途：
- 审计每次模型调用
- 分析成本、延迟、效果

建议字段：

- id
- session_id
- message_id
- purpose
  可选值：planning / coding / review / summary / title
- provider
- model
- input_tokens
- output_tokens
- latency_ms
- success
- error_message
- created_at

说明：
- 这张表对后续优化模型路由非常重要。

====================
四、MVP 最少需要哪些表
====================

如果你不想一开始建太多表，MVP 至少保留这些：

- users
- projects
- sessions
- session_messages
- plans
- plan_steps
- actions
- interactions
- interaction_responses
- model_runs

如果再少，会很快失去可观察性。

====================
五、数据库关系主线
====================

主关系链：

user
-> projects
-> sessions
-> session_messages
-> plans
-> plan_steps
-> actions
-> interactions
-> interaction_responses

辅助关系链：

session
-> runtime_snapshots
-> file_snapshots / file_diffs

审计关系链：

session / message
-> model_runs
action
-> action_logs

====================
六、事件流协议应该怎么设计
====================

核心原则：

1. 前端只消费统一事件，不消费模型原始格式
2. 事件要能重放
3. 事件要有顺序
4. 事件要能定位到 session / action / interaction
5. 事件要允许多种前端视图同时消费

推荐协议层字段：

每个事件都带公共头：

```ts
interface BaseEvent {
  id: string;
  sessionId: string;
  type: string;
  seq: number;
  timestamp: string;
}
```

说明：
- `id` 是事件唯一 id
- `sessionId` 用于前端路由和会话隔离
- `seq` 用于严格排序和断线恢复
- `timestamp` 用于展示和审计

====================
七、推荐事件分类
====================

建议分成 7 大类事件：

1. 消息事件
2. 计划事件
3. 动作事件
4. 运行时事件
5. 交互事件
6. 会话事件
7. 错误事件

--------------------------------
1. 消息事件
--------------------------------

```ts
type MessageDeltaEvent = BaseEvent & {
  type: 'message.delta';
  messageId: string;
  role: 'assistant';
  text: string;
};

type MessageCompletedEvent = BaseEvent & {
  type: 'message.completed';
  messageId: string;
};
```

用途：
- 聊天区实时展示 assistant 输出

--------------------------------
2. 计划事件
--------------------------------

```ts
type PlanUpdatedEvent = BaseEvent & {
  type: 'plan.updated';
  planId: string;
  version: number;
  steps: Array<{
    id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'completed' | 'blocked';
    requiresApproval?: boolean;
  }>;
};
```

用途：
- PlanPanel 实时更新

--------------------------------
3. 动作事件
--------------------------------

```ts
type ActionCreatedEvent = BaseEvent & {
  type: 'action.created';
  action: {
    id: string;
    type: string;
    status: 'pending';
    payload: Record<string, unknown>;
  };
};

type ActionUpdatedEvent = BaseEvent & {
  type: 'action.updated';
  action: {
    id: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    error?: string;
  };
};
```

用途：
- ActionTimeline
- DiffPanel
- 命令执行状态展示

--------------------------------
4. 运行时事件
--------------------------------

```ts
type CommandOutputEvent = BaseEvent & {
  type: 'command.output';
  actionId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
};

type FileChangedEvent = BaseEvent & {
  type: 'file.changed';
  path: string;
};

type PreviewReadyEvent = BaseEvent & {
  type: 'preview.ready';
  port: number;
  url: string;
};
```

用途：
- 终端面板
- 文件树刷新
- 预览 iframe 更新

--------------------------------
5. 交互事件
--------------------------------

```ts
type InteractionRequiredEvent = BaseEvent & {
  type: 'interaction.required';
  interaction: {
    id: string;
    interactionType: 'choice' | 'confirm' | 'input' | 'conflict';
    title?: string;
    question: string;
    options?: Array<{ id: string; label: string; description?: string }>;
  };
};

type InteractionResolvedEvent = BaseEvent & {
  type: 'interaction.resolved';
  interactionId: string;
};
```

用途：
- 弹层
- 侧栏确认卡片
- 阻塞式审批流程

--------------------------------
6. 会话事件
--------------------------------

```ts
type SessionUpdatedEvent = BaseEvent & {
  type: 'session.updated';
  session: {
    id: string;
    title?: string;
    status: 'active' | 'completed' | 'paused' | 'errored';
  };
};
```

用途：
- 顶部状态条
- 历史列表即时刷新

--------------------------------
7. 错误事件
--------------------------------

```ts
type ErrorEvent = BaseEvent & {
  type: 'error';
  code: string;
  message: string;
  recoverable: boolean;
};
```

用途：
- 统一错误提示
- 前端决定是 toast、弹层还是重试按钮

====================
八、前端如何消费事件
====================

建议前端有一个统一事件总线层，例如：

- `sessionEventStore`
- `eventReducer`
- `applyEventToSessionState(event)`

不要让各个组件各自解析 SSE/WebSocket 原始流。

正确做法是：

SSE / WebSocket
-> Event Parser
-> Event Store
-> 各 UI 面板订阅派生状态

例如：
- ChatPanel 只关心 `messages`
- PlanPanel 只关心 `plan.steps`
- ActionTimeline 只关心 `actions`
- PreviewPanel 只关心 `runtime.preview`
- InteractionPanel 只关心 `pendingInteraction`

====================
九、事件传输层建议
====================

优先级建议：

1. MVP 用 SSE

优点：
- 简单
- 易调试
- 对单向事件流很够用

缺点：
- 双向交互需要额外 HTTP 提交

2. 后续升级 WebSocket

适合：
- 更实时的协作
- 多端同步
- 复杂会话控制

建议策略：
- 后端输出事件用 SSE
- 用户提交选择/确认用普通 POST

这套组合足够支撑第一版产品。

====================
十、断线恢复怎么做
====================

必须考虑这一点，否则事件流一断就很麻烦。

建议：

1. 每个事件带 `seq`
2. 前端记住最后一个 `seq`
3. 重连时带上 `lastSeq`
4. 后端可以从数据库或内存缓存补发缺失事件

如果暂时不做补发，至少重连后给一次完整状态快照。

推荐补一个事件：

```ts
type SessionSnapshotEvent = BaseEvent & {
  type: 'session.snapshot';
  snapshot: {
    messages: unknown[];
    plan: unknown[];
    actions: unknown[];
    pendingInteraction?: unknown;
    preview?: { url: string; port: number };
  };
};
```

这样前端可以快速重建状态。

====================
十一、最推荐的数据库和协议组合
====================

如果你现在就要开工，我推荐：

- PostgreSQL 存持久化业务数据
- SSE 做第一版事件流
- `actions` + `interactions` 做核心可追踪对象
- `plans` 做高层展示
- `model_runs` 做成本和效果审计
- 所有事件统一带 `sessionId + seq`

一句话总结：

数据库负责“可恢复、可审计、可追踪”，事件协议负责“可实时驱动 UI、可重放、可解耦模型输出”。两者不要混在一起设计。
