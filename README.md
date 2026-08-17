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
├── user.md           用户偏好
└── archive.md        记忆归档（被取代/重复的条目移入此处，可手动恢复）

~/.dsh/memory/        用户级记忆（L2 共享层）
└── 同构的 index.md + 四类知识文件（无 state.md）
```

**记忆分层（L2）**：工作区记忆保持项目独立（默认注入，占 70% 预算）；用户级
记忆 `~/.dsh/memory/` 记录个人偏好与跨项目通用经验（注入时占 30% 预算，带独立
来源标注，绝不与项目知识混编）。工具 `scope` 参数控制读写层：`memory_update` /
`memory_compact` 支持 `scope: workspace | user`，`memory_recall` 额外支持
`scope: all`（合并检索，用户级结果带「用户级/」标注）。敏感项目可在配置关
`userMemory: false` 完全禁用用户级层。

设计参照 Claude Code Auto Memory 骨架 + harness 适配（详见 `docs/方案选型分析-推荐.md`）：

1. **会话边界注入**：每个 `agent/pre-step`，插件把记忆摘要（指针索引 + state 截断块）
   折进消息批次；索引有硬边界（默认 200 行 / 25KB），超限注入 WARNING 而非静默截断
2. **turn-end 提醒**：每回合结束提示 Agent 判断是否值得写入记忆（不依赖自觉）
3. **模型工具**：
   - `memory_recall`：渐进式查阅——无参返回索引摘要；传 `category`
     （decisions/patterns/troubleshooting/user/state）读对应文件；传 `query` 做
     grep 关键词搜索；传 `path` 直接读 `.dsh/memory/` 下任意文件；
     `scope`（workspace/user/all）跨层检索，`all` 合并两层、用户级结果带来源标注
   - `memory_update`：把经验条目追加进四类知识文件并重建指针索引；可传
     `supersede`（同分类的旧条目标题）把旧条目标记为已废弃，避免重复条目；
     `scope: user` 写入用户级记忆（仅个人偏好/跨项目经验）
   - `memory_state`：更新 state.md 的 section（当前进度/上次会话状态/经验暂存）
   - `memory_compact`：记忆养护——`report` 审计各文件条目统计（重复组/废弃/
     陈旧/索引压力）；`apply` 合并同标题重复条目（保留最新）、把超龄废弃条目
     归档到 archive.md 并重建索引（可逆，不硬删）；`scope: user` 审计用户级
   - `memory_confirm`：经验暂存确认闭环——列出 state.md 暂存条目，`index="all"`
     或编号列表把选定条目归档进知识文件并清空暂存区
4. **经验确认流**：非平凡工作后经验暂存到 state.md，下次会话经 `memory_confirm`
   确认后归档（闭环完成）；被取代的经验走 `supersede`，超龄废弃条目由
   `memory_compact` 归入 archive.md，杜绝记忆膨胀与冲突误导
5. **记忆纪律**：记忆只是提示——行动前用真实文件核实；只记代码/git 推导不出的信息

## 安装

> 本插件**只在 agent preset 平面启用**（host 平面不挂载，避免全局注入）。因此
> 安装 = ① 把包装入 profile 依赖（preset 解析用）+ ② 安装 preset 并选用。

```bash
# ① 装入 profile 依赖（仅依赖，不挂载 host 平面）
dsh plugin --profile <name> add link:<本仓库路径>

# ② 安装 Agent preset「记忆模式」（主方式，见下节）
```

## Agent preset：记忆模式

`preset/memory/` 是一个可用的 agent preset（`preset.yml` + `agent.cordis.yml`），
组装了本插件 + 标准工具集。安装：

```bash
# 复制到用户预设目录（<repo-path> 替换为本仓库路径）
# 注意：必须复制而非链接 —— Windows Junction 对 agent-presets 发现不可见
# （Dirent.isDirectory() 对 junction 返回 false），链接的 preset 不会出现在列表
Copy-Item "<repo-path>\preset\memory" "$env:USERPROFILE\.dsh\.agent-presets\memory" -Recurse -Force
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
| `userMemory` | `true` | 是否启用用户级记忆（~/.dsh/memory/）并注入其索引 |

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## 许可

MIT
