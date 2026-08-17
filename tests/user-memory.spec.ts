// @vitest-environment node
/** dsh-memory L2: user-level memory layer (~/.dsh/memory) — combined injection, scope tools. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  composeCombinedMemoryContext,
  createMemoryTools,
  renderCombinedMemoryContext,
  userMemoryDirOf,
  type MemoryToolExec,
} from '../src/index.ts'

let workspace: string
let wsMemory: string
let userDir: string
let exec: MemoryToolExec

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-memory-l2-'))
  workspace = join(base, 'workspace')
  wsMemory = join(workspace, '.dsh', 'memory')
  userDir = join(base, 'user')
  await mkdir(workspace, { recursive: true })
  await mkdir(userDir, { recursive: true })
  exec = { agent: { session: { header: { cwd: workspace } } } }
})

afterEach(async () => {
  await rm(join(workspace, '..'), { recursive: true, force: true })
})

const tools = (): Record<string, ReturnType<typeof createMemoryTools>[number]> => {
  const list = createMemoryTools({ maxBytes: 8192, maxIndexLines: 200, maxIndexBytes: 25_000, userMemoryDir: userDir })
  return Object.fromEntries(list.map(tool => [tool.name, tool]))
}

const run = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const tool = tools()[name]
  expect(tool, `tool ${name} exists`).toBeDefined()
  return await (tool!.execute as any)(args, exec)
}

describe('userMemoryDirOf', () => {
  it('resolves to the user home .dsh/memory directory', () => {
    const dir = userMemoryDirOf()
    expect(dir.endsWith(join('.dsh', 'memory'))).toBe(true)
    expect(dir).not.toContain('workspace')
  })
})

describe('composeCombinedMemoryContext', () => {
  it('composes workspace (~70% budget) and user (~30%) layers', async () => {
    await run('memory_update', { category: 'patterns', title: '工作区模式', body: '项目专用。' })
    await run('memory_update', { category: 'user', title: '偏好', body: '简洁回答。', scope: 'user' })

    const combined = await composeCombinedMemoryContext(wsMemory, userDir, 8192)
    expect(combined.workspace.index.some(row => row.file === 'patterns.md')).toBe(true)
    expect(combined.workspace.budget).toBe(Math.floor(8192 * 0.7))
    expect(combined.user!.index.some(row => row.file === 'user.md')).toBe(true)
    expect(combined.user!.budget).toBe(8192 - Math.floor(8192 * 0.7))
  })

  it('returns no user layer when userDir is undefined (userMemory: false)', async () => {
    const combined = await composeCombinedMemoryContext(wsMemory, undefined, 8192)
    expect(combined.user).toBeUndefined()
    expect(combined.workspace.budget).toBe(Math.floor(8192 * 0.7))
  })
})

describe('renderCombinedMemoryContext', () => {
  it('labels the two layers distinctly and renders the discipline once', async () => {
    await run('memory_update', { category: 'patterns', title: '工作区模式', body: '项目专用。' })
    await run('memory_update', { category: 'user', title: '偏好', body: '简洁回答。', scope: 'user' })
    const combined = await composeCombinedMemoryContext(wsMemory, userDir, 8192)
    const text = renderCombinedMemoryContext(combined.workspace, combined.user)

    expect(text).toContain('以下为本工作区记忆索引')
    expect(text).toContain('以下为用户级记忆索引')
    expect(text).toContain('工作区模式')
    expect(text).toContain('偏好')
    // discipline footer appears exactly once
    expect(text.match(/记忆纪律/g)).toHaveLength(1)
  })

  it('returns empty when both layers are empty', () => {
    const context = { index: [], indexOverCap: false, budget: 8192 }
    expect(renderCombinedMemoryContext(context, context)).toBe('')
  })
})

describe('memory_update scope', () => {
  it('writes to the user layer with scope=user', async () => {
    const result = await run('memory_update', { category: 'user', title: '偏好', body: '简洁回答。', scope: 'user' })
    expect(result).toMatchObject({ ok: true, file: 'user.md' })
    const userFile = await readFile(join(userDir, 'user.md'), 'utf8')
    expect(userFile).toContain('## [+] 偏好')
    // workspace untouched
    const wsFile = join(workspace, '.dsh', 'memory', 'user.md')
    await expect(readFile(wsFile, 'utf8')).rejects.toThrow()
  })

  it('defaults to workspace and does not touch the user layer', async () => {
    await run('memory_update', { category: 'user', title: '偏好', body: '项目内偏好。' })
    const wsFile = await readFile(join(workspace, '.dsh', 'memory', 'user.md'), 'utf8')
    expect(wsFile).toContain('项目内偏好')
    await expect(readFile(join(userDir, 'user.md'), 'utf8')).rejects.toThrow()
  })

  it('supports supersede inside the user layer', async () => {
    await run('memory_update', { category: 'patterns', title: '通用模式', body: 'v1。', scope: 'user' })
    const result = await run('memory_update', {
      category: 'patterns',
      title: '通用模式 v2',
      body: 'v2。',
      supersede: '通用模式',
      scope: 'user',
    })
    expect(result.superseded).toEqual(['通用模式'])
    const userFile = await readFile(join(userDir, 'patterns.md'), 'utf8')
    expect(userFile).toContain('## [-] 通用模式')
  })
})

describe('memory_recall scope', () => {
  beforeEach(async () => {
    await run('memory_update', { category: 'patterns', title: '工作区模式', body: '项目专用。' })
    await run('memory_update', { category: 'patterns', title: '通用模式', body: '跨项目。', scope: 'user' })
  })

  it('scope=user reads only the user layer', async () => {
    const result = await run('memory_recall', { scope: 'user', category: 'patterns' })
    expect(result.text).toContain('通用模式')
    expect(result.text).not.toContain('工作区模式')
  })

  it('scope=all merges the two index digests with distinct headers', async () => {
    const result = await run('memory_recall', { scope: 'all' })
    expect(result.text).toContain('本工作区记忆索引')
    expect(result.text).toContain('用户级记忆索引')
    expect(result.text).toContain('工作区模式')
    expect(result.text).toContain('通用模式')
  })

  it('scope=all merges query hits with a user label', async () => {
    const result = await run('memory_recall', { scope: 'all', query: '通用' })
    expect(result.text).toContain('### 用户级/patterns.md')
    expect(result.text).toContain('通用模式')
  })

  it('scope=all merges category reads with a source note', async () => {
    const result = await run('memory_recall', { scope: 'all', category: 'patterns' })
    expect(result.text).toContain('来自用户级记忆')
    expect(result.text).toContain('通用模式')
  })

  it('scope=all falls back to the user layer for a raw path', async () => {
    const result = await run('memory_recall', { scope: 'all', path: 'patterns.md' })
    // workspace wins when present
    expect(result.text).toContain('工作区模式')
    const onlyUser = await run('memory_recall', { scope: 'all', path: 'troubleshooting.md' })
    expect(onlyUser.text).toBe('（无此文件：troubleshooting.md）')
  })

  it('default scope (workspace) is unchanged', async () => {
    const result = await run('memory_recall', { query: '通用' })
    expect(result.text).toBe('（无匹配：通用）')
  })

  it('no-argument recall returns the combined digest (workspace + user)', async () => {
    const result = await run('memory_recall', {})
    expect(result.text).toContain('本工作区记忆索引')
    expect(result.text).toContain('用户级记忆索引')
    expect(result.text).toContain('工作区模式')
    expect(result.text).toContain('通用模式')
  })

  it('explicit scope=workspace with no args stays single-layer', async () => {
    const result = await run('memory_recall', { scope: 'workspace' })
    expect(result.text).toContain('本工作区记忆索引')
    expect(result.text).not.toContain('用户级记忆索引')
  })
})

describe('memory_compact scope', () => {
  it('reports and applies on the user layer', async () => {
    await run('memory_update', { category: 'patterns', title: '重复', body: 'a', scope: 'user' })
    await run('memory_update', { category: 'patterns', title: '重复', body: 'b（最新）', scope: 'user' })

    const report = await run('memory_compact', { scope: 'user' })
    expect(report.applied).toBe(false)
    expect(report.text).toContain('作用域：用户级记忆')
    expect(report.text).toContain('1 条重复')

    const applied = await run('memory_compact', { scope: 'user', action: 'apply', maxAgeDays: 0 })
    expect(applied.applied).toBe(true)
    const archive = await readFile(join(userDir, 'archive.md'), 'utf8')
    expect(archive).toContain('[archived] 重复')
  })

  it('does not touch the workspace layer', async () => {
    await run('memory_update', { category: 'patterns', title: '工作区重复', body: 'x' })
    await run('memory_compact', { scope: 'user', action: 'apply', maxAgeDays: 0 })
    const wsFile = await readFile(join(workspace, '.dsh', 'memory', 'patterns.md'), 'utf8')
    expect(wsFile).toContain('## [+] 工作区重复')
  })
})
