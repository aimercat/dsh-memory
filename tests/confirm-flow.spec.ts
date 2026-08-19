// @vitest-environment node
/** dsh-memory v1.1 P0: inline confirmation flow — exposure window, strikes, ignore, degrade. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  bumpStagedStrikes,
  confirmStagedEntries,
  createMemoryTools,
  degradeStagedEntries,
  exposureWindow,
  ignoreStagedEntries,
  parseStagedEntries,
  renderStagedEntries,
  updateStateSection,
  type MemoryToolExec,
} from '../src/index.ts'

let root: string
let memoryDir: string
let exec: MemoryToolExec

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-confirm-'))
  memoryDir = join(root, '.dsh', 'memory') // memoryDirOf(root) 的解析结果，工具层测试与其一致
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

describe('parseStagedEntries: strike marker', () => {
  it('strips the [⏳N] marker into the strikes field', () => {
    const entries = parseStagedEntries('- [ ] decisions: OAuth2 — 选用 refresh token [⏳2]')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ title: 'OAuth2', body: '选用 refresh token', strikes: 2 })
  })

  it('defaults strikes to 0 for legacy lines without the marker', () => {
    const entries = parseStagedEntries('- [ ] patterns: 状态机 — 用 Switch+Enum')
    expect(entries[0]!.strikes).toBe(0)
    expect(entries[0]!.body).toBe('用 Switch+Enum')
  })
})

describe('exposureWindow', () => {
  it('prioritizes decisions/troubleshooting over patterns, then staging order', () => {
    const entries = parseStagedEntries([
      '- [ ] user: 偏好 — 简洁回答',
      '- [ ] patterns: 模式 — 内容',
      '- [ ] decisions: 决策 — 内容',
      '- [ ] troubleshooting: 排障 — 内容',
    ].join('\n'))
    const window = exposureWindow(entries)
    expect(window.map(e => e.category)).toEqual(['decisions', 'troubleshooting', 'patterns'])
    expect(window).toHaveLength(3)
  })

  it('backlog entries stay outside the window', () => {
    const entries = parseStagedEntries(Array.from({ length: 5 }, (_, i) => `- [ ] patterns: 条目${i} — 内容`).join('\n'))
    const window = exposureWindow(entries)
    expect(window).toHaveLength(3)
    expect(entries.length - window.length).toBe(2)
  })
})

describe('renderStagedEntries: exposure window view', () => {
  it('shows only the window with strike count and backlog note', async () => {
    await updateStateSection(memoryDir, '经验暂存', [
      '- [ ] patterns: 积压1 — 内容',
      '- [ ] patterns: 积压2 — 内容',
      '- [ ] patterns: 积压3 — 内容',
      '- [ ] patterns: 积压4 — 内容',
      '- [ ] decisions: 高价值 — 内容 [⏳1]',
    ].join('\n'))
    const sections = await (await import('../src/index.ts')).readState(memoryDir)
    const entries = parseStagedEntries(sections['经验暂存'] ?? '')
    const text = renderStagedEntries(entries)
    expect(text).toContain('decisions: 高价值')
    expect(text).toContain('（第 1 次提醒）')
    expect(text).toContain('另有 2 条积压候选')
    expect(text).toContain('action=ignore')
    // 积压条目不展示
    expect(text).not.toContain('积压4')
  })
})

describe('bumpStagedStrikes', () => {
  it('bumps only exposure-window candidates once per call', async () => {
    await updateStateSection(memoryDir, '经验暂存', [
      '- [ ] decisions: 决策 — 内容',
      '- [ ] patterns: 积压 — 内容',
      '- [ ] patterns: 积压2 — 内容',
      '- [ ] patterns: 积压3 — 内容',
    ].join('\n'))
    await bumpStagedStrikes(memoryDir)
    await bumpStagedStrikes(memoryDir)
    const sections = await (await import('../src/index.ts')).readState(memoryDir)
    const staged = sections['经验暂存'] ?? ''
    // 窗口内 3 条（decisions + 前两条 patterns）各计 2 次
    expect(staged).toContain('- [ ] decisions: 决策 — 内容 [⏳2]')
    expect(staged.match(/\[⏳\d+\]/g)).toHaveLength(3)
    // 窗口外积压（第 4 条）不计数
    expect(staged).toContain('- [ ] patterns: 积压3 — 内容\n')
    const parsed = parseStagedEntries(staged)
    expect(parsed.find(e => e.title === '决策')!.strikes).toBe(2)
    expect(parsed.find(e => e.title === '积压3')!.strikes).toBe(0)
  })

  it('is a no-op on an empty staging area', async () => {
    await bumpStagedStrikes(memoryDir) // 不抛错
    expect(true).toBe(true)
  })
})

describe('degradeStagedEntries', () => {
  it('moves past-limit candidates to archive with [ignored-3x] and clears staging', async () => {
    await updateStateSection(memoryDir, '经验暂存', '- [ ] decisions: 老候选 — 内容 [⏳3]')
    const result = await degradeStagedEntries(memoryDir, 3)
    expect(result.degraded).toEqual(['decisions: 老候选'])

    const archive = await readFile(join(memoryDir, 'archive.md'), 'utf8')
    expect(archive).toContain('[ignored-3x] decisions: 老候选')
    expect(archive).toContain('连续 3 次未确认降级')

    const sections = await (await import('../src/index.ts')).readState(memoryDir)
    expect(sections['经验暂存'] ?? '').toBe('')
  })

  it('keeps candidates below the limit', async () => {
    await updateStateSection(memoryDir, '经验暂存', '- [ ] decisions: 新候选 — 内容 [⏳2]')
    const result = await degradeStagedEntries(memoryDir, 3)
    expect(result.degraded).toEqual([])
  })
})

describe('ignoreStagedEntries', () => {
  it('discards into archive with reasonCode and reason, never into the knowledge base', async () => {
    await updateStateSection(memoryDir, '经验暂存', '- [ ] patterns: 误记 — 内容')
    const result = await ignoreStagedEntries(memoryDir, [1], 'duplicate', '与已有条目重复')
    expect(result.ignored).toEqual(['patterns: 误记'])
    expect(result.remaining).toBe(0)

    const archive = await readFile(join(memoryDir, 'archive.md'), 'utf8')
    expect(archive).toContain('[ignored] patterns: 误记')
    expect(archive).toContain('[duplicate] 与已有条目重复')

    // 知识库无此条目（patterns.md 从未创建过则视为空）
    const patterns = await readFile(join(memoryDir, 'patterns.md'), 'utf8').catch(() => '')
    expect(patterns).not.toContain('误记')
  })
})

describe('memory_confirm tool: action branch', () => {
  it('confirms by default', async () => {
    await updateStateSection(memoryDir, '经验暂存', '- [ ] decisions: 决策 — 内容')
    const result = await run('memory_confirm', { index: 'all' })
    expect(result.archived).toEqual(['decisions: 决策'])
  })

  it('ignores with reasonCode', async () => {
    await updateStateSection(memoryDir, '经验暂存', '- [ ] patterns: 误记 — 内容')
    const result = await run('memory_confirm', { index: '1', action: 'ignore', reasonCode: 'low-value' })
    expect(result.archived).toEqual(['patterns: 误记'])
    const archive = await readFile(join(memoryDir, 'archive.md'), 'utf8')
    expect(archive).toContain('[low-value]')
  })

  it('lists the exposure window with no index', async () => {
    await updateStateSection(memoryDir, '经验暂存', [
      '- [ ] patterns: 积压 — 内容',
      '- [ ] decisions: 决策 — 内容 [⏳1]',
    ].join('\n'))
    const result = await run('memory_confirm', {})
    expect(result.text).toContain('decisions: 决策')
    expect(result.text).toContain('第 1 次提醒')
  })
})

describe('full inline flow', () => {
  it('stage → expose → ignore → window refill', async () => {
    // 4 条暂存：窗口 top3 = decisions + troubleshooting + patterns（积压 1 条）
    await updateStateSection(memoryDir, '经验暂存', [
      '- [ ] patterns: 积压 — 内容',
      '- [ ] decisions: 决策A — 内容',
      '- [ ] troubleshooting: 排障B — 内容',
      '- [ ] patterns: 积压2 — 内容',
    ].join('\n'))

    // 暴露一次（窗口 3 条 +1）
    await bumpStagedStrikes(memoryDir)
    let sections = await (await import('../src/index.ts')).readState(memoryDir)
    let staged = sections['经验暂存'] ?? ''
    expect(staged).toContain('决策A — 内容 [⏳1]')
    expect(staged).not.toContain('积压2 [⏳') // 积压不计数

    // 忽略窗口内第一条（patterns 积压，index 1）→ 积压2 补位进窗口
    const ignored = await ignoreStagedEntries(memoryDir, [1], 'wrong-scope')
    expect(ignored.remaining).toBe(3)
    sections = await (await import('../src/index.ts')).readState(memoryDir)
    staged = sections['经验暂存'] ?? ''
    // 积压2 补位进窗口（patterns 类），下次 bump 会计数
    expect(staged).toContain('积压2')
    await bumpStagedStrikes(memoryDir)
    sections = await (await import('../src/index.ts')).readState(memoryDir)
    expect(sections['经验暂存'] ?? '').toContain('积压2 — 内容 [⏳1]')

    // 确认剩余全部
    const confirmed = await confirmStagedEntries(memoryDir, 'all')
    expect(confirmed.remaining).toBe(0)
    const decisions = await readFile(join(memoryDir, 'decisions.md'), 'utf8')
    expect(decisions).toContain('## [+] 决策A')
  })
})
