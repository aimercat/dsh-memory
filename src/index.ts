/**
 * @deepseek-ai/dsh-memory — workspace memory for DeepSeek Harness.
 *
 * Cross-session memory lives under `{projectRoot}/.dsh/memory/`, following
 * the Claude Code Auto Memory skeleton with harness-specific adaptations:
 *
 * - `index.md`          — pointer-style index (one pointer line per entry,
 *                         hard-capped by lines AND bytes)
 * - `state.md`          — single state file: current progress + last-session
 *                         state + staged-experience (confirmation) section
 * - `decisions.md`      — architecture decisions
 * - `patterns.md`       — code patterns and project conventions
 * - `troubleshooting.md`— debugging experience and known pitfalls
 * - `user.md`           — user preferences and working style
 *
 * Design (from docs/方案选型分析-推荐.md):
 * - pointer-style index: the model only sees index pointers + state digest;
 *   details live in topic files read on demand (Claude Code MEMORY.md pattern)
 * - hard boundary: index is capped (default 200 lines / 25 KB); over the cap
 *   the injected block carries a WARNING instead of silently truncating
 * - session-boundary injection: on every `agent/pre-step`, fold the memory
 *   digest into the step's message batch (aligned with agent-instructions)
 * - write paths: `memory_update` (4 knowledge categories) + `memory_state`
 *   (state.md incl. staged experience) + turn-end reminder nudging the agent
 * - experience-confirmation flow: after non-trivial work the agent stages an
 *   experience entry in state.md; the next session surfaces it for user
 *   confirmation before archiving into a knowledge file
 * - retrieval: progressive (index digest → category file → raw path) plus a
 *   keyword grep search; no vector stack
 *
 * Both halves are pure host-side: no client bundle, no web routes.
 *
 * @module @deepseek-ai/dsh-memory
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'memory'
/** The tool registry must exist before tool registration. */
export const inject = ['tools']

/** Knowledge category files (writable through memory_update). */
export const KNOWLEDGE_FILES = [
  'decisions.md',
  'patterns.md',
  'troubleshooting.md',
  'user.md',
] as const

/** The single state file (progress + last state + staged experience). */
export const STATE_FILE = 'state.md'

/** The pointer-style index file. */
export const INDEX_FILE = 'index.md'

/** Default hard caps for the injected index block (Claude Code MEMORY.md pattern). */
export const DEFAULT_MAX_INDEX_LINES = 200
export const DEFAULT_MAX_INDEX_BYTES = 25_000

/** Model-facing memory plugin configuration. */
export interface Config {
  /** Byte budget for the injected memory context; 0 disables injection. */
  maxBytes: number
  /** Whether the memory tools are registered. */
  toolsEnabled: boolean
  /** Hard cap on injected index lines (Claude Code MEMORY.md pattern). */
  maxIndexLines: number
  /** Hard cap on injected index bytes. */
  maxIndexBytes: number
  /** Whether a turn-end reminder nudges the agent to persist memory. */
  turnEndReminder: boolean
}

/** 插件配置 schema，供 Cordis loader 做校验与默认值注入。 */
export const Config = Schema.object({
  maxBytes: Schema.number().default(8192).description('注入到模型上下文的记忆字节预算；0 表示禁用注入。'),
  toolsEnabled: Schema.boolean().default(true).description('是否注册 memory_recall / memory_update / memory_state 工具。'),
  maxIndexLines: Schema.number().default(DEFAULT_MAX_INDEX_LINES).description('记忆索引注入的最大行数。'),
  maxIndexBytes: Schema.number().default(DEFAULT_MAX_INDEX_BYTES).description('记忆索引注入的最大字节数。'),
  turnEndReminder: Schema.boolean().default(true).description('是否在回合结束后提示持久化非平凡经验。'),
})

/** One pointer row of the index digest. */
export interface MemoryIndexRow {
  file: string
  summary: string
}

/** The composed memory context handed to the model. */
export interface MemoryContext {
  /** Pointer-style index rows (file → summary). */
  index: MemoryIndexRow[]
  /** The state file digest, when present. */
  state?: string
  /** Whether the index exceeded the hard cap (injection carries a WARNING). */
  indexOverCap: boolean
  /** Byte budget actually applied. */
  budget: number
}

