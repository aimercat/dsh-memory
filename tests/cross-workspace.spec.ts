// @vitest-environment node
/** dsh-memory L3: cross-workspace lookup — explicit opt-in recall with source labels. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createMemoryTools,
  listWorkspaces,
  registerWorkspace,
  renderWorkspaceRegistry,
  searchAcrossWorkspaces,
  WORKSPACES_FILE,
  type MemoryToolExec,
} from '../src/index.ts'

let base: string
let w1: string
let w2: string
let w1Memory: string
let w2Memory: string
let userDir: string
let exec: MemoryToolExec

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'dsh-memory-l3-'))
  w1 = join(base, 'project-alpha')
  w2 = join(base, 'project-beta')
  w1Memory = join(w1, '.dsh', 'memory')
  w2Memory = join(w2, '.dsh', 'memory')
  userDir = join(base, 'user-home')
  await mkdir(w1Memory, { recursive: true })
  await mkdir(w2Memory, { recursive: true })
  await mkdir(userDir, { recursive: true })
  exec = { agent: { session: { header: { cwd: w1 } } } }
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const tools = (crossWorkspace = true): Record<string, ReturnType<typeof createMemoryTools>[number]> => {
  const list = createMemoryTools({
    maxBytes: 8192,
    maxIndexLines: 200,
    maxIndexBytes: 25_000,
    userMemoryDir: userDir,
    crossWorkspace,
  })
  return Object.fromEntries(list.map(tool => [tool.name, tool]))
}

const run = async (name: string, args: Record<string, unknown>, crossWorkspace = true): Promise<any> => {
  const tool = tools(crossWorkspace)[name]
  expect(tool, `tool ${name} exists`).toBeDefined()
  return await (tool!.execute as any)(args, exec)
}

describe('registerWorkspace / listWorkspaces', () => {
  it('registers with the project-root basename as alias, idempotently', async () => {
    await registerWorkspace(userDir, w1Memory)
    await registerWorkspace(userDir, w1Memory) // 幂等
    const entries = await listWorkspaces(userDir)
    expect(entries).toEqual([{ name: 'project-alpha', path: w1Memory }])
  })

  it('appends multiple workspaces in order', async () => {
    await registerWorkspace(userDir, w1Memory)
    await registerWorkspace(userDir, w2Memory)
    const entries = await listWorkspaces(userDir)
    expect(entries.map(entry => entry.name)).toEqual(['project-alpha', 'project-beta'])
  })

  it('persists a parseable registry file', async () => {
    await registerWorkspace(userDir, w2Memory)
    const text = await readFile(join(userDir, WORKSPACES_FILE), 'utf8')
    expect(text).toContain('- [project-beta](<')
    expect(text).toContain(w2Memory)
  })
})

describe('searchAcrossWorkspaces', () => {
  beforeEach(async () => {
    // w1 和 w2 各自有记忆，都登记
    await run('memory_update', { category: 'patterns', title: 'Alpha 模式', body: 'project-alpha 专属' })
    const w2Exec = { agent: { session: { header: { cwd: w2 } } } }
    const t = tools()
    await (t.memory_update!.execute as any)(
      { category: 'patterns', title: 'Beta 模式', body: 'docker-compose 部署' }, w2Exec)
  })

  it('finds entries in other registered workspaces with a source label', async () => {
    const result = await searchAcrossWorkspaces(userDir, w1Memory, 'docker-compose')
    expect(result).toContain('工作区<project-beta>/')
    expect(result).toContain('docker-compose 部署') // grep 返回命中行（正文）
  })

  it('excludes the current workspace', async () => {
    // "Alpha 特有词" shares no tokens with w2's entries, so only a hit in the
    // (excluded) current workspace could have matched — none is found.
    const result = await searchAcrossWorkspaces(userDir, w1Memory, 'Alpha 特有词')
    expect(result).toContain('跨工作区无匹配')
  })

  it('reports when nothing matches anywhere', async () => {
    const result = await searchAcrossWorkspaces(userDir, w1Memory, '不存在的词')
    expect(result).toContain('跨工作区无匹配')
  })

  it('applies the fuzzy fallback across workspaces', async () => {
    const result = await searchAcrossWorkspaces(userDir, w1Memory, 'docker compose 部署')
    expect(result).toContain('相关条目候选')
    expect(result).toContain('Beta 模式')
  })
})

describe('memory_update auto-registration', () => {
  it('registers the workspace after a workspace-scope write (default on)', async () => {
    await run('memory_update', { category: 'patterns', title: '模式', body: '内容' })
    const entries = await listWorkspaces(userDir)
    expect(entries.some(entry => entry.path === w1Memory)).toBe(true)
  })

  it('does not register when crossWorkspace is off (sensitive project)', async () => {
    await run('memory_update', { category: 'patterns', title: '模式', body: '内容' }, false)
    expect(await listWorkspaces(userDir)).toHaveLength(0)
  })

  it('does not register user-scope writes', async () => {
    await run('memory_update', { category: 'user', title: '偏好', body: '简洁', scope: 'user' })
    expect(await listWorkspaces(userDir)).toHaveLength(0)
  })
})

describe('memory_recall scope=across', () => {
  it('lists the registry when no query is given', async () => {
    await run('memory_update', { category: 'patterns', title: '模式', body: '内容' })
    const result = await run('memory_recall', { scope: 'across' })
    expect(result.text).toContain('已注册工作区')
    expect(result.text).toContain('project-alpha')
  })

  it('searches other registered workspaces and excludes the current one', async () => {
    // 两个工作区都写入并登记
    await run('memory_update', { category: 'patterns', title: 'Alpha 模式', body: 'w1 内容' })
    const w2Exec = { agent: { session: { header: { cwd: w2 } } } }
    const t = tools()
    await (t.memory_update!.execute as any)(
      { category: 'patterns', title: 'Beta 模式', body: 'w2 独有的 docker-compose 知识' }, w2Exec)

    const hit = await run('memory_recall', { scope: 'across', query: 'docker-compose' })
    expect(hit.text).toContain('工作区<project-beta>/')
    expect(hit.text).toContain('docker-compose 知识')
    expect(hit.text).not.toContain('Alpha 模式') // 当前工作区被排除
  })

  it('reports an empty registry gracefully', async () => {
    const result = await run('memory_recall', { scope: 'across', query: '任何词' })
    expect(result.text).toContain('跨工作区无匹配')
  })
})

describe('renderWorkspaceRegistry', () => {
  it('renders entries and usage hints', () => {
    const text = renderWorkspaceRegistry([{ name: 'project-beta', path: w2Memory }])
    expect(text).toContain('已注册工作区')
    expect(text).toContain('project-beta')
    expect(text).toContain('scope="across"')
  })

  it('renders an empty message', () => {
    expect(renderWorkspaceRegistry([])).toContain('注册表为空')
  })
})
