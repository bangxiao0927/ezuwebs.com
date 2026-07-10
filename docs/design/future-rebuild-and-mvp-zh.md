这份文档整理两部分内容：

1. 目录结构 + 核心类型定义
2. 第一版重构 MVP 的开发顺序

这是一份重构方案草图，不是当前仓库实现说明。当前 repo 已经是 TypeScript monorepo，并且已经落地了 `apps/web`、`apps/agent`、`packages/protocol`、`packages/core`、`packages/model-gateway`、`packages/runtime-browser`、`packages/runtime-remote`、`packages/ui` 这些基础结构；本文更侧重下一版如何继续扩展和重构。

目标不是解释当前 repo，而是给“重新实现这个网站核心功能并重构”的方案草图。重点是支持：
- 多模型接入，比如 GPT、Codex
- 更强的交互式设计
- 可扩展的协议和运行时

====================
一、推荐目录结构
====================

如果继续往下一版演进，建议保持 TypeScript monorepo 方向，结构尽量克制，不要继续过早拆得过碎。

建议在现有 monorepo 基础上按下面方向继续整理：

/apps
  /web
    前端应用。负责聊天、计划面板、diff 面板、编辑器、预览、终端、用户确认交互，以及交互式网页块编辑入口。

  /agent
    Agent 编排服务。负责会话状态、模型路由、工具调用、事件流输出、权限控制。

/packages
  /protocol
    共享协议层。定义事件类型、动作 schema、会话 schema、工具输入输出 schema。

  /core
    核心业务层。定义 planner、executor、session state、action queue、diff merge。

  /runtime-browser
    浏览器运行时适配层。封装当前 browser runtime stub 的文件、命令、端口、watch 能力，后续也可以替换成更完整的浏览器执行层。

  /runtime-remote
    远程运行时适配层。后续如需切到远程 sandbox，可以复用相同接口。

  /model-gateway
    模型调用统一入口。屏蔽 GPT、Codex、未来其他模型的调用差异。

  /ui
    可复用 UI 组件。比如 PlanPanel、DiffPanel、ApprovalDialog、ActionTimeline。

/infra
  /prompts
    系统提示、模板提示、模型分工提示、工具描述文档。

  /config
    模型路由策略、权限策略、feature flags。

====================
二、各目录职责
====================

1. apps/web

职责：
- 展示聊天 UI
- 展示计划和执行状态
- 展示文件树、编辑器、终端、预览
- 收集用户确认、用户选择、用户补充输入
- 提供面向页面 block 的轻量编辑接口，方便后续细化网页结构和内容
- 消费后端事件流

这一层不直接依赖某个模型，只依赖统一事件协议。

2. apps/agent

职责：
- 接收用户消息
- 维护会话状态
- 选择模型
- 调用 planner / coder / reviewer 等 agent
- 输出结构化事件流
- 控制工具调用权限

这一层是“控制塔”，不直接负责 UI。

3. packages/protocol

职责：
- 统一定义前后端共享类型
- 定义 action、event、tool、plan、session 的 schema
- 用 zod 做运行时校验

这类共享协议包应该继续保持为优先边界，因为它决定后续扩展成本。

4. packages/core

职责：
- 执行计划生成
- 动作队列管理
- 文件变更合并
- 用户确认点插入
- 错误恢复和重试策略

这里是产品逻辑层，不应该依赖 React，也不应该直接依赖具体浏览器运行时实现。

5. packages/runtime-browser

职责：
- 把浏览器 runtime stub 或未来远程 runtime 都包装成统一 Runtime 接口
- 提供 readFile、writeFile、runCommand、watchFiles、watchPorts 等能力

这一层的目标是：
“让上层不关心下面到底是 browser runtime stub 还是真实 remote runtime”

6. packages/model-gateway

职责：
- 提供统一的 generate / stream / tool-call 接口
- 根据任务类型选择模型
- 屏蔽不同模型调用差异

