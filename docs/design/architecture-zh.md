这个文件解释当前 repo 的目标、分层方式、实现重点以及各包详细职责。它描述的是"现在仓库里已经落地的东西"。

====================
一、这个 repo 现在到底要解决什么问题
====================

这个 repo 当前要验证的，不是"如何把一个完整 AI 编程产品上线"，而是更基础但也更关键的问题：

1. agent、runtime、UI 之间应该用什么统一协议通信
2. 一串异步事件如何稳定归并成可渲染的 session state
3. 一个网页编辑型 agent demo，怎样以最小实现跑通 plan、action、interaction、file、preview 的闭环
4. Web 工作台应该如何围绕这些状态来组织，而不是直接绑死到某个模型或某个运行时实现

所以这个 repo 的价值，不在于"功能已经很多"，而在于它先把结构钉住了。

====================
二、当前产品形态
====================

从 README 和代码来看，当前产品形态更接近下面这句话：

"一个面向 AI 辅助网页编辑工作流的 IDE 风格 demo 工作台"

它现在已经覆盖的链路是：

用户意图
-> demo agent 生成 message / plan / action / interaction 事件
-> core reducer 归并成 session state
-> web 端渲染 chat / plan / timeline / files / preview
-> browser runtime stub 回放文件与预览结果

它还没有覆盖这些能力：

- 真实多用户后端
- 真实数据库持久化
- 真实远程运行时
- 真实模型调用链
- 完整工具生态和权限系统

====================
三、为什么采用 monorepo
====================

当前仓库采用 monorepo，不是为了"拆很多包"，而是为了把未来最容易耦合的边界提前拆开。

这几个边界是当前代码里最重要的：

1. 协议边界

`packages/protocol` 统一约束事件、动作、交互和 session 类型。

2. 归并与执行边界

`packages/core` 统一处理 session state、event reduction、executor 基础能力和 runtime adapter 接口。

3. 模型边界

`packages/model-gateway` 把"任务类型 -> 模型 profile"这层独立出来。

4. 运行时边界

`packages/runtime-browser` 和 `packages/runtime-remote` 表达了"同一套上层逻辑，底层 runtime 可以替换"的方向。

5. UI 组织边界

`packages/ui` 和 `apps/web` 负责 workbench 面板组织及其 view model，不直接承载协议定义。

这种拆法的重点不是包多，而是让后续替换模型、替换 runtime、替换 UI 时，不需要把整套逻辑推翻。

====================
四、当前实现的核心层次
====================

可以把当前 repo 理解成五层。

1. 协议层

对应 `packages/protocol`。

这一层定义了系统最底层的共享语言：

- `PlanStep`
- `AgentAction`
- `ActionState`
- `PendingInteraction`
- `RuntimeSnapshot`
- `SessionState`
- `AgentEvent`

这是整个 repo 最关键的基础，因为没有统一协议，agent、runtime、web 三层就无法解耦。

2. 状态归并层

对应 `packages/core`。

这一层解决的问题是：

- session 初始状态怎么创建
- event stream 如何变成稳定的 session state
- message、plan、action、interaction、runtime 状态如何收口
- runtime adapter 应该暴露什么接口

当前 `applyAgentEvent()` 是这层的核心。它让 event-driven demo 真正成立，因为所有上层展示都依赖它归并出来的状态。

3. 模型路由层（stub）

对应 `packages/model-gateway`。

虽然当前实现还是 stub，但它已经先表达出正确方向：

- planning
- coding
- review
- summary
- title

也就是说，仓库并没有把"模型"当成一个全局单值，而是当成按任务分工的 profile。

这一点对后续接入真实模型很重要。

4. 运行时层（stub）

对应 `packages/runtime-browser` 和 `packages/runtime-remote`。

当前真正跑通的是 `runtime-browser` stub。它已经提供统一的 runtime 形状，例如：

- `readFile`
- `writeFile`
- `patchFile`
- `listFiles`
- `runCommand`
- `watchFiles`
- `openPreview`

`runtime-remote` 目前只是结构占位，但 `RuntimeAdapter` 接口已经把未来扩展位留好了。

5. UI 层

对应 `packages/ui` 和 `apps/web`。

`packages/ui` 负责共享面板定义和标签，`apps/web` 负责消费 session state 并渲染工作台。

====================
五、各包详细职责与入口
====================

仓库分成 `apps/` 和 `packages/` 两层。

-------------------------------
1. `apps/web`
-------------------------------