/** Resolve the memory directory for a session cwd: `{projectRoot}/.dsh/memory`. */
export async function memoryDirOf(cwd: string): Promise<string> {
  const projectRoot = await findProjectRoot(cwd)
  return join(projectRoot, '.dsh', 'memory')
}

/** Walk upward from `cwd` to the nearest directory containing `.git`; no git root found, keep `cwd`. */
async function findProjectRoot(cwd: string): Promise<string> {
  let current = cwd
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const info = await statDir(join(current, '.git'))
      if (info) return current
    } catch {
      // not a git root; walk up
    }
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
  return cwd
}

/** stat a path and return whether it exists as a file or directory. */
async function statDir(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

/** Read one memory file; returns undefined when missing or unreadable. */
async function readMemoryFile(dir: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, name), 'utf8')
  } catch {
    return undefined
  }
}

/** Truncate to the byte budget, keeping whole lines and marking the cut. */
function truncate(text: string, budget: number): string {
  if (text.length <= budget) return text
  const cut = text.slice(0, budget)
  const newline = cut.lastIndexOf('\n')
  const body = newline >= 0 ? cut.slice(0, newline) : cut
  return `${body}\n… (截断：超过 ${budget} 字节预算)`
}

/**
 * Compose the memory context digest: pointer-style index rows + state digest.
 * The index block is capped by lines and bytes; over the cap the context marks
 * `indexOverCap` so the injection carries an explicit WARNING (Claude Code's
 * "Only part of it was loaded" lesson — never silently truncate).
 */
export async function composeMemoryContext(
  dir: string,
  maxBytes: number,
  maxIndexLines = DEFAULT_MAX_INDEX_LINES,
  maxIndexBytes = DEFAULT_MAX_INDEX_BYTES,
): Promise<MemoryContext> {
  const rows: MemoryIndexRow[] = []
  let indexOverCap = false
  const indexText = await readMemoryFile(dir, INDEX_FILE)
  if (indexText !== undefined) {
    // Pointer-style rows: `- [Title](file.md) — summary` (one line each).
    let lineCount = 0
    let byteCount = 0
    for (const line of indexText.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const match = /^- \[(.+?)\]\(<([^>]+\.md)>\)\s*(?:—|-)?\s*(.*)$/.exec(trimmed)
      if (match !== null) {
        lineCount += 1
        byteCount += Buffer.byteLength(line, 'utf8')
        if (lineCount <= maxIndexLines && byteCount <= maxIndexBytes) {
          rows.push({ file: match[2]!, summary: match[3]!.trim() || match[1]!.trim() })
        } else {
          indexOverCap = true
        }
      }
    }
  }
  if (rows.length === 0 && !indexOverCap) {
    // No index yet: derive per-file summaries from the first heading.
    for (const file of KNOWLEDGE_FILES) {
      const text = await readMemoryFile(dir, file)
      if (text === undefined) continue
      const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim()
      rows.push({ file, summary: heading ?? '（无标题）' })
    }
  }
  const state = await readMemoryFile(dir, STATE_FILE)
  const context: MemoryContext = { index: rows, indexOverCap, budget: maxBytes }
  if (state !== undefined && state.trim() !== '') {
    context.state = truncate(state, Math.floor(maxBytes / 2))
  }
  return context
}

/** Render the composed memory context into a model-facing text block. */
export function renderMemoryContext(context: MemoryContext): string {
  const lines: string[] = []
  if (context.index.length > 0) {
    lines.push('以下为本工作区记忆索引（.dsh/memory/index.md）：')
    for (const row of context.index) {
      lines.push(`- ${row.file}：${row.summary}`)
    }
    if (context.indexOverCap) {
      lines.push('')
      lines.push('> WARNING: 记忆索引超过行数/字节上限，部分条目未加载。请精简索引或拆分话题文件。')
    }
  }
  if (context.state !== undefined) {
    lines.push('')
    lines.push('当前工作区状态（.dsh/memory/state.md）：')
    lines.push(context.state)
  }
  if (lines.length === 0) return ''
  lines.push('')
  lines.push(
    '记忆纪律：记忆只是提示——行动前用真实文件核实。'
    + '如需查阅完整记忆或写入新经验，调用 memory_recall / memory_update / memory_state 工具。'
    + '完成非平凡工作后应把经验写入记忆，使其跨会话存活。',
  )
  return lines.join('\n')
}

