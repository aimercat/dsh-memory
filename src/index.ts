/**
 * @deepseek-ai/dsh-memory — workspace memory for DeepSeek Harness.
 *
 * Cross-session memory lives under `{projectRoot}/.dsh/memory/`:
 *
 * - `current.md`   — current progress overview (@agent lines, stage states)
 * - `last.md`      — last-session end state (time, stage, operation, files,
 *                    pending items, key decisions, staged experience)
 * - `decisions.md` — architecture decisions (what the project is like)
 * - `patterns.md`  — code patterns and project conventions
 * - `troubleshooting.md` — debugging experience and known pitfalls
 * - `index.md`     — progressive index of the memory files
 *
 * The plugin does two things:
 *
 * 1. Session-boundary injection: on every `agent/pre-step`, compose a bounded
 *    memory context (last state + index digest) and fold it into the step's
 *    message batch, exactly like `dsh-agent-instructions` does for AGENTS.md.
 * 2. Model-facing tools: `memory_recall` (progressive lookup) and
 *    `memory_update` (append an entry and refresh the index), so the agent
 *    persists experience across sessions.
 *
 * Both halves are pure host-side: no client bundle, no web routes.
 *
 * @module @deepseek-ai/dsh-memory
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'memory'
/** The tool registry must exist before tool registration. */
export const inject = ['tools']

/** Category files (state + knowledge). */
export const MEMORY_FILES = [
  'current.md',
  'last.md',
  'decisions.md',
  'patterns.md',
  'troubleshooting.md',
] as const

/** Knowledge categories writable through memory_update. */
export const KNOWLEDGE_CATEGORIES = ['decisions', 'patterns', 'troubleshooting'] as const

/** One row of the index digest. */
export interface MemoryIndexRow {
  file: string
  summary: string
}

/** The composed memory context handed to the model. */
export interface MemoryContext {
  /** Digest of the memory index (per-file summaries). */
  index: MemoryIndexRow[]
  /** The last-session state file content, when present. */
  last?: string
  /** Byte budget actually applied. */
  budget: number
}

/** Model-facing memory plugin configuration. */
export interface Config {
  /** Byte budget for the injected memory context; 0 disables injection. */
  maxBytes: number
  /** Whether the memory tools are registered. */
  toolsEnabled: boolean
}

/** Schemastery-style config object (plain shape for the loader). */
export const Config = {
  maxBytes: 8192,
  toolsEnabled: true,
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
      const info = await stat(join(current, '.git'))
      if (info.isDirectory() || info.isFile()) return current
    } catch {
      // not a git root; walk up
    }
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
  return cwd
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
 * Compose the memory context digest from the index file, falling back to
 * per-file summaries when no index exists yet.
 */
export async function composeMemoryContext(
  dir: string,
  maxBytes: number,
): Promise<MemoryContext> {
  const rows: MemoryIndexRow[] = []
  const indexText = await readMemoryFile(dir, 'index.md')
  if (indexText !== undefined) {
    for (const line of indexText.split('\n')) {
      const match = /^\| `([a-z]+\.md)` \| (.+?) \|/.exec(line.trim())
      if (match !== null) rows.push({ file: match[1]!, summary: match[2]!.trim() })
    }
  }
  if (rows.length === 0) {
    for (const file of MEMORY_FILES) {
      const text = await readMemoryFile(dir, file)
      if (text === undefined) continue
      const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim()
      rows.push({ file, summary: heading ?? '（无标题）' })
    }
  }
  const last = await readMemoryFile(dir, 'last.md')
  const context: MemoryContext = { index: rows, budget: maxBytes }
  if (last !== undefined) {
    context.last = truncate(last, Math.floor(maxBytes / 2))
  }
  return context
}

/** Render the composed memory context into a model-facing text block. */
export function renderMemoryContext(context: MemoryContext): string {
  const lines: string[] = []
  if (context.index.length > 0) {
    lines.push('以下为本工作区记忆索引（.dsh/memory/）：')
    for (const row of context.index) {
      lines.push(`- \`${row.file}\`：${row.summary}`)
    }
  }
  if (context.last !== undefined && context.last.trim() !== '') {
    lines.push('')
    lines.push('上次会话结束状态（.dsh/memory/last.md）：')
    lines.push(context.last)
  }
  if (lines.length === 0) return ''
  lines.push('')
  lines.push('如需查阅完整记忆或写入新经验，调用 memory_recall / memory_update 工具。')
  return lines.join('\n')
}

/** Create the memory directory if absent (idempotent). */
async function ensureMemoryDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** Append an entry to a category file, then rebuild the index. */
export async function appendMemoryEntry(
  dir: string,
  category: string,
  title: string,
  body: string,
): Promise<void> {
  await ensureMemoryDir(dir)
  const date = new Date().toISOString().slice(0, 10)
  const entry = `\n## [+] ${title} (${date})\n\n${body.trim()}\n`
  let existing = await readMemoryFile(dir, `${category}.md`)
  existing = existing ?? `# ${category}\n\n`
  if (!existing.endsWith('\n')) existing += '\n'
  await writeFile(join(dir, `${category}.md`), existing + entry, 'utf8')
  await rebuildIndex(dir)
}