例如：
- GPT-5.4 做规划和复杂 reasoning
- GPT-5.3-Codex 或 GPT-5-Codex 做代码改动
- GPT-5-mini 做低成本摘要和 UI 文案任务

====================
三、推荐核心模块划分
====================

建议拆成下面这些核心模块：

1. session

负责：
- 当前会话 id
- 用户消息历史
- 当前项目摘要
- 当前执行状态
- 当前待确认事项

2. planner

负责：
- 理解用户目标
- 生成结构化计划
- 判断哪些步骤需要用户确认
- 输出高层 plan，不直接改文件

3. coder

负责：
- 把具体需求转成文件改动
- 生成 patch 或完整文件内容
- 发出 command run 请求

4. reviewer

负责：
- 审查高风险改动
- 检查是否覆盖用户修改
- 检查明显错误

5. executor

负责：
- 串行执行 file / command / preview 等动作
- 维护动作状态
- 支持取消、失败、重试

6. runtime

负责：
- 文件系统操作
- 命令执行
- 输出采集
- 端口监听

7. interaction

负责：
- choice.requested
- confirm.requested
- input.requested
- file.conflict.requested

这是做“交互式设计”最关键的层。

8. page-editor

负责：
- 接收页面 block 级别的编辑请求
- 把 `selection + intent + properties` 转成更精确的 patch 任务
- 让“网页微调”不必每次都退回整文件重写

====================
四、推荐核心类型定义
====================

下面不是最终代码，只是建议你按这个方向定义共享类型。

1. 会话对象

```ts
export interface SessionState {
  id: string;
  projectId: string;
  messages: ConversationMessage[];
  plan: PlanStep[];
  actions: ActionState[];
  pendingInteraction?: PendingInteraction;
  runtime: RuntimeSnapshot;
  createdAt: string;
  updatedAt: string;
}
```

2. 对话消息

```ts
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}
```

3. 计划步骤

```ts
export interface PlanStep {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  requiresApproval?: boolean;
}
```

4. 动作定义

```ts
export type AgentAction =
  | FileWriteAction
  | FilePatchAction
  | CommandRunAction
  | AskChoiceAction
  | AskConfirmAction
  | OpenPreviewAction;

export interface FileWriteAction {
  type: 'file.write';
  path: string;
  content: string;
}

export interface FilePatchAction {
  type: 'file.patch';
  path: string;
  patch: string;
}

export interface CommandRunAction {
  type: 'command.run';
  command: string;
  cwd?: string;
}

export interface AskChoiceAction {
  type: 'interaction.choice';
  question: string;
  options: Array<{ id: string; label: string; description?: string }>;
}

export interface AskConfirmAction {
  type: 'interaction.confirm';
  title: string;
  summary: string;
}

export interface OpenPreviewAction {
  type: 'preview.open';
  port?: number;
}
```

5. 动作状态

```ts
export interface ActionState {
  id: string;
  source: 'planner' | 'coder' | 'reviewer' | 'system';
  action: AgentAction;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  createdAt: string;
  updatedAt: string;
}
```

6. 事件流协议

前端不要依赖模型原始文本，统一消费事件。

```ts
export type AgentEvent =
  | { type: 'message.delta'; messageId: string; text: string }
  | { type: 'message.completed'; messageId: string }
  | { type: 'plan.updated'; plan: PlanStep[] }
  | { type: 'action.created'; action: ActionState }
  | { type: 'action.updated'; action: ActionState }
  | { type: 'command.output'; actionId: string; chunk: string }
  | { type: 'file.changed'; path: string }
  | { type: 'preview.ready'; url: string; port: number }
  | { type: 'interaction.required'; interaction: PendingInteraction };
```

7. 待处理交互

```ts
export type PendingInteraction =
  | {
      type: 'choice';
      id: string;
      question: string;
      options: Array<{ id: string; label: string; description?: string }>;
    }
  | {
      type: 'confirm';
      id: string;
      title: string;
      summary: string;
    }
  | {
      type: 'input';
      id: string;
      label: string;
      placeholder?: string;
    };
```

