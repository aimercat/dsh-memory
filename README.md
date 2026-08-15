# dsh-memory

DeepSeek Harness 工作区记忆插件：**跨会话状态恢复 + 项目知识库**。

## 它解决什么

Harness 新会话默认是"白纸"——除 AGENTS.md 与会话历史外，工作区没有跨会话状态：
上次做到哪、做过什么决策、踩过什么坑，都随会话结束丢失。`dsh-memory` 把记忆
落盘到工作区目录，并在会话边界自动注入摘要，让每个新会话都能接续上次的工作。

## 机制

```
{projectRoot}/.dsh/memory/
├── current.md        当前进度（@agent 行、阶段状态）
├── last.md           上次会话结束状态（时间/阶段/操作/文件/待续/决策/经验）
├── decisions.md      架构决策（这个项目是什么样）
├── patterns.md       代码模式与约定
├── troubleshooting.md 排查经验与已知坑位
└── index.md          渐进式记忆索引（自动维护）
```

两层能力：

1. **会话边界注入**：每个 `agent/pre-step`，插件把记忆摘要（索引 + last.md 截断块）
   组合进 agent 收件箱，字节预算内替换/移除，与 `dsh-agent-instructions` 的
   AGENTS.md 注入同一纪律。
2. **模型工具**：
   - `memory_recall`：渐进式查阅——无参返回索引摘要；传 `category`
     （decisions/patterns/troubleshooting/last/current）读对应文件；传
     `path` 直接读 `.dsh/memory/` 下任意文件。
   - `memory_update`：把经验条目追加进分类文件并自动重建索引。

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
| `toolsEnabled` | `true` | 是否注册 memory_recall / memory_update 工具 |

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## 许可

MIT