/** Rebuild `index.md` from the category files' `[+]` entries. */
export async function rebuildIndex(dir: string): Promise<void> {
  const rows: MemoryIndexRow[] = []
  for (const file of MEMORY_FILES) {
    const text = await readMemoryFile(dir, file)
    if (text === undefined) continue
    const entries: string[] = []
    for (const match of text.matchAll(/^## \[\+\]\s+(.+?)\s*\((\d{4}-\d{2}-\d{2})\)/gm)) {
      entries.push(`- ${match[1]} (${match[2]})`)
    }
    rows.push({ file, summary: entries.length > 0 ? entries.join('；') : '（暂无条目）' })
  }
  const lines = ['# 记忆索引', '', '| 文件 | 摘要 |', '|------|------|']
  for (const row of rows) lines.push(`| \`${row.file}\` | ${row.summary} |`)
  lines.push('', '> 由 dsh-memory 自动维护；每次写入记忆条目后重建。')
  await writeFile(join(dir, 'index.md'), lines.join('\n') + '\n', 'utf8')
}

/** Guard a raw memory path against traversal outside .dsh/memory/. */
function normalizeMemoryPath(path: string): string {
  const cleaned = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (cleaned.includes('..')) throw new Error(`非法记忆路径：${path}`)
  return cleaned
}

/**
 * Register the memory plugin: session-boundary injection plus the model-facing
 * tools.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - memory plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const maxBytes = config.maxBytes
  const toolsEnabled = config.toolsEnabled

  // ── session-boundary injection ────────────────────────────────────────
  // Fold a bounded memory digest into every entering step's message batch,
  // right after the claimed batch, mirroring dsh-agent-instructions.
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (maxBytes <= 0 || decision.kind === 'reject') return decision
    signal?.throwIfAborted()
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return decision
    const dir = await memoryDirOf(cwd)
    const context = await composeMemoryContext(dir, maxBytes)
    const text = renderMemoryContext(context)
    if (text === '') return decision
    const block: UserMessageLike = {
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-memory' as never },
    }
    // Insert after the last claimed message so the direct prompt precedes the
    // memory digest and the driver-appended runtime context follows it.
    const lastClaimed = decision.messages.findLastIndex(message => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimed + 1, 0, block as never)
    return { kind: 'enter', messages: entered }
  })

  if (!toolsEnabled) return

  // ── memory_recall ─────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Progressive lookup into the workspace memory (.dsh/memory). With no argument, '
      + 'returns the index digest. Pass a category (decisions | patterns | troubleshooting | '
      + 'last | current) to read that file; pass a raw path under .dsh/memory/ to read it '
      + 'directly. Use at session start and when the task relates to past work or project knowledge.',
    parameters: {
      category: {
        type: 'string',
        description: 'decisions | patterns | troubleshooting | last | current (omit for the index digest).',
      },
      path: {
        type: 'string',
        description: 'Raw file path under .dsh/memory/ to read (overrides category).',
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
        const category = typeof args.category === 'string' ? args.category : undefined
        if (category !== undefined) {
          if (category === 'last' || category === 'current') {
            const text = await readMemoryFile(dir, `${category}.md`)
            return { text: text ?? '（暂无该记忆文件）' }
          }
          if (!(KNOWLEDGE_CATEGORIES as readonly string[]).includes(category)) {
            throw new Error(`未知记忆分类：${category}（decisions | patterns | troubleshooting | last | current）`)
          }
          const text = await readMemoryFile(dir, `${category}.md`)
          return { text: text ?? '（该分类暂无条目）' }
        }
        const context = await composeMemoryContext(dir, maxBytes)
        return { text: renderMemoryContext(context) || '（暂无记忆）' }
      })()
    },
    presentCall: args => ({ card: 'generic', title: 'Recall workspace memory', kind: 'other', rawInput: args }),
  }))

  // ── memory_update ─────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_update',
    description:
      'Persist an experience entry into the workspace memory (.dsh/memory). '
      + 'Category decides the file: decisions (architecture decisions), patterns (code patterns), '
      + 'troubleshooting (debugging experience). Use after completing non-trivial work so the '
      + 'knowledge survives the session; the index is rebuilt automatically.',
    parameters: {
      category: {
        type: 'string',
        required: true,
        enum: [...KNOWLEDGE_CATEGORIES],
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
}

/** Minimal user-message shape used for the injected memory block. */
interface UserMessageLike {
  content: { type: string; text: string }[]
  source: { kind: string }
}