8. 运行时接口

一定要定义统一 Runtime 接口，避免上层代码绑定某一种具体 runtime 实现。

```ts
export interface RuntimeAdapter {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  patchFile(path: string, patch: string): Promise<void>;
  listFiles(root: string): Promise<string[]>;
  runCommand(command: string, opts?: { cwd?: string }): Promise<RuntimeProcess>;
  watchFiles(cb: (event: { path: string; type: string }) => void): Promise<() => void>;
  watchPorts(cb: (event: { port: number; url: string; status: 'open' | 'close' }) => void): Promise<() => void>;
}

export interface RuntimeProcess {
  id: string;
  kill(): Promise<void>;
  onOutput(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
}
```

10. 交互式网页编辑接口

建议单独定义一个轻量接口，先服务 MVP，后续可扩展到可视化编辑。

```ts
export interface InteractiveWebEditRequest {
  selection: {
    blockId: string;
    path: string;
  };
  intent: string;
  patchStrategy: 'replace' | 'append' | 'refine';
  properties?: Array<{
    key: string;
    label: string;
    value: string;
  }>;
}

export interface InteractiveWebEditResponse {
  suggestedPrompt: string;
  nextState: {
    selectedBlockId?: string;
    lastIntent?: string;
  };
}
```

这个接口的意义不是代替代码编辑器，而是补一个“网页块级别”的中间层：
- 上层用户交互比直接改文件更友好
- 下层 coder 仍然可以继续产出 patch
- 后续如果接设计稿对齐、组件属性面板、局部预览，这个接口可以直接扩展

9. 模型网关接口

```ts
export interface ModelGateway {
  streamPlan(input: PlannerInput): AsyncIterable<AgentEvent>;
  streamCode(input: CoderInput): AsyncIterable<AgentEvent>;
  summarizeProject(input: SummaryInput): Promise<string>;
}
```

====================
五、前端 UI 应该怎么配合这些类型
====================

推荐前端布局：

1. 左侧：会话和历史
2. 中间：聊天区 + 计划区 + 交互确认区
3. 右侧：文件树 / 编辑器 / 终端 / 预览

建议至少有这几个核心组件：

- ChatPanel
- PlanPanel
- InteractionPanel
- ActionTimeline
- DiffPanel
- FileTree
- EditorPanel
- TerminalPanel
- PreviewPanel

交互式设计的关键不在动画，而在“用户能否介入关键节点”。所以至少要有：

- 方案选择弹层
- 高风险改动确认弹层
- 文件冲突提示
- 执行中止按钮
- “仅应用 patch 不执行命令”模式

====================
六、第一版重构 MVP 开发顺序
====================

下面这部分最重要。建议你按顺序做，不要一上来把所有功能一起写。

第一阶段：先把协议和分层定死

目标：
- 确定 packages/protocol
- 确定 RuntimeAdapter 接口
- 确定 AgentEvent 事件协议

要做的事：
- 定义 zod schema
- 定义共享 TypeScript types
- 写一个最小事件流 demo

这一阶段不追求 UI，也不追求模型效果，只追求边界清晰。

交付标准：
- 前后端能基于同一套 schema 通信
- 能手工发送一条 action.created 事件给前端并渲染出来

第二阶段：扩展最小可用 runtime

目标：
- 先把现有 browser runtime stub 补到够用
- 明确 RuntimeAdapter 的稳定边界

要做的事：
- 实现 readFile / writeFile / listFiles
- 实现 runCommand
- 实现 watchFiles / watchPorts

交付标准：
- 前端能看到文件树
- runtime 层能稳定回放简单命令或命令输出
- 能在有端口时显示 preview

第三阶段：把最小会话和事件流从 demo 继续推进

目标：
- 在现有 demo agent 流程上继续扩展
- 让前端能建立更真实的 session
- 让事件流从本地 demo 进一步走向真实请求驱动

