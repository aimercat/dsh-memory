# dsh-memory

DeepSeek Harness 工作区记忆插件：**跨会话状态恢复 + 项目知识库**。

## 它解决什么

Harness 新会话默认是"白纸"——除 AGENTS.md 与会话历史外，工作区没有跨会话状态：
上次做到哪、做过什么决策、踩过什么坑，都随会话结束丢失。`dsh-memory` 把记忆
落盘到工作区目录，并在会话边界自动注入摘要，让每个新会话都能接续上次的工作。

## 机制

```
{projectRoot}/.dsh/memory/
├── index.md          指针式索引（每行一个指针 → 话题文件，硬边界内）
├── state.md          单一状态文件（当前进度 + 上次状态 + 经验暂存区）
├── decisions.md      架构决策
├── patterns.md       代码模式与约定
├── troubleshooting.md 排查经验与已知坑位
└── user.md           用户偏好
```

设计参照 Claude Code Auto Memory 骨架 + harness 适配（详见 `docs/方案选型分析-推荐.md`）：

1. **会话边界注入**：每个 `agent/pre-step`，插件把记忆摘要（指针索引 + state 截断块）
   折进消息批次；索引有硬边界（默认 200 行 / 25KB），超限注入 WARNING 而非静默截断
2. **turn-end 提醒**：每回合结束提示 Agent 判断是否值得写入记忆（不依赖自觉）
3. **模型工具**：
   - `memory_recall`：渐进式查阅——无参返回索引摘要；传 `category`
     （decisions/patterns/troubleshooting/user/state）读对应文件；传 `query` 做
     grep 关键词搜索；传 `path` 直接读 `.dsh/memory/` 下任意文件
   - `memory_update`：把经验条目追加进四类知识文件并重建指针索引
   - `memory_state`：更新 state.md 的 section（当前进度/上次会话状态/经验暂存）
4. **经验确认流**：非平凡工作后经验暂存到 state.md，下次会话提醒用户确认后归档
5. **记忆纪律**：记忆只是提示——行动前用真实文件核实；只记代码/git 推导不出的信息

## 安装

```bash
# 作为插件装入 profile（与 dsh-web-ui 插件同一机制）
dsh plugin --profile <name> add link:G:\CodeRep\dsh_memory_support
```

或通过本仓库提供的 Agent preset「记忆模式」直接组装（见下）。

## Agent preset：记忆模式

`preset/memory/` 是一个可用的 agent preset（`preset.yml` + `agent.cordis.yml`），
组装了本插件 + 标准工具集。安装：

```bash
# 复制到用户预设目录
cp -r preset/memory ~/.dsh/.agent-presets/memory

# 或直接链接（开发迭代推荐）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\.agent-presets\memory" -Target "G:\CodeRep\dsh_memory_support\preset\memory"
```

新建会话时选择「记忆模式」预设即可。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxBytes` | `8192` | 注入的记忆摘要字节预算；0 = 禁用注入 |
| `toolsEnabled` | `true` | 是否注册 memory_recall / memory_update / memory_state 工具 |
| `maxIndexLines` | `200` | 指针索引注入行数上限（Claude Code MEMORY.md 范式） |
| `maxIndexBytes` | `25000` | 指针索引注入字节上限 |
| `turnEndReminder` | `true` | 每回合结束是否提示 Agent 考虑写入记忆 |

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## 许可

MIT