/** Create the memory directory if absent (idempotent). */
async function ensureMemoryDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** Append an entry to a knowledge file, then rebuild the pointer index. */
export async function appendMemoryEntry(
  dir: string,
  category: string,
  title: string,
  body: string,
): Promise<void> {
  await ensureMemoryDir(dir)
  const file = `${category}.md`
  const date = new Date().toISOString().slice(0, 10)
  const entry = `\n## [+] ${title} (${date})\n\n${body.trim()}\n`
  let existing = await readMemoryFile(dir, file)
  existing = existing ?? `# ${category}\n\n`
  if (!existing.endsWith('\n')) existing += '\n'
  await writeFile(join(dir, file), existing + entry, 'utf8')
  await rebuildIndex(dir)
}

/** Rebuild `index.md` as pointer rows from the knowledge files' `[+]` entries. */
export async function rebuildIndex(dir: string): Promise<void> {
  const rows: MemoryIndexRow[] = []
  for (const file of KNOWLEDGE_FILES) {
    const text = await readMemoryFile(dir, file)
    if (text === undefined) continue
    for (const match of text.matchAll(/^## \[\+\]\s+(.+?)\s*\((\d{4}-\d{2}-\d{2})\)/gm)) {
      rows.push({ file, summary: `${match[1]} (${match[2]})` })
    }
  }
  const lines = ['# 记忆索引', '']
  for (const row of rows) {
    lines.push(`- [${row.summary.split(' (')[0]!}](<${row.file}>) — ${row.summary}`)
  }  lines.push('', '> 由 dsh-memory 自动维护；每次写入记忆条目后重建。')
  await writeFile(join(dir, INDEX_FILE), lines.join('\n') + '\n', 'utf8')
}

/** Read the state file and split it into its sections. */
export async function readState(dir: string): Promise<Record<string, string>> {
  const text = await readMemoryFile(dir, STATE_FILE)
  if (text === undefined) return {}
  const sections: Record<string, string> = {}
  let current: string | undefined
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line.trim())
    if (heading !== null) {
      current = heading[1]!.trim()
      sections[current] = ''
    } else if (current !== undefined) {
      sections[current] += `${line}\n`
    }
  }
  return sections
}

/** Update one section of state.md, preserving the others. */
export async function updateStateSection(
  dir: string,
  section: string,
  body: string,
): Promise<void> {
  await ensureMemoryDir(dir)
  const sections = await readState(dir)
  const hadFile = Object.keys(sections).length > 0 || await fileExists(dir, STATE_FILE)
  sections[section] = body.trim() === '' ? '' : `${body.trim()}\n`
  const lines = ['# 工作区状态', '']
  for (const [name, content] of Object.entries(sections)) {
    if (content === '') continue
    lines.push(`## ${name}`, '', content.trimEnd(), '')
  }
  if (!hadFile && Object.values(sections).every(content => content === '')) {
    // First creation with no content yet: seed the standard sections so the
    // file is self-documenting.
    lines.push(
      '## 当前进度', '',
      '（未记录）', '',
      '## 上次会话状态', '',
      '（未记录）', '',
      '## 经验暂存', '',
      '（待确认归档的经验条目，下次会话提醒用户确认）', '',
    )
  }
  await writeFile(join(dir, STATE_FILE), lines.join('\n') + '\n', 'utf8')
}

/** Whether a file exists at `dir/name`. */
async function fileExists(dir: string, name: string): Promise<boolean> {
  try {
    await stat(join(dir, name))
    return true
  } catch {
    return false
  }
}

/** Keyword grep across all memory files (Claude Code's grep-over-RAG stance). */
export async function searchMemory(dir: string, query: string): Promise<string> {
  const needle = query.toLowerCase()
  const results: string[] = []
  const files = [INDEX_FILE, STATE_FILE, ...KNOWLEDGE_FILES]
  for (const file of files) {
    const text = await readMemoryFile(dir, file)
    if (text === undefined) continue
    const matches: string[] = []
    for (const line of text.split('\n')) {
      if (line.toLowerCase().includes(needle)) matches.push(line.trim())
    }
    if (matches.length > 0) {
      results.push(`### ${file}`)
      results.push(...matches.slice(0, 20))
      if (matches.length > 20) results.push(`… 共 ${matches.length} 行匹配`)
    }
  }
  return results.length > 0 ? results.join('\n') : `（无匹配：${query}）`
}

