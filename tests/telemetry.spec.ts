// @vitest-environment node
/** dsh-memory v1.1 P0.5: recall hit telemetry — stats.json recording and reporting. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendMemoryEntry,
  createMemoryTools,
  degradeStagedEntries,
  ignoreStagedEntries,
  readStats,
  recordEntryHit,
  renderTelemetrySummary,
  searchMemory,
  updateStateSection,
  type MemoryToolExec,
} from '../src/index.ts'

let root: string
let memoryDir: string
let exec: MemoryToolExec

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-tele-'))
  memoryDir = join(root, '.dsh', 'memory')
  exec = { agent: { session: { header: { cwd: root } } } }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const run = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const list = createMemoryTools({ maxBytes: 8192, maxIndexLines: 200, maxIndexBytes: 25_000, userMemoryDir: join(root, 'user') })
  const tool = list.find(t => t.name === name)!
  return await (tool.execute as any)(args, exec)
}

describe('recordEntryHit / readStats', () => {
  it('accumulates hits with channel separation and lastHit', async () => {
    await recordEntryHit(memoryDir, 'patterns.md', '状态机', 'grep')
    await recordEntryHit(memoryDir, 'patterns.md', '状态机', 'grep')
    await recordEntryHit(memoryDir, 'patterns.md', '状态机', 'fuzzy')
    const stats = await readStats(memoryDir)
    const entry = stats.entries['patterns.md|状态机']!
    expect(entry.hits).toBe(3)
    expect(entry.channels.grep).toBe(2)
    expect(entry.channels.fuzzy).toBe(1)
    expect(entry.lastHit).toBeTypeOf('string')
  })

  it('persists to stats.json and tolerates a corrupted file', async () => {
    await recordEntryHit(memoryDir, 'user.md', '偏好', 'grep')
    const raw = JSON.parse(await readFile(join(memoryDir, 'stats.json'), 'utf8'))
    expect(raw.entries['user.md|偏好'].hits).toBe(1)

    await writeFile(join(memoryDir, 'stats.json'), '{broken json', 'utf8')
    const stats = await readStats(memoryDir)
    expect(stats.entries).toEqual({})
  })
})

describe('searchMemory telemetry', () => {
  it('records grep-channel hits for the owning entry', async () => {
    await appendMemoryEntry(memoryDir, 'patterns', '状态机', '用 Switch + Enum 表达')
    await searchMemory(memoryDir, 'Switch')
    const stats = await readStats(memoryDir)
    expect(stats.entries['patterns.md|状态机']?.channels.grep).toBe(1)
  })

  it('records suggest-channel hits for fuzzy candidates', async () => {
    await appendMemoryEntry(memoryDir, 'patterns', '状态机', '用状态表表达状态转移')
    await searchMemory(memoryDir, 'state table 状态转移') // 精确 miss → fuzzy 命中
    const stats = await readStats(memoryDir)
    expect(stats.entries['patterns.md|状态机']?.channels.suggest).toBeGreaterThan(0)
  })

  it('does not record hits for index/state/archive files', async () => {
    await appendMemoryEntry(memoryDir, 'user', '偏好', '简洁回答')
    await searchMemory(memoryDir, '简洁回答')
    const stats = await readStats(memoryDir)
    // 只有知识条目被记录；index.md 等不算
    expect(stats.entries['user.md|偏好']?.channels.grep).toBe(1)
  })

  it('records across-channel hits through cross-workspace search', async () => {
    // 模拟注册表：另一工作区 w2
    const w2 = join(root, 'w2', '.dsh', 'memory')
    await appendMemoryEntry(w2, 'decisions', '远程方案', 'ssh tunnel 转发')
    const list = createMemoryTools({
      maxBytes: 8192,
      maxIndexLines: 200,
      maxIndexBytes: 25_000,
      userMemoryDir: memoryDir, // 用 memoryDir 作为"用户级"承载注册表
    })
    const recall = list.find(t => t.name === 'memory_recall')!
    // 注册 w2 到注册表（直接写 workspaces.md 简化：用 registerWorkspace）
    const { registerWorkspace } = await import('../src/index.ts')
    await registerWorkspace(memoryDir, w2)
    const result = await (recall.execute as any)({ scope: 'across', query: 'ssh tunnel' }, exec)
    expect(result.text).toContain('ssh tunnel 转发') // grep 返回命中行
    const stats = await readStats(w2)
    expect(stats.entries['decisions.md|远程方案']?.channels.across).toBeGreaterThan(0)
  })
})

describe('ignore/degrade telemetry', () => {
  it('records the reason code on ignore', async () => {
    await updateStateSection(memoryDir, '经验暂存', '- [ ] patterns: 误记 — 内容')
    await ignoreStagedEntries(memoryDir, [1], 'duplicate')
    const stats = await readStats(memoryDir)
    expect(stats.ignored.duplicate).toBe(1)
  })

  it('records unconfirmed-3x on auto-degrade', async () => {
    await updateStateSection(memoryDir, '经验暂存', '- [ ] decisions: 老候选 — 内容 [⏳3]')
    await degradeStagedEntries(memoryDir, 3)
    const stats = await readStats(memoryDir)
    expect(stats.ignored['unconfirmed-3x']).toBe(1)
  })
})

describe('renderTelemetrySummary', () => {
  it('reports zero-hit entries, top hits and ignore distribution', async () => {
    const stats = await readStats(memoryDir)
    stats.entries['patterns.md|热门条目'] = { hits: 5, lastHit: '2026-08-19T00:00:00.000Z', channels: { grep: 5 } }
    stats.entries['troubleshooting.md|冷门条目'] = { hits: 0, lastHit: '', channels: {} }
    stats.ignored.duplicate = 2
    const text = renderTelemetrySummary(stats).join('\n')
    expect(text).toContain('命中统计')
    expect(text).toContain('热门条目(5次)')
    expect(text).toContain('从未被命中的条目 1 条')
    expect(text).toContain('冷门条目')
    expect(text).toContain('duplicate:2')
  })
})

describe('memory_compact report integration', () => {
  it('includes the telemetry section in the report', async () => {
    await appendMemoryEntry(memoryDir, 'patterns', '状态机', 'Switch + Enum')
    await run('memory_recall', { query: 'Switch' })
    const result = await run('memory_compact', {})
    expect(result.text).toContain('命中统计')
    expect(result.text).toContain('状态机')
  })
})