这是前端 demo。它不负责真正调用模型，而是负责把事件归并后的状态组织成"工作台视图模型"。

关键职责：

- 接收 `initialEvents`
- 通过 `reduceWorkbenchEvents()` 归并出 plan / actions / runtime / interaction
- 生成 `WorkbenchViewModel`
- 提供交互式网页 block 编辑状态
- 组织 chat、plan、timeline、files、preview、diff 这些面板

核心入口：

- `apps/web/src/index.ts`
- `apps/web/src/demo.ts`
- `apps/web/src/workspace.ts`
- `apps/web/src/replacement.ts`

-------------------------------
2. `apps/agent`
-------------------------------

这是 demo agent 流程，不是生产 agent 服务。

它做的事情主要是：

- 初始化 session
- 生成说明性 message 和 plan 事件
- 调用 stubbed `model-gateway`
- 构造 `file.patch` 动作
- 触发审批交互
- 通过 runtime stub 回放 `file.changed` 和 `preview.ready`

核心入口：

- `apps/agent/src/index.ts`

-------------------------------
3. `packages/protocol`
-------------------------------

这是共享协议层，定义了整个 demo 的"公共语言"。

已定义的核心类型：

- `ConversationMessage`
- `PlanStep`
- `AgentAction`
- `ActionState`
- `PendingInteraction`
- `RuntimeSnapshot`
- `SessionState`
- `AgentEvent`

动作类型：

- `file.write`
- `file.patch`
- `command.run`
- `interaction.choice`
- `interaction.confirm`
- `preview.open`

事件类型：

- `message.delta`
- `message.completed`
- `plan.updated`
- `action.created`
- `action.updated`
- `file.changed`
- `preview.ready`
- `interaction.required`
- `interaction.resolved`

-------------------------------
4. `packages/core`
-------------------------------

这是状态归并和执行基础层，是当前 repo 的中枢，因为 web 和 agent 都围绕它定义的 session 演进。

核心职责：

- 创建 session store
- 创建空 runtime snapshot
- 初始化 session state
- 用 `applyAgentEvent()` 把事件流归并成 session state
- 收集异步事件流
- 提供 executor 和 timeline action 的基础能力

-------------------------------
5. `packages/model-gateway`
-------------------------------

这个包现在是模型路由 / profile 的 stub。

它已经表达了"按任务类型分模型"的方向：

- planning
- coding
- review
- summary
- title

默认 profile 里也区分了不同任务对应的模型名，但当前实现并没有真正调用外部模型，只是返回 demo 事件流。

-------------------------------
6. `packages/runtime-browser`
-------------------------------

这是浏览器运行时 stub，不是完整沙箱，而是一个为了 demo 闭环存在的浏览器端适配层。

支持：

- 写文件和 patch 文件
- 列出文件
- 模拟命令执行接口
- 发出文件变化事件
- 打开 preview
- 对非 HTML 内容生成结构化 fallback preview

-------------------------------
7. `packages/runtime-remote`
-------------------------------

这个包现在只是远程 runtime 的结构占位，还没有完成实现。

-------------------------------
8. `packages/ui`
-------------------------------

这个包目前不是一套完整组件库，而是共享的工作台面板定义和标签。

主要提供：

- 中间区域面板列表
- 右侧工作台面板列表
- 面板标签映射

====================
六、当前 demo 的主链路
====================

当前 demo 主要围绕"网页 block 级编辑"展开。一条典型流程是：

1. Web 端生成一个 block 编辑请求
2. Agent 用请求内容生成说明性 message 和 plan
3. `model-gateway` 产出 demo coding 输出
4. Agent 把结果包装成 `file.patch` 动作
5. Session 中插入确认型 interaction
6. Executor 回放动作
7. Browser runtime stub 发出 `file.changed`
8. Browser runtime stub 发出 `preview.ready`
9. Web 端把这些状态渲染成 chat、plan、timeline、files 和 preview

也就是说，这个仓库当前重心是：

- 定义事件怎么流动
- 定义状态怎么被 reducer 吸收
- 定义 UI 怎么消费这些状态

而不是：

- 让模型真正自主改完整项目
- 真正启动远程容器
- 接入真实数据库

当前 demo 有几个重要限定：

- 流程是 seeded demo flow，不是真正由用户输入驱动的实时对话
- patch 是 block-scoped demo patch，不是完整 AST 级代码变更系统
- preview 是 runtime stub 的回放结果，不是远程真实应用部署

====================
七、Web 端现在是怎么组织的
====================

