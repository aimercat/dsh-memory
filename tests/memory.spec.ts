// @vitest-environment node
/** dsh-memory core: memory dir resolution, context composition, entry append, index rebuild. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendMemoryEntry,
  composeMemoryContext,
  memoryDirOf,
  rebuildIndex,
  renderMemoryContext,
} from '../src/index.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('memoryDirOf', () => {
  it('resolves to {projectRoot}/.dsh/memory by walking up to .git', async () => {
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(root, 'src', 'deep'), { recursive: true })
    const dir = await memoryDirOf(join(root, 'src', 'deep'))
    expect(dir).toBe(join(root, '.dsh', 'memory'))
  })

  it('falls back to the cwd itself when no .git exists above', async () => {
    const dir = await memoryDirOf(root)
    expect(dir).toBe(join(root, '.dsh', 'memory'))
  })
})

describe('appendMemoryEntry + rebuildIndex', () => {
  it('appends a dated entry and rebuilds the index', async () => {
    const dir = await memoryDirOf(root)
    await appendMemoryEntry(dir, 'decisions', 'OAuth2 方案', '选用 refresh token 轮换。')
    const decisions = await readFile(join(dir, 'decisions.md'), 'utf8')
    expect(decisions).toContain('## [+] OAuth2 方案 (')
    expect(decisions).toContain('选用 refresh token 轮换。')
    const index = await readFile(join(dir, 'index.md'), 'utf8')
    expect(index).toContain('`decisions.md`')
    expect(index).toContain('OAuth2 方案')
  })

  it('rebuildIndex summarizes files without entries as empty', async () => {
    const dir = await memoryDirOf(root)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'patterns.md'), '# patterns\n\n无条目\n', 'utf8')
    await rebuildIndex(dir)
    const index = await readFile(join(dir, 'index.md'), 'utf8')
    expect(index).toContain('（暂无条目）')
  })
})

describe('composeMemoryContext', () => {
  it('reads the index digest and truncates last.md to half the budget', async () => {
    const dir = await memoryDirOf(root)
    await appendMemoryEntry(dir, 'decisions', '方案 A', '内容')
    await writeFile(join(dir, 'last.md'), 'x'.repeat(2000), 'utf8')
    const context = await composeMemoryContext(dir, 1000)
    expect(context.index.some(row => row.file === 'decisions.md')).toBe(true)
    expect(context.last!.length).toBeLessThanOrEqual(600)
  })

  it('derives per-file summaries when no index exists yet', async () => {
    const dir = await memoryDirOf(root)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'decisions.md'), '# decisions\n\n## [+] 决策 (2026-01-01)\n内容\n', 'utf8')
    const context = await composeMemoryContext(dir, 8192)
    expect(context.index).toEqual([{ file: 'decisions.md', summary: 'decisions' }])
  })
})

describe('renderMemoryContext', () => {
  it('renders index rows and the last-state block', () => {
    const text = renderMemoryContext({
      index: [{ file: 'decisions.md', summary: '方案 A' }],
      last: '上次在 stage-02。',
      budget: 8192,
    })
    expect(text).toContain('decisions.md')
    expect(text).toContain('上次会话结束状态')
    expect(text).toContain('memory_recall')
  })

  it('returns empty text for an empty context', () => {
    expect(renderMemoryContext({ index: [], budget: 8192 })).toBe('')
  })
})