要做的事：
- 创建 session state
- 建立 SSE 或 WebSocket 流
- 前端消费 AgentEvent

交付标准：
- 后端能持续发 message.delta
- 前端能实时显示增量消息

第四阶段：先把 stub 模型网关替换成一个真实主模型

目标：
- 不要一开始就多模型
- 先接一个最强主模型跑通完整闭环

推荐：
- 先用 GPT-5.4 或当前主推高质量推理模型做 planner + coder 的合一版本

要做的事：
- 建最小 system prompt
- 让模型返回结构化 action
- 后端把 action 转成 AgentEvent

交付标准：
- 用户说“创建一个 Vite React app”
- 系统真的能写文件、装依赖、启动 preview

第五阶段：补执行器和动作状态

目标：
- 把 action 从“消息中的内容”升级成“可追踪对象”

要做的事：
- executor 串行执行动作
- 给每个 action 分配 id
- 支持 pending/running/completed/failed

交付标准：
- 前端 ActionTimeline 能清晰展示执行过程
- 失败时能看到失败点

第六阶段：补交互式设计能力

目标：
- 让系统会停下来问用户，而不是一直自作主张

要做的事：
- 支持 interaction.choice
- 支持 interaction.confirm
- 支持 interaction.input

建议优先加的场景：
- 技术栈选择
- 高风险命令确认
- 覆盖用户修改确认

交付标准：
- 模型遇到歧义时能请求用户选择
- 用户选择后系统继续执行

第七阶段：把 planner 和 coder 从单模型流程拆成双模型

目标：
- 提高可控性和性能

推荐分工：
- planner：GPT-5.4
- coder：GPT-5.3-Codex 或 GPT-5-Codex
- summary/title：GPT-5-mini

要做的事：
- 做 model-gateway
- 按任务路由到不同模型
- 给每种任务定义输入输出 schema

交付标准：
- 同一会话内，不同阶段能调用不同模型
- 前端和执行器对此无感知

第八阶段：补 diff 和用户修改保护

目标：
- 让 AI 和用户真正共编

要做的事：
- 保存用户修改快照
- 在提交新一轮任务前生成 diff
- 如果 AI 要覆盖用户本地改动，弹出冲突确认

交付标准：
- 用户手改文件后，AI 下一轮能理解这些改动
- AI 不会静默覆盖用户工作

第九阶段：补历史会话和项目恢复

目标：
- 让系统从 demo 变成产品

要做的事：
- 保存会话消息
- 保存 plan 和 action 日志
- 保存项目摘要
- 恢复会话和项目上下文

交付标准：
- 刷新页面后可恢复会话
- 打开旧会话后还能继续工作

第十阶段：补权限和安全控制

目标：
- 防止模型无限制执行

要做的事：
- 命令 allowlist / denylist
- 文件路径限制
- 敏感命令必须 confirm
- 安全日志

交付标准：
- 模型无法默认执行高风险命令
- 用户能明确看到“系统准备做什么”

====================
七、第一版 MVP 应该砍掉什么
====================

为了尽快做出核心闭环，第一版建议先不要做：

- 多人协作
- 复杂权限系统
- 多 workspace
- 复杂插件系统
- 高级动画
- 过度精细的历史版本管理
- 语音实时交互

第一版只要先证明这件事：

“用户描述需求 -> 模型产出结构化动作 -> 系统执行 -> 用户可确认关键步骤 -> 文件和预览真实更新”

这条链打通，MVP 就成立了。

====================
八、最推荐的落地节奏
====================

如果你现在就要开工，我建议顺序是：

1. 先写 protocol
2. 再写 runtime adapter
3. 再写 agent event stream
4. 再接单模型
5. 再做 executor
6. 再做 interaction panel
7. 再拆多模型
8. 最后补历史和安全

一句话总结：

先把“统一协议 + 统一 runtime + 统一事件流”打稳，再谈多模型和复杂交互。否则你很快会陷入提示词、组件状态和执行状态互相缠死的问题。