`apps/web` 当前不是一个"直接连模型 API 的聊天应用"，而是一个消费 demo event stream 的工作台渲染层。

它的关键职责包括：

1. 归并事件

`reduceWorkbenchEvents()` 会把初始事件集约成 session 相关状态。

2. 组织 view model

`createWorkbenchViewModel()` 负责把 session state 变成 UI 更容易消费的结构，例如：

- chat messages
- plan
- actions
- pending interaction
- files
- previews
- patch actions
- 当前 block 编辑状态
- 当前 diff 选中项

3. 定义交互式网页编辑状态

Web 端维护了 block、selection、properties、intent、suggestedPrompt 这些状态，说明当前 demo 不是单纯展示事件，而是已经有"网页局部编辑"的交互模型。

====================
八、Agent 端现在是怎么组织的
====================

`apps/agent` 当前是一个 demo flow orchestrator。

它的重点不是"复杂 agent 自主性"，而是把系统涉及的关键事件都串起来：

- planner message
- plan update
- model output
- approval interaction
- action created / updated
- file changed
- preview ready

这让整个 repo 可以在没有真实模型、没有真实远程 runtime 的情况下，先把 session 演化路径和 workbench 展示路径跑通。

换句话说，当前 `apps/agent` 的主要价值是"验证协议和状态机"，不是"完成真正智能体能力"。

====================
九、当前实现最重要的工程判断
====================

从工程角度看，这个 repo 当前最正确的几个判断是：

1. 先把协议做出来

很多 AI 产品一开始把所有状态塞进页面组件和接口返回里，后面越做越乱。这个 repo 先抽出 `@ezu/protocol`，方向是对的。

2. 先把 reducer 做出来

事件驱动系统如果没有明确的 state reduction 层，很快就会出现 UI、agent、runtime 三边各自维护状态的问题。现在 `@ezu/core` 先承担这层职责，是合理的。

3. 先把 runtime 抽象做出来

即使当前 `runtime-remote` 还没实现，`RuntimeAdapter` 已经把未来扩展位留好了。这能显著降低后续替换执行层的成本。

4. 先用 stub 验证闭环

在真实模型、真实沙箱、真实存储都还没接入前，先用 stub 跑通 message -> plan -> action -> preview 的闭环，是更稳的实现顺序。

====================
十、当前局限也需要明确
====================

如果按"当前仓库已经实现了什么"来判断，以下限制必须明确：

1. `model-gateway` 目前只是 stub，不是真实供应商接入层。

2. `runtime-browser` 目前是浏览器侧演示 runtime，不是完整沙箱。

3. `runtime-remote` 目前还是结构占位，没有真实执行能力。

4. session 目前是内存态 / demo 态，不是持久化产品状态。

5. 当前测试覆盖仍然偏窄，主要覆盖 replacement prompt / structure 相关 helper。

====================
十一、代码阅读顺序建议
====================

理解这个 repo，建议按下面顺序看：

1. 先看 `README.md` — 明确仓库当前目标和限制，避免把它误读成完整产品。

2. 再看 `packages/protocol/src/index.ts` — 先搞清楚系统里有哪些 action、event、interaction、session 字段。

3. 再看 `packages/core/src/index.ts` — 理解 session 是怎么随着事件演进的。

4. 再看 `apps/agent/src/index.ts` — 理解 demo agent 如何构造 plan、patch action、approval 和 preview 事件。

5. 最后看 `apps/web/src/index.ts` — 理解 Web 端如何把这些事件归并成用户能看到的工作台状态。

====================
十二、当前阶段与总结
====================

最准确的理解方式是：

这个 repo 现在处于"架构原型已经成形、产品能力仍然很早期"的阶段。

它已经证明：

- monorepo 分层基本成立
- 协议设计可以支撑 demo agent workflow
- reducer 可以把事件流稳定压成 session state
- Web workbench 可以消费这些状态并形成 IDE 风格界面

但它还没有证明：

- 真实模型接入后的行为稳定性
- 真实 runtime 执行的可靠性
- 多会话、多项目、持久化和权限控制
- 生产环境下的性能和安全性

一句话总结：

"一个把协议、状态归并、demo agent、浏览器 runtime stub 和 workbench UI 串起来的可运行架构样板"

如果后续继续推进，最自然的扩展顺序是：

- 先把 stubbed model gateway 替换成真实模型调用
- 再把 remote runtime 补齐
- 再加持久化和真实会话管理
- 最后再补更复杂的 agent orchestration 与权限控制