/** Guard a raw memory path against traversal outside .dsh/memory/. */
function normalizeMemoryPath(path: string): string {
  const cleaned = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (cleaned.includes('..')) throw new Error(`非法记忆路径：${path}`)
  return cleaned
}

/**
 * Register the memory plugin: session-boundary injection, turn-end reminder,
 * and the model-facing tools.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - memory plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const { maxBytes, toolsEnabled, maxIndexLines, maxIndexBytes, turnEndReminder } = config

  // ── session-boundary injection ────────────────────────────────────────
  // Fold a bounded memory digest into every entering step's message batch,
  // right after the claimed batch (agent-instructions discipline). One digest
  // per message batch: a single model turn often fans out into several
  // `agent/pre-step` hooks (thinking steps, tool-call steps, continuations),
  // and re-injecting the same digest for each would duplicate the block.
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (maxBytes <= 0 || decision.kind === 'reject') return decision
    // Dedup guard: if this batch already carries a memory digest, leave it
    // alone — never inject the same memory context twice into one turn.
    if (decision.messages.some(message => (message as { source?: { kind?: string } }).source?.kind === 'dsh-memory')) {
      return decision
    }
    signal?.throwIfAborted()
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return decision
    const dir = await memoryDirOf(cwd)
    const context = await composeMemoryContext(dir, maxBytes, maxIndexLines, maxIndexBytes)
    const text = renderMemoryContext(context)
    if (text === '') return decision
    const block: UserMessageLike = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-memory' as never },
    }
    const lastClaimed = decision.messages.findLastIndex(message => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimed + 1, 0, block as never)
    return { kind: 'enter', messages: entered }
  })

  // ── turn-end reminder ─────────────────────────────────────────────────
  // After every turn, nudge the agent to persist non-trivial experience.
  // The reminder lands in the inbox and is folded into the next step.
  if (turnEndReminder) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const cwd = session.header.cwd
      if (cwd === undefined) return
      void (async () => {
        try {
          const dir = await memoryDirOf(cwd)
          await ensureMemoryDir(dir)
          const agent = ctx.get('agents') as { get(id: string): { inbox: InboxLike } | undefined } | undefined
          const entry = agent?.get(session.id)
          if (entry === undefined) return
          // One reminder per pending batch: never queue a second while one is
          // already waiting for the next step (the inbox would pile up stale
          // nudges and duplicate the same message identity).
          if (entry.inbox.nextStep.some(message => message.source?.kind === 'dsh-memory')) return
          const reminder: UserMessageLike = {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text:
              '本回合已结束。如果本回合产生了值得跨会话保留的经验（架构决策/代码模式/排查经验/用户偏好），'
              + '请在下一回合用 memory_update 或 memory_state 工具写入工作区记忆（.dsh/memory/）。'
              + '判断标准：解决新问题、发现模式、做决策、踩坑——否则无需写入。' }],
            source: { kind: 'dsh-memory' as never },
          }
          entry.inbox.prepend('next-step', reminder as never)
        } catch (error) {
          // The reminder is a best-effort nudge; a queueing failure must never
          // take down the host process with an unhandled rejection.
          ctx.logger.warn('memory turn-end reminder failed: %o', error)
        }
      })()
    })
  }

  if (!toolsEnabled) return

  // ── memory_recall ─────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Progressive lookup into the workspace memory (.dsh/memory). With no argument, '
      + 'returns the index digest. Pass a category (decisions | patterns | troubleshooting | user) '
      + 'to read that file; pass state to read state.md; pass query for a keyword grep across '
      + 'all memory files; pass a raw path under .dsh/memory/ to read it directly. '
      + 'Use at session start and when the task relates to past work or project knowledge. '
      + 'Memory is only a hint — verify against real files before acting.',
    parameters: {
      category: {
        type: 'string',
        enum: [...KNOWLEDGE_FILES.map(f => f.replace('.md', '')), 'state'],
        description: 'decisions | patterns | troubleshooting | user | state (omit for the index digest).',
      },
      query: {
        type: 'string',
        description: 'Keyword to grep across all memory files (overrides category).',
      },
      path: {
        type: 'string',
        description: 'Raw file path under .dsh/memory/ to read (highest priority).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) throw new Error('memory_recall requires an owning agent session')
      return (async () => {
        const dir = await memoryDirOf(cwd)
        const rawPath = typeof args.path === 'string' ? args.path : undefined
        if (rawPath !== undefined) {
          const safe = normalizeMemoryPath(rawPath)
          const text = await readMemoryFile(dir, safe)
          return { text: text ?? `（无此文件：${safe}）` }
        }
        const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query.trim() : undefined
        if (query !== undefined) {
          return { text: await searchMemory(dir, query) }
        }
        const category = typeof args.category === 'string' ? args.category : undefined
        if (category !== undefined) {
          const file = category === 'state' ? STATE_FILE : `${category}.md`
          const text = await readMemoryFile(dir, file)
          return { text: text ?? '（该分类暂无条目）' }
        }
        const context = await composeMemoryContext(dir, maxBytes, maxIndexLines, maxIndexBytes)
        return { text: renderMemoryContext(context) || '（暂无记忆）' }
      })()
    },
    presentCall: args => ({ card: 'generic', title: 'Recall workspace memory', kind: 'other', rawInput: args }),
  }))

  // ── memory_update ─────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_update',
    description:
      'Persist an experience entry into a knowledge file of the workspace memory (.dsh/memory). '
      + 'Category decides the file: decisions (architecture decisions), patterns (code patterns), '
      + 'troubleshooting (debugging experience), user (user preferences). '
      + 'Use after completing non-trivial work so the knowledge survives the session; '
      + 'the pointer index is rebuilt automatically. Only record information that is not '
      + 'derivable from code or git history.',
    parameters: {
      category: {
        type: 'string',
        required: true,
        enum: [...KNOWLEDGE_FILES.map(f => f.replace('.md', ''))],
        description: 'Which memory file to append to.',
      },
      title: {
        type: 'string',
        required: true,
        description: 'Short entry title, e.g. "OAuth2 + refresh token 方案".',
      },
      body: {
        type: 'string',
        required: true,
        description: 'The experience: context, what was decided/learned, why.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          file: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已写入 ${value.file}` }],
    },
    execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) throw new Error('memory_update requires an owning agent session')
      const category = typeof args.category === 'string' ? args.category : ''
      const title = typeof args.title === 'string' ? args.title : ''
      const body = typeof args.body === 'string' ? args.body : ''
      if (category === '' || title === '' || body === '') {
        throw new Error('memory_update 需要 category / title / body 均为字符串')
      }
      return (async () => {
        const dir = await memoryDirOf(cwd)
        await appendMemoryEntry(dir, category, title, body)
        return { ok: true, file: `${category}.md` }
      })()
    },
    presentCall: args => ({ card: 'generic', title: 'Update workspace memory', kind: 'other', rawInput: args }),
  }))

  // ── memory_state ──────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_state',
    description:
      'Update the workspace state file (.dsh/memory/state.md) — current progress, '
      + 'last-session state, or staged experience. Use at session boundaries: update '
      + '"当前进度" as you make progress, update "上次会话状态" at the end of a session, '
      + 'and stage non-trivial experience under "经验暂存" for user confirmation '
      + '(the next session surfaces it before archiving into a knowledge file).',
    parameters: {
      section: {
        type: 'string',
        required: true,
        enum: ['当前进度', '上次会话状态', '经验暂存'],
        description: 'Which state.md section to replace.',
      },
      body: {
        type: 'string',
        required: true,
        description: 'The section content (empty string clears the section).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? '状态已更新' : '状态未更新' }],
    },
    execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) throw new Error('memory_state requires an owning agent session')
      const section = typeof args.section === 'string' ? args.section : ''
      const body = typeof args.body === 'string' ? args.body : ''
      if (section === '') throw new Error('memory_state 需要 section')
      return (async () => {
        const dir = await memoryDirOf(cwd)
        await updateStateSection(dir, section, body)
        return { ok: true }
      })()
    },
    presentCall: args => ({ card: 'generic', title: 'Update workspace state', kind: 'other', rawInput: args }),
  }))
}

/** Minimal user-message shape used for the injected memory block. */
interface UserMessageLike {
  /** Stable unique identity; the agent inbox rejects messages without one. */
  id: string
  /** Session replay expects injected user-visible messages to carry the user role. */
  role: 'user'
  content: { type: string; text: string }[]
  source: { kind: string }
}

/** Minimal inbox face used by the turn-end reminder. */
interface InboxLike {
  readonly nextStep: readonly UserMessageLike[]
  prepend(phase: 'next-step', message: UserMessageLike): void
}
