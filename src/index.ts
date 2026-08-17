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
import { readFile, writeFile, mkdir, stat, rename, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

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

/** Archive file for superseded / merged-away entries (reversible, never hard-deleted). */
export const ARCHIVE_FILE = 'archive.md'

/**
 * The user-level memory directory: `~/.dsh/memory/` — personal preferences and
 * cross-project experience shared by every workspace session. The workspace
 * `.dsh/memory/` stays project-scoped; the user layer is the L2 shared layer
 * (injected alongside, retrievable explicitly, never mixed into project data).
 */
export function userMemoryDirOf(): string {
  return join(homedir(), '.dsh', 'memory')
}

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
  /** Whether the user-level memory layer (~/.dsh/memory/) is injected and reachable. */
  userMemory: boolean
  /** Whether this workspace registers for cross-workspace lookup (L3). */
  crossWorkspace: boolean
}

/** 插件配置 schema，供 Cordis loader 做校验与默认值注入。 */
export const Config = Schema.object({
  maxBytes: Schema.number().default(8192).description('注入到模型上下文的记忆字节预算；0 表示禁用注入。'),
  toolsEnabled: Schema.boolean().default(true).description('是否注册 memory_recall / memory_update / memory_state 工具。'),
  maxIndexLines: Schema.number().default(DEFAULT_MAX_INDEX_LINES).description('记忆索引注入的最大行数。'),
  maxIndexBytes: Schema.number().default(DEFAULT_MAX_INDEX_BYTES).description('记忆索引注入的最大字节数。'),
  turnEndReminder: Schema.boolean().default(true).description('是否在回合结束后提示持久化非平凡经验。'),
  userMemory: Schema.boolean().default(true).description('是否启用用户级记忆（~/.dsh/memory/，个人偏好与跨项目经验）并注入其索引。'),
  crossWorkspace: Schema.boolean().default(true).description('是否将本工作区登记进跨工作区检索注册表（敏感项目请关闭）。'),
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

/**
 * Truncate to the byte budget, keeping whole lines and marking the cut.
 * Lines are accumulated from the start; the first line that would overflow
 * is partially kept up to the remaining budget (so a single long line can
 * never collapse the whole digest to a few header characters).
 */
function truncate(text: string, budget: number): string {
  if (text.length <= budget) return text
  const lines = text.split('\n')
  let out = ''
  for (const line of lines) {
    if (out.length + line.length + 1 > budget) {
      const remaining = budget - out.length - 1
      if (remaining > 0) out += line.slice(0, remaining)
      break
    }
    out += `${line}\n`
  }
  return `${out.replace(/\n$/, '')}\n… (截断：超过 ${budget} 字节预算)`
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
  let injectedIndexBytes = 0
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
        const bytes = Buffer.byteLength(line, 'utf8')
        byteCount += bytes
        if (lineCount <= maxIndexLines && byteCount <= maxIndexBytes) {
          rows.push({ file: match[2]!, summary: match[3]!.trim() || match[1]!.trim() })
          injectedIndexBytes += bytes
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
  // Dynamic budget: the index (the pointer block) takes priority and the
  // state digest gets whatever is left. When the index already consumes the
  // whole budget the state is skipped entirely instead of emitting a
  // truncated garbage block.
  const stateBudget = maxBytes - injectedIndexBytes
  if (state !== undefined && state.trim() !== '' && stateBudget > 0) {
    context.state = truncate(state, stateBudget)
  }
  return context
}

/** Render the composed memory context into a model-facing text block. */
/** Render one pointer-index block (shared by workspace and user layers). */
function renderIndexBlock(header: string, rows: MemoryIndexRow[], overCap: boolean): string[] {
  const lines: string[] = []
  if (rows.length === 0) return lines
  lines.push(header)
  for (const row of rows) {
    lines.push(`- ${row.file}：${row.summary}`)
  }
  if (overCap) {
    lines.push('')
    lines.push('> WARNING: 记忆索引超过行数/字节上限，部分条目未加载。请精简索引或拆分话题文件。')
  }
  return lines
}

/** The memory-discipline footer shared by every injected block. */
const MEMORY_DISCIPLINE =
  '记忆纪律：记忆只是提示——行动前用真实文件核实。'
  + '如需查阅完整记忆或写入新经验，调用 memory_recall / memory_update / memory_state 工具。'
  + '完成非平凡工作后应把经验写入记忆，使其跨会话存活。'
  + '用户级记忆（~/.dsh/memory/）记录个人偏好与跨项目通用经验；项目知识请写入工作区记忆。'

export function renderMemoryContext(context: MemoryContext): string {
  const lines: string[] = []
  lines.push(...renderIndexBlock('以下为本工作区记忆索引（.dsh/memory/index.md）：', context.index, context.indexOverCap))
  if (context.state !== undefined) {
    lines.push('')
    lines.push('当前工作区状态（.dsh/memory/state.md）：')
    lines.push(context.state)
  }
  if (lines.length === 0) return ''
  lines.push('')
  lines.push(MEMORY_DISCIPLINE)
  return lines.join('\n')
}

/**
 * Compose the combined context: the workspace digest gets ~70% of the byte
 * budget, the user-level digest the rest. `userDir === undefined` disables
 * the user layer (sensitive projects / config `userMemory: false`).
 */
export async function composeCombinedMemoryContext(
  dir: string,
  userDir: string | undefined,
  maxBytes: number,
  maxIndexLines = DEFAULT_MAX_INDEX_LINES,
  maxIndexBytes = DEFAULT_MAX_INDEX_BYTES,
): Promise<{ workspace: MemoryContext; user: MemoryContext | undefined }> {
  const workspaceBudget = Math.floor(maxBytes * 0.7)
  const workspace = await composeMemoryContext(dir, workspaceBudget, maxIndexLines, maxIndexBytes)
  const user = userDir === undefined
    ? undefined
    : await composeMemoryContext(userDir, maxBytes - workspaceBudget, maxIndexLines, maxIndexBytes)
  return { workspace, user }
}

/**
 * Render the combined block: workspace index + state first, then the
 * user-level index with its own source header. The discipline footer appears
 * exactly once at the end.
 */
export function renderCombinedMemoryContext(
  workspace: MemoryContext,
  user: MemoryContext | undefined,
): string {
  const lines: string[] = []
  lines.push(...renderIndexBlock('以下为本工作区记忆索引（.dsh/memory/index.md）：', workspace.index, workspace.indexOverCap))
  if (workspace.state !== undefined) {
    lines.push('')
    lines.push('当前工作区状态（.dsh/memory/state.md）：')
    lines.push(workspace.state)
  }
  if (user !== undefined) {
    lines.push(...renderIndexBlock('以下为用户级记忆索引（~/.dsh/memory/，跨项目共享）：', user.index, user.indexOverCap))
  }
  if (lines.length === 0) return ''
  lines.push('')
  lines.push(MEMORY_DISCIPLINE)
  return lines.join('\n')
}

/** Create the memory directory if absent (idempotent). */
async function ensureMemoryDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

// ── serialized-write discipline ───────────────────────────────────────────
// Every memory write is a read-modify-write cycle on a shared file. With
// multiple sessions writing concurrently (host-plane bundle + agent-plane
// preset, or several agents at once), two interleaved cycles can both read
// the pre-write content and the later writer silently drops the earlier
// entry. The module-level promise tail serializes ALL memory writes across
// every workspace and the user layer, so cycles never interleave.

let writeTail: Promise<unknown> = Promise.resolve()

/**
 * Whether the current call stack is already inside the serialized queue.
 * Nested write helpers (e.g. appendMemoryEntry → rebuildIndex) must NOT
 * re-queue: an inner task queued behind the outer one would wait for the
 * outer to finish while the outer awaits the inner — a self-deadlock.
 */
let inWriteQueue = false

/** Run `op` exclusively: queued behind every earlier memory write. */
export function serializedWrite<T>(op: () => Promise<T>): Promise<T> {
  if (inWriteQueue) return op()
  const run = writeTail.then(async () => {
    inWriteQueue = true
    try {
      return await op()
    } finally {
      inWriteQueue = false
    }
  })
  // Keep the tail alive even when a write fails (the next write must still run).
  writeTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Write a file atomically: temp file in the same directory + rename. A crash
 * mid-write can never leave a half-written memory file. On Windows, rename
 * may fail when the target is transiently held open — fall back to a direct
 * write rather than failing the operation.
 */
async function atomicWriteFile(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, content, 'utf8')
  } catch {
    // Temp write failed (disk/permission) — write directly so the caller
    // sees the real error.
    await writeFile(file, content, 'utf8')
    return
  }
  try {
    await rename(tmp, file)
  } catch {
    // Windows: the target may be transiently held open — clean up the temp
    // file and fall back to a direct write rather than failing the memory op.
    await rm(tmp, { force: true }).catch(() => undefined)
    await writeFile(file, content, 'utf8')
  }
}

/** Append an entry to a knowledge file, then rebuild the pointer index. */
export function appendMemoryEntry(
  dir: string,
  category: string,
  title: string,
  body: string,
): Promise<void> {
  // Serialized: the read-modify-write cycle must not interleave with other
  // writers (concurrent sessions would drop entries).
  return serializedWrite(async () => {
    await ensureMemoryDir(dir)
    const file = `${category}.md`
    const date = new Date().toISOString().slice(0, 10)
    const entry = `\n## [+] ${title} (${date})\n\n${body.trim()}\n`
    let existing = await readMemoryFile(dir, file)
    existing = existing ?? `# ${category}\n\n`
    if (!existing.endsWith('\n')) existing += '\n'
    await atomicWriteFile(join(dir, file), existing + entry)
    await rebuildIndex(dir)
  })
}

/** Rebuild `index.md` as pointer rows from the knowledge files' `[+]` entries. */
export function rebuildIndex(dir: string): Promise<void> {
  return serializedWrite(async () => {
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
    }
    lines.push('', '> 由 dsh-memory 自动维护；每次写入记忆条目后重建。')
    await atomicWriteFile(join(dir, INDEX_FILE), lines.join('\n') + '\n')
  })
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
export function updateStateSection(
  dir: string,
  section: string,
  body: string,
): Promise<void> {
  return serializedWrite(async () => {
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
    await atomicWriteFile(join(dir, STATE_FILE), lines.join('\n') + '\n')
  })
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
export async function searchMemory(dir: string, query: string, label = ''): Promise<string> {
  const needle = query.toLowerCase()
  const results: string[] = []
  const files = [INDEX_FILE, STATE_FILE, ARCHIVE_FILE, ...KNOWLEDGE_FILES]
  for (const file of files) {
    const text = await readMemoryFile(dir, file)
    if (text === undefined) continue
    const matches: string[] = []
    for (const line of text.split('\n')) {
      if (line.toLowerCase().includes(needle)) matches.push(line.trim())
    }
    if (matches.length > 0) {
      results.push(`### ${label}${file}`)
      results.push(...matches.slice(0, 20))
      if (matches.length > 20) results.push(`… 共 ${matches.length} 行匹配`)
    }
  }
  if (results.length > 0) return results.join('\n')
  // Exact grep found nothing — fall back to fuzzy suggestions so a wording
  // mismatch ("port conflicts" vs "docker-compose port mapping") does not
  // mean total amnesia. The model can then recall the suggested entries.
  const hits = await fuzzySuggest(dir, query)
  if (hits.length > 0) return renderFuzzySuggestions(query, hits)
  return `（无匹配：${query}）`
}

// ── fuzzy fallback (token overlap, no vector stack) ───────────────────────

/**
 * Tokenize text for fuzzy matching: ASCII words (letters/digits/hyphens)
 * plus CJK bigrams. Cheap and dependency-free — good enough to bridge
 * wording gaps between the query and stored entries.
 */
export function tokenizeForFuzzy(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = text.toLowerCase()
  for (const word of normalized.match(/[a-z0-9][a-z0-9-]*/g) ?? []) {
    tokens.add(word)
    // Hyphenated words also contribute their parts: "docker-compose" should
    // match a query searching for "docker" or "compose" alone.
    for (const part of word.split('-')) {
      if (part.length > 1) tokens.add(part)
    }
  }
  const cjk = normalized.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i < cjk.length - 1; i += 1) tokens.add(cjk.slice(i, i + 2))
  return tokens
}

/** Query-coverage score in [0, 1]: the share of query tokens present in the text. */
export function fuzzyScore(queryTokens: Set<string>, textTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0
  let hits = 0
  for (const token of queryTokens) {
    if (textTokens.has(token)) hits += 1
  }
  return hits / queryTokens.size
}

/** One fuzzy suggestion: which entry, how relevant. */
export interface FuzzyHit {
  file: string
  title: string
  /** Query-coverage score in [0, 1]. */
  score: number
}

/**
 * Score every active entry (title + body) against the query by token overlap
 * and return the closest `limit` hits. This is the wording-mismatch fallback
 * for exact grep misses — deliberately NOT a vector stack.
 */
export async function fuzzySuggest(dir: string, query: string, limit = 5): Promise<FuzzyHit[]> {
  const queryTokens = tokenizeForFuzzy(query)
  if (queryTokens.size === 0) return []
  const hits: FuzzyHit[] = []
  for (const file of KNOWLEDGE_FILES) {
    const text = await readMemoryFile(dir, file)
    if (text === undefined) continue
    for (const block of splitEntryBlocks(text)) {
      if (block.superseded) continue
      const textTokens = tokenizeForFuzzy(`${block.plainTitle} ${block.rawBody}`)
      const score = fuzzyScore(queryTokens, textTokens)
      if (score > 0) {
        hits.push({
          file,
          title: block.date === '' ? block.plainTitle : `${block.plainTitle} (${block.date})`,
          score,
        })
      }
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

/** Render fuzzy suggestions as model-facing text. */
export function renderFuzzySuggestions(query: string, hits: FuzzyHit[]): string {
  const lines = [`（无精确匹配：「${query}」。相关条目候选：）`]
  for (const hit of hits) {
    lines.push(`- ${hit.file}：${hit.title}（相关度 ${Math.round(hit.score * 100)}%）`)
  }
  lines.push('', '候选条目仅作参考——如需查看详情，用 memory_recall 读取对应分类。')
  return lines.join('\n')
}

// ── cross-workspace lookup (L3, explicit opt-in recall) ───────────────────

/** The workspace registry file inside the user-level memory dir. */
export const WORKSPACES_FILE = 'workspaces.md'

/** One registered workspace. */
export interface WorkspaceEntry {
  /** Directory basename, used as the display alias. */
  name: string
  /** Absolute path of the workspace root (the .dsh/memory parent). */
  path: string
}

/**
 * Read the cross-workspace registry (`~/.dsh/memory/workspaces.md`). The
 * registry is explicit and opt-in: only workspaces that wrote memory while
 * crossWorkspace was enabled appear here — nothing is auto-discovered.
 */
export async function listWorkspaces(userDir: string): Promise<WorkspaceEntry[]> {
  const text = await readMemoryFile(userDir, WORKSPACES_FILE)
  if (text === undefined) return []
  const entries: WorkspaceEntry[] = []
  for (const line of text.split('\n')) {
    const match = /^- \[(.+?)\]\(<(.+)>\)/.exec(line.trim())
    if (match !== null) entries.push({ name: match[1]!, path: match[2]! })
  }
  return entries
}

/**
 * Register `memoryDir` (a workspace's .dsh/memory) in the user-level registry
 * (idempotent, serialized). The display name is the project-root basename.
 * Called after a successful workspace memory write while crossWorkspace is
 * enabled; sensitive projects disable the flag and never appear here.
 */
export function registerWorkspace(userDir: string, memoryDir: string): Promise<void> {
  return serializedWrite(async () => {
    // memoryDir = <project>/.dsh/memory → project root is two levels up
    const projectRoot = dirname(dirname(memoryDir))
    const name = projectRoot.split(/[\\/]/).pop() ?? memoryDir
    const entries = await listWorkspaces(userDir)
    if (entries.some(entry => entry.path === memoryDir)) return
    const lines = ['# 已知工作区（跨工作区检索注册表）', '',
      '> 由 dsh-memory 自动维护：工作区写入记忆时登记。敏感项目可在配置关闭',
      '> crossWorkspace 后不再登记；已登记条目可手动删除。', '']
    for (const entry of entries) lines.push(`- [${entry.name}](<${entry.path}>)`)
    lines.push(`- [${name}](<${memoryDir}>)`)
    await ensureMemoryDir(userDir)
    await atomicWriteFile(join(userDir, WORKSPACES_FILE), lines.join('\n') + '\n')
  })
}

/**
 * Search every registered workspace EXCEPT the current one. Results carry a
 * `工作区<name>/` source label so the model always knows the knowledge is not
 * from the current project (联想按需、来源标注、永不进常驻注入).
 */
export async function searchAcrossWorkspaces(
  userDir: string,
  currentDir: string,
  query: string,
): Promise<string> {
  const workspaces = await listWorkspaces(userDir)
  const parts: string[] = []
  for (const entry of workspaces) {
    if (entry.path === currentDir) continue // 排除当前工作区
    const text = await searchMemory(entry.path, query, `工作区<${entry.name}>/`)
    // 只丢弃裸失败（（无匹配：…）；fuzzy 候选以「（无精确匹配：…」开头，必须保留
    if (!text.startsWith('（无匹配：')) parts.push(text)
  }
  if (parts.length === 0) return `（跨工作区无匹配：${query}。已注册 ${workspaces.length} 个工作区。）`
  return parts.join('\n\n')
}

/** Render the registry listing for the model (scope=across without query). */
export function renderWorkspaceRegistry(entries: WorkspaceEntry[]): string {
  if (entries.length === 0) {
    return '（跨工作区检索注册表为空：尚无工作区登记。工作区写入记忆且开启 crossWorkspace 后会自动登记。）'
  }
  const lines = ['🌐 已注册工作区（scope=across 可检索，排除当前工作区）：', '']
  for (const entry of entries) lines.push(`- ${entry.name}：${entry.path}`)
  lines.push('', '用法：memory_recall 传 scope="across" + query 在其他工作区的记忆中搜索。')
  return lines.join('\n')
}

// ── memory maintenance: entry blocks, supersede, archive, compact ────────

/** One parsed entry block of a knowledge file (`## [+]` / `## [-]` heading). */
export interface EntryBlock {
  /** Title without the `(date)` suffix, trimmed. */
  plainTitle: string
  /** Entry date `yyyy-mm-dd`, or '' when the entry carries none. */
  date: string
  /** True when the entry was superseded (`## [-]` marker). */
  superseded: boolean
  /** Superseded-at date `yyyy-mm-dd` ('' for active entries). */
  supersededDate: string
  /** Raw entry text (heading + body), excluding trailing blank separator. */
  raw: string
  /** Raw body text (everything after the heading line), trimmed. */
  rawBody: string
  /** Zero-based first line of the block in the source text. */
  start: number
  /** Zero-based last line (inclusive) of the block in the source text. */
  end: number
}

/** Split a knowledge file into its entry blocks (other lines are skipped). */
export function splitEntryBlocks(text: string): EntryBlock[] {
  const lines = text.split('\n')
  const blocks: EntryBlock[] = []
  let start: number | undefined
  let header: string | undefined
  const flush = (endExclusive: number): void => {
    if (start === undefined || header === undefined) return
    const raw = lines.slice(start, endExclusive).join('\n').trim()
    if (raw === '') return
    const parsed = parseEntryHeader(header)
    const rawLines = raw.split('\n')
    blocks.push({
      plainTitle: parsed.plainTitle,
      date: parsed.date,
      superseded: parsed.superseded,
      supersededDate: parsed.supersededDate,
      raw,
      rawBody: rawLines.slice(1).join('\n').trim(),
      start,
      end: endExclusive - 1,
    })
  }
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim()
    if (/^##\s+\[[+-]\]\s+/.test(trimmed)) {
      flush(i)
      start = i
      header = trimmed
    }
  }
  flush(lines.length)
  return blocks
}

/** Parse the title/date/superseded parts of an entry heading line. */
export function parseEntryHeader(heading: string): {
  plainTitle: string
  date: string
  superseded: boolean
  supersededDate: string
} {
  const match = /^##\s+\[([+-])\]\s+(.+)$/.exec(heading.trim())
  if (match === null) {
    return { plainTitle: heading.trim().replace(/^##\s+/, ''), date: '', superseded: false, supersededDate: '' }
  }
  const marker = match[1]!
  let rest = match[2]!.trim()
  let supersededDate = ''
  // Superseded rows carry a trailing "— 已废弃，由「X」取代 (date)" suffix;
  // strip it so the original title/date parse cleanly, and keep the
  // superseded-at date for staleness checks.
  const deprecation = /^(.*?)\s*—\s*已废弃，由「.+?」取代\s*\((\d{4}-\d{2}-\d{2})\)$/.exec(rest)
  if (marker === '-' && deprecation !== null) {
    supersededDate = deprecation[2]!
    rest = deprecation[1]!.trim()
  }
  const dateMatch = /^(.*?)\s*\((\d{4}-\d{2}-\d{2})\)$/.exec(rest)
  return {
    plainTitle: dateMatch === null ? rest : dateMatch[1]!.trim(),
    date: dateMatch?.[2] ?? '',
    superseded: marker === '-',
    supersededDate,
  }
}

/** Normalize a title for comparison: trim, collapse whitespace, lowercase. */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Whether an entry date is older than `maxAgeDays` days (malformed dates are never stale). */
export function isEntryStale(date: string, maxAgeDays: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const then = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(then)) return false
  return Date.now() - then > maxAgeDays * 86_400_000
}

/** The four writable knowledge categories. */
const KNOWLEDGE_CATEGORIES = KNOWLEDGE_FILES.map(file => file.replace('.md', ''))

/** Whether `category` is one of the four writable knowledge categories. */
export function isKnowledgeCategory(category: string): boolean {
  return KNOWLEDGE_CATEGORIES.includes(category)
}

/** The knowledge file name for a category. */
function knowledgeFileOf(category: string): string {
  return `${category}.md`
}

/**
 * Mark every active entry whose normalized title equals `title` as superseded
 * (`## [+]` → `## [-] … — 已废弃，由「byTitle」取代`). Superseded entries are
 * excluded from the pointer index but kept in the file until compaction.
 * Returns the raw titles that were marked.
 */
export function supersedeEntry(
  dir: string,
  category: string,
  title: string,
  byTitle: string,
): Promise<string[]> {
  return serializedWrite(async () => {
    const file = knowledgeFileOf(category)
    const text = await readMemoryFile(dir, file)
    if (text === undefined) return []
    const needle = normalizeTitle(title)
    const today = new Date().toISOString().slice(0, 10)
    const marked: string[] = []
    const out: string[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (/^##\s+\[[+-]\]\s+/.test(trimmed)) {
        const parsed = parseEntryHeader(trimmed)
        if (normalizeTitle(parsed.plainTitle) === needle && !parsed.superseded) {
          marked.push(parsed.plainTitle)
          out.push(
            `## [-] ${parsed.plainTitle}${parsed.date === '' ? '' : ` (${parsed.date})`}`
            + ` — 已废弃，由「${byTitle}」取代 (${today})`,
          )
          continue
        }
      }
      out.push(line)
    }
    if (marked.length > 0) {
      await atomicWriteFile(join(dir, file), out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n')
      await rebuildIndex(dir)
    }
    return marked
  })
}

/**
 * Find active (non-superseded) entries in a knowledge file whose normalized
 * title equals `title`. Used to warn about duplicates before writing.
 */
export async function findDuplicateTitles(dir: string, category: string, title: string): Promise<string[]> {
  const text = await readMemoryFile(dir, knowledgeFileOf(category))
  if (text === undefined) return []
  const needle = normalizeTitle(title)
  const hits: string[] = []
  for (const block of splitEntryBlocks(text)) {
    if (block.superseded) continue
    if (normalizeTitle(block.plainTitle) === needle) {
      hits.push(block.date === '' ? block.plainTitle : `${block.plainTitle} (${block.date})`)
    }
  }
  return hits
}

/**
 * Append entry blocks to `archive.md` (reversible — nothing is hard-deleted).
 * Each archived block keeps its original text plus an `[archived]` marker with
 * the archiving date and reason.
 */
export function archiveEntryBlocks(
  dir: string,
  category: string,
  blocks: EntryBlock[],
  reason: string,
): Promise<void> {
  if (blocks.length === 0) return Promise.resolve()
  return serializedWrite(async () => {
    await ensureMemoryDir(dir)
    const today = new Date().toISOString().slice(0, 10)
    const existing = await readMemoryFile(dir, ARCHIVE_FILE)
    const head = existing ?? '# 记忆归档\n\n> 被取代或重复的条目移入此处，可手动恢复；由 dsh-memory 自动维护。\n'
    const chunk = blocks
      .map(block =>
        `## [archived] ${block.plainTitle}${block.date === '' ? '' : ` (${block.date})`}`
        + ` — ${today} 归档：${reason}（原分类 ${category}）\n\n`
        + (block.rawBody === '' ? '（无正文）\n' : `${block.rawBody}\n`))
      .join('\n')
    const joined = head.endsWith('\n') ? head + chunk : `${head}\n\n${chunk}`
    await atomicWriteFile(join(dir, ARCHIVE_FILE), joined.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n')
  })
}

/** Remove the given entry blocks from a knowledge file (used after archiving). */
export function removeEntryBlocks(dir: string, category: string, blocks: EntryBlock[]): Promise<void> {
  if (blocks.length === 0) return Promise.resolve()
  return serializedWrite(async () => {
    const file = knowledgeFileOf(category)
    const text = await readMemoryFile(dir, file)
    if (text === undefined) return
    const drop = new Set<number>()
    for (const block of blocks) {
      for (let i = block.start; i <= block.end; i += 1) drop.add(i)
    }
    const kept = text.split('\n').filter((_, i) => !drop.has(i))
    await atomicWriteFile(join(dir, file), kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n')
  })
}

/** One file's statistics for the memory report. */
export interface MemoryFileReport {
  name: string
  total: number
  /** Entries that are duplicates beyond the first kept one of a same-title group. */
  duplicates: number
  /** Superseded (`[-]`) entries still present in the file. */
  superseded: number
  /** Active entries older than the stale threshold. */
  stale: number
}

/** The composed memory report. */
export interface MemoryReport {
  files: MemoryFileReport[]
  indexLines: number
  indexBytes: number
  indexOverCap: boolean
  totalEntries: number
}

/** Audit the memory: per-file stats, duplicate groups, staleness, index pressure. */
export async function reportMemory(dir: string, maxAgeDays = 180): Promise<MemoryReport> {
  const files: MemoryFileReport[] = []
  let totalEntries = 0
  for (const file of KNOWLEDGE_FILES) {
    const text = await readMemoryFile(dir, file)
    if (text === undefined) {
      files.push({ name: file, total: 0, duplicates: 0, superseded: 0, stale: 0 })
      continue
    }
    const blocks = splitEntryBlocks(text)
    const active = blocks.filter(block => !block.superseded)
    const byTitle = new Map<string, EntryBlock[]>()
    for (const block of active) {
      const key = normalizeTitle(block.plainTitle)
      const group = byTitle.get(key) ?? []
      group.push(block)
      byTitle.set(key, group)
    }
    const duplicates = [...byTitle.values()].reduce((sum, group) => sum + Math.max(0, group.length - 1), 0)
    files.push({
      name: file,
      total: blocks.length,
      duplicates,
      superseded: blocks.length - active.length,
      stale: active.filter(block => isEntryStale(block.date, maxAgeDays)).length,
    })
    totalEntries += blocks.length
  }
  const indexText = await readMemoryFile(dir, INDEX_FILE)
  let indexLines = 0
  let indexBytes = 0
  let indexOverCap = false
  if (indexText !== undefined) {
    for (const line of indexText.split('\n')) {
      if (/^- \[.+?\]\(<[^>]+\.md>\)/.test(line.trim())) {
        indexLines += 1
        indexBytes += Buffer.byteLength(line, 'utf8')
      }
    }
    indexOverCap = indexLines > DEFAULT_MAX_INDEX_LINES || indexBytes > DEFAULT_MAX_INDEX_BYTES
  }
  return { files, indexLines, indexBytes, indexOverCap, totalEntries }
}

/** Render the audit report as model-facing text. */
export function renderMemoryReport(report: MemoryReport, maxAgeDays: number): string {
  const lines = ['📊 记忆概览（.dsh/memory/）：', '']
  for (const file of report.files) {
    const notes: string[] = [`${file.total} 条`]
    if (file.duplicates > 0) notes.push(`${file.duplicates} 条重复`)
    if (file.superseded > 0) notes.push(`${file.superseded} 条已废弃`)
    if (file.stale > 0) notes.push(`${file.stale} 条陈旧(>${maxAgeDays}天)`)
    lines.push(`- ${file.name}：${notes.join('，')}`)
  }
  lines.push('', `- 索引：${report.indexLines} 行 / ${report.indexBytes} B`
    + `（上限 ${DEFAULT_MAX_INDEX_LINES} 行 / ${DEFAULT_MAX_INDEX_BYTES} B）`
    + (report.indexOverCap ? ' ⚠️ 超限' : ' ✅'))
  if (report.totalEntries === 0) lines.push('', '（暂无记忆条目。完成后用 memory_update 写入第一条经验吧。）')
  else lines.push('', '建议：用 memory_compact apply 合并重复并归档过期废弃条目；'
    + '陈旧(>maxAgeDays)但仍有用的条目可手动精简正文。')
  return lines.join('\n')
}

/** Outcome of a compaction run. */
export interface CompactOutcome {
  /** `category: plainTitle` of merged-away duplicates (kept newest, rest archived). */
  merged: string[]
  /** `category: plainTitle` of superseded entries archived as stale. */
  archivedSuperseded: string[]
  /** Whether the pointer index was rebuilt. */
  indexRebuilt: boolean
}

/**
 * Compact the memory: merge same-title duplicate groups (keep the newest
 * entry, archive the rest), archive superseded entries older than
 * `maxAgeDays`, then rebuild the index. Nothing is hard-deleted — archived
 * blocks land in `archive.md`. The whole pass runs in the serialized-write
 * queue so it cannot interleave with concurrent appends.
 */
export function compactMemory(dir: string, maxAgeDays = 180): Promise<CompactOutcome> {
  return serializedWrite(async () => {
    const merged: string[] = []
    const archivedSuperseded: string[] = []
    for (const file of KNOWLEDGE_FILES) {
      const text = await readMemoryFile(dir, file)
      if (text === undefined) continue
      const blocks = splitEntryBlocks(text)
      const toArchive: EntryBlock[] = []
      const active = blocks.filter(block => !block.superseded)
      const byTitle = new Map<string, EntryBlock[]>()
      for (const block of active) {
        const key = normalizeTitle(block.plainTitle)
        const group = byTitle.get(key) ?? []
        group.push(block)
        byTitle.set(key, group)
      }
      for (const group of byTitle.values()) {
        if (group.length <= 1) continue
        // Stable sort: newest date last; equal dates keep file order (last wins).
        const ordered = [...group].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        const kept = ordered[ordered.length - 1]!
        for (const block of ordered.slice(0, -1)) {
          merged.push(`${file.replace('.md', '')}: ${block.plainTitle}`)
          toArchive.push(block)
        }
        void kept
      }
      const staleSuperseded = blocks
        .filter(block => block.superseded && isEntryStale(block.supersededDate || block.date, maxAgeDays))
      for (const block of staleSuperseded) {
        archivedSuperseded.push(`${file.replace('.md', '')}: ${block.plainTitle}`)
        toArchive.push(block)
      }
      if (toArchive.length === 0) continue
      await archiveEntryBlocks(dir, file.replace('.md', ''), toArchive, '记忆整理（重复合并/过期废弃）')
      await removeEntryBlocks(dir, file.replace('.md', ''), toArchive)
    }
    let indexRebuilt = false
    if (merged.length > 0 || archivedSuperseded.length > 0) {
      await rebuildIndex(dir)
      indexRebuilt = true
    }
    return { merged, archivedSuperseded, indexRebuilt }
  })
}

/** Render the compaction outcome as model-facing text. */
export function renderCompactOutcome(outcome: CompactOutcome): string {
  const lines = ['🧹 记忆整理完成：', '']
  lines.push(`- 合并重复 ${outcome.merged.length} 条（保留最新版本，其余移入 archive.md）`)
  for (const item of outcome.merged) lines.push(`  - ${item}`)
  lines.push(`- 归档过期废弃 ${outcome.archivedSuperseded.length} 条（>整理阈值，移入 archive.md）`)
  for (const item of outcome.archivedSuperseded) lines.push(`  - ${item}`)
  lines.push(`- 索引重建：${outcome.indexRebuilt ? '是' : '无需变更（无条目被移动）'}`)
  lines.push('', '归档条目保留在 archive.md 中，可手动恢复；如需永久删除请直接编辑文件。')
  return lines.join('\n')
}

// ── staged-experience confirmation flow ───────────────────────────────────

/** One parsed staged-experience entry (`- [ ] {category}: {title}[ — {body}]`). */
export interface StagedEntry {
  /** 1-based sequence number within the staging section. */
  index: number
  /** Zero-based line number within the staging section text. */
  line: number
  category: string
  title: string
  body: string
  checked: boolean
}

/** Parse the 经验暂存 section into staged entries (non-matching lines skipped). */
export function parseStagedEntries(text: string): StagedEntry[] {
  const entries: StagedEntry[] = []
  let sequence = 0
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^-\s+\[([ xX])\]\s+([a-zA-Z-]+):\s*(.+?)\s*(?:—\s*(.+))?$/.exec(lines[i]!.trim())
    if (match === null) continue
    sequence += 1
    entries.push({
      index: sequence,
      line: i,
      category: match[2]!,
      title: match[3]!.trim(),
      body: match[4]?.trim() ?? '',
      checked: match[1] !== ' ',
    })
  }
  return entries
}

/** Render staged entries as a numbered list for the model/user. */
export function renderStagedEntries(entries: StagedEntry[]): string {
  if (entries.length === 0) return '（经验暂存区为空）'
  const lines = ['📥 经验暂存区（state.md「经验暂存」），共 ' + `${entries.length} 条：`, '']
  for (const entry of entries) {
    const body = entry.body === '' ? '' : ` — ${entry.body}`
    lines.push(`${entry.index}. [${entry.checked ? 'x' : ' '}] ${entry.category}: ${entry.title}${body}`)
  }
  lines.push('', '确认归档：调用 memory_confirm，index 传 "all" 或逗号分隔编号（如 "1,3"）。')
  return lines.join('\n')
}

/**
 * Confirm staged entries: append each selected entry to its knowledge file
 * (body falls back to the title), remove the archived lines from the staging
 * section, and report what was archived. `select` is a list of 1-based
 * sequence numbers or the literal 'all'.
 */
export async function confirmStagedEntries(
  dir: string,
  select: number[] | 'all',
): Promise<{ archived: string[]; remaining: number }> {
  const sections = await readState(dir)
  const staged = sections['经验暂存'] ?? ''
  const entries = parseStagedEntries(staged)
  const wanted = new Set(select === 'all' ? entries.map(entry => entry.index) : select)
  const chosen = entries.filter(entry => wanted.has(entry.index))
  const archived: string[] = []
  for (const entry of chosen) {
    if (!isKnowledgeCategory(entry.category)) {
      archived.push(`${entry.category}: ${entry.title}（跳过：非知识分类）`)
      continue
    }
    await appendMemoryEntry(dir, entry.category, entry.title, entry.body === '' ? entry.title : entry.body)
    archived.push(`${entry.category}: ${entry.title}`)
  }
  const removeLines = new Set(chosen.map(entry => entry.line))
  const kept = staged
    .split('\n')
    .filter((_, i) => !removeLines.has(i))
    .join('\n')
    .trim()
  await updateStateSection(dir, '经验暂存', kept)
  const remaining = parseStagedEntries(kept).length
  return { archived, remaining }
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
/**
 * Turn-level injection dedup shared across ALL plugin instances in the
 * process. A profile may mount dsh-memory twice (host-plane bundle + the
 * agent-plane preset row), and the two mounts may live on different Cordis
 * roots — a per-root map would separate them and each instance would inject
 * its own digest copy (the observed ×2 in Aris sessions, ×1 in standard
 * ones). A module-level singleton is deliberately NOT keyed by root: the
 * dedup key is `agent.id`, which is unique per session, so cross-root
 * sharing cannot collide unrelated agents.
 */
const lastInjectedTurns = new Map<string, number>()

export function apply(ctx: Context, config: Config): void {
  const { maxBytes, toolsEnabled, maxIndexLines, maxIndexBytes, turnEndReminder, userMemory } = config

  // ── turn-boundary injection ──────────────────────────────────────────
  // Fold a bounded memory digest into the FIRST pre-step of each turn, right
  // after the claimed batch (agent-instructions discipline). `agent/pre-step`
  // fires once per model step and `payload.messages` only carries the messages
  // removed from the inbox for THAT step — never the whole conversation — so
  // a per-batch dedup check can never see an earlier injection. A single turn
  // (one user round) routinely spans several steps (thinking, tool calls,
  // continuations), so dedupe on `turn`: inject once at the turn's first
  // step, skip the rest, and inject again when the next turn opens with a
  // fresh digest. The dedup map is shared across plugin instances within the
  // app (host-plane bundle + agent-plane preset row), otherwise each instance
  // injects its own copy of the digest.
  ctx.on('agent/pre-step', async (
    { agent, messages, signal, turn },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (maxBytes <= 0 || decision.kind === 'reject') return decision
    signal?.throwIfAborted()
    // Turn-level dedup: this turn already received its memory digest.
    if (lastInjectedTurns.get(agent.id) === turn) return decision
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return decision
    const dir = await memoryDirOf(cwd)
    const userDir = userMemory ? userMemoryDirOf() : undefined
    const combined = await composeCombinedMemoryContext(dir, userDir, maxBytes, maxIndexLines, maxIndexBytes)
    const text = renderCombinedMemoryContext(combined.workspace, combined.user)
    if (text === '') return decision
    lastInjectedTurns.set(agent.id, turn)
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
  for (const tool of createMemoryTools(config)) {
    ctx.tools.register(tool)
  }
}

// ── model-facing tool factory (pure, testable without a Cordis context) ──

/** The subset of {@link Config} the tool factory needs. */
export interface MemoryToolConfig {
  maxBytes: number
  maxIndexLines: number
  maxIndexBytes: number
  /** User-level memory dir override (tests inject a temp dir; default ~/.dsh/memory). */
  userMemoryDir?: string
  /** Whether workspace writes register this project for cross-workspace lookup (default true). */
  crossWorkspace?: boolean
}

/** A minimal run context carrying the owning agent's session cwd. */
export interface MemoryToolExec {
  agent?: { session?: { header?: { cwd?: string } } }
}

/**
 * Build the five memory tools. Pure factory — no Cordis context — so tests
 * can exercise the real tool code paths (argument handling, supersede wiring,
 * action branching, path traversal guard) with a fake exec context.
 */
export function createMemoryTools(config: MemoryToolConfig): ToolDefinition[] {
  const { maxBytes, maxIndexLines, maxIndexBytes, crossWorkspace = true } = config
  const userDir = config.userMemoryDir ?? userMemoryDirOf()

  // ── memory_recall ─────────────────────────────────────────────────────
  const memoryRecall = defineTool({
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
      scope: {
        type: 'string',
        enum: ['workspace', 'user', 'all', 'across'],
        description: 'workspace (default): the project .dsh/memory only. '
          + 'user: the user-level ~/.dsh/memory (personal preferences, cross-project experience). '
          + 'all: both layers, user results labeled as such. '
          + 'across: search other REGISTERED workspaces (workspaces.md) — explicit '
          + 'cross-project recall, results carry a 工作区<name>/ source label; '
          + 'current workspace is excluded.',
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
    execute(args, exec: MemoryToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
      if (cwd === undefined) throw new Error('memory_recall requires an owning agent session')
      const scope = args.scope === 'user' || args.scope === 'all' || args.scope === 'across'
        ? args.scope
        : 'workspace'
      return (async () => {
        const workspaceDir = await memoryDirOf(cwd)
        if (scope === 'across') {
          const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query.trim() : undefined
          if (query !== undefined) {
            return { text: await searchAcrossWorkspaces(userDir, workspaceDir, query) }
          }
          return { text: renderWorkspaceRegistry(await listWorkspaces(userDir)) }
        }
        const dir = scope === 'user' ? userDir : workspaceDir
        const rawPath = typeof args.path === 'string' ? args.path : undefined
        if (rawPath !== undefined) {
          const safe = normalizeMemoryPath(rawPath)
          if (scope === 'all') {
            const ws = await readMemoryFile(workspaceDir, safe)
            if (ws !== undefined) return { text: ws }
            const us = await readMemoryFile(userDir, safe)
            return { text: us ?? `（无此文件：${safe}）` }
          }
          const text = await readMemoryFile(dir, safe)
          return { text: text ?? `（无此文件：${safe}）` }
        }
        const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query.trim() : undefined
        if (query !== undefined) {
          if (scope === 'all') {
            const ws = await searchMemory(workspaceDir, query)
            const us = await searchMemory(userDir, query, '用户级/')
            const parts = [ws, us].filter(text => !text.startsWith('（无匹配'))
            if (parts.length > 0) return { text: parts.join('\n\n') }
            return { text: `（无匹配：${query}）` }
          }
          return { text: await searchMemory(dir, query) }
        }
        const category = typeof args.category === 'string' ? args.category : undefined
        if (category !== undefined) {
          if (scope === 'all') {
            const file = category === 'state' ? STATE_FILE : `${category}.md`
            const ws = await readMemoryFile(workspaceDir, file)
            const us = category === 'state' ? undefined : await readMemoryFile(userDir, `${category}.md`)
            const parts: string[] = []
            if (ws !== undefined) parts.push(ws)
            if (us !== undefined) parts.push(`（来自用户级记忆）\n\n${us}`)
            return { text: parts.length > 0 ? parts.join('\n\n') : '（该分类暂无条目）' }
          }
          const file = category === 'state' ? STATE_FILE : `${category}.md`
          const text = await readMemoryFile(dir, file)
          return { text: text ?? '（该分类暂无条目）' }
        }
        if (scope === 'all') {
          const ws = await composeMemoryContext(workspaceDir, maxBytes, maxIndexLines, maxIndexBytes)
          const us = await composeMemoryContext(userDir, maxBytes, maxIndexLines, maxIndexBytes)
          return { text: renderCombinedMemoryContext(ws, us) || '（暂无记忆）' }
        }
        const context = await composeMemoryContext(dir, maxBytes, maxIndexLines, maxIndexBytes)
        return { text: renderMemoryContext(context) || '（暂无记忆）' }
      })()
    },
    presentCall: args => ({ card: 'generic', title: 'Recall workspace memory', kind: 'other', rawInput: args }),
  })

  // ── memory_update ─────────────────────────────────────────────────────
  const memoryUpdate = defineTool({
    name: 'memory_update',
    description:
      'Persist an experience entry into a knowledge file of the workspace memory (.dsh/memory). '
      + 'Category decides the file: decisions (architecture decisions), patterns (code patterns), '
      + 'troubleshooting (debugging experience), user (user preferences). '
      + 'Use after completing non-trivial work so the knowledge survives the session; '
      + 'the pointer index is rebuilt automatically. Only record information that is not '
      + 'derivable from code or git history. Pass supersede (an existing title in the same '
      + 'category) to mark the old entry as superseded instead of duplicating it.',
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
      supersede: {
        type: 'string',
        description: 'Optional: exact title of an existing entry in the same category to mark '
          + 'as superseded (deprecated) before appending the new one. Match is by normalized title.',
      },
      scope: {
        type: 'string',
        enum: ['workspace', 'user'],
        description: 'workspace (default): write to the project .dsh/memory. '
          + 'user: write to the user-level ~/.dsh/memory — personal preferences and '
          + 'cross-project experience only; never project-specific knowledge.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          file: { type: 'string', required: true },
          superseded: { type: 'array', items: { type: 'string' }, required: true },
          duplicates: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => {
        const parts = [`已写入 ${value.file}`]
        if (value.superseded.length > 0) parts.push(`已废弃旧条目：${value.superseded.join('、')}`)
        if (value.duplicates.length > 0) {
          parts.push(`⚠️ 同标题已有条目：${value.duplicates.join('、')}（如需替换请用 supersede 参数重写）`)
        }
        return [{ type: 'text', text: parts.join('；') }]
      },
    },
    execute(args, exec: MemoryToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
      if (cwd === undefined) throw new Error('memory_update requires an owning agent session')
      const category = typeof args.category === 'string' ? args.category : ''
      const title = typeof args.title === 'string' ? args.title : ''
      const body = typeof args.body === 'string' ? args.body : ''
      const supersede = typeof args.supersede === 'string' && args.supersede.trim() !== ''
        ? args.supersede.trim()
        : undefined
      if (category === '' || title === '' || body === '') {
        throw new Error('memory_update 需要 category / title / body 均为字符串')
      }
      return (async () => {
        const scope = args.scope === 'user' ? 'user' : 'workspace'
        const dir = scope === 'user' ? userDir : await memoryDirOf(cwd)
        const superseded = supersede === undefined
          ? []
          : await supersedeEntry(dir, category, supersede, title)
        const duplicates = await findDuplicateTitles(dir, category, title)
        await appendMemoryEntry(dir, category, title, body)
        // A successful workspace write registers this project in the
        // cross-workspace registry (L3), unless the flag is off (sensitive).
        if (scope === 'workspace' && crossWorkspace) {
          await registerWorkspace(userDir, dir)
        }
        return { ok: true, file: `${category}.md`, superseded, duplicates }
      })()
    },
    presentCall: args => ({ card: 'generic', title: 'Update workspace memory', kind: 'other', rawInput: args }),
  })

  // ── memory_state ──────────────────────────────────────────────────────
  const memoryState = defineTool({
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
    execute(args, exec: MemoryToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
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
  })

  // ── memory_compact ────────────────────────────────────────────────────
  const memoryCompact = defineTool({
    name: 'memory_compact',
    description:
      'Audit and tidy the workspace memory (.dsh/memory). With action=report (default), '
      + 'returns per-file entry statistics (totals, duplicate groups, superseded entries, '
      + 'stale entries older than maxAgeDays) plus index pressure. With action=apply, merges '
      + 'same-title duplicate entries (keeping the newest), archives superseded entries older '
      + 'than maxAgeDays into archive.md, and rebuilds the pointer index. Archiving is '
      + 'reversible — nothing is hard-deleted. Run report first, then apply when cleanup is warranted.',
    parameters: {
      action: {
        type: 'string',
        enum: ['report', 'apply'],
        description: 'report (default) audits only; apply performs the tidy-up.',
      },
      maxAgeDays: {
        type: 'number',
        description: 'Staleness threshold for superseded-entry archiving (default 180).',
      },
      scope: {
        type: 'string',
        enum: ['workspace', 'user'],
        description: 'workspace (default): audit/tidy the project .dsh/memory. '
          + 'user: audit/tidy the user-level ~/.dsh/memory.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          applied: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec: MemoryToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
      if (cwd === undefined) throw new Error('memory_compact requires an owning agent session')
      const action = args.action === 'apply' ? 'apply' : 'report'
      // Note: 0 is a legitimate threshold ("archive everything now"); only
      // non-finite or negative values fall back to the 180-day default.
      const maxAgeDays = typeof args.maxAgeDays === 'number' && Number.isFinite(args.maxAgeDays)
        ? Math.max(0, Math.floor(args.maxAgeDays))
        : 180
      return (async () => {
        const scope = args.scope === 'user' ? 'user' : 'workspace'
        const dir = scope === 'user' ? userDir : await memoryDirOf(cwd)
        const prefix = scope === 'user' ? '（作用域：用户级记忆 ~/.dsh/memory/）\n\n' : ''
        if (action === 'apply') {
          const outcome = await compactMemory(dir, maxAgeDays)
          return { text: prefix + renderCompactOutcome(outcome), applied: true }
        }
        const report = await reportMemory(dir, maxAgeDays)
        return { text: prefix + renderMemoryReport(report, maxAgeDays), applied: false }
      })()
    },
    presentCall: args => ({ card: 'generic', title: 'Compact workspace memory', kind: 'other', rawInput: args }),
  })

  // ── memory_confirm ─────────────────────────────────────────────────────
  const memoryConfirm = defineTool({
    name: 'memory_confirm',
    description:
      'List or confirm staged-experience entries in state.md (经验暂存). With no index, '
      + 'lists staged entries with sequence numbers. Pass index="all" or a comma-separated '
      + 'list (e.g. "1,3") to archive the selected entries into their knowledge files '
      + '(decisions/patterns/troubleshooting/user, body falls back to the title) and remove '
      + 'them from the staging area. Run after the user confirms the staged experience.',
    parameters: {
      index: {
        type: 'string',
        description: 'Omit to list; "all" or comma-separated 1-based numbers (e.g. "1,3") to confirm.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          archived: { type: 'array', items: { type: 'string' }, required: true },
          remaining: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec: MemoryToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
      if (cwd === undefined) throw new Error('memory_confirm requires an owning agent session')
      const indexArg = typeof args.index === 'string' ? args.index.trim() : ''
      return (async () => {
        const dir = await memoryDirOf(cwd)
        const sections = await readState(dir)
        const staged = sections['经验暂存'] ?? ''
        const entries = parseStagedEntries(staged)
        if (indexArg === '') {
          return { text: renderStagedEntries(entries), archived: [], remaining: entries.length }
        }
        const select: number[] | 'all' = indexArg === 'all'
          ? 'all'
          : indexArg.split(',').map(part => Number.parseInt(part.trim(), 10))
            .filter(number => Number.isFinite(number) && number > 0)
        if (select !== 'all' && select.length === 0) {
          return { text: '（未选择有效条目编号）\n\n' + renderStagedEntries(entries), archived: [], remaining: entries.length }
        }
        const result = await confirmStagedEntries(dir, select)
        const lines = ['✅ 经验归档完成：']
        for (const item of result.archived) lines.push(`- ${item}`)
        lines.push('', `暂存区剩余 ${result.remaining} 条。`)
        return { text: lines.join('\n'), archived: result.archived, remaining: result.remaining }
      })()
    },
    presentCall: args => ({ card: 'generic', title: 'Confirm staged memory', kind: 'other', rawInput: args }),
  })

  return [memoryRecall, memoryUpdate, memoryState, memoryCompact, memoryConfirm]
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
