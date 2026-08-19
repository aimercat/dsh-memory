// @vitest-environment node
/** dsh-memory v1.1 P2: across-workspace curb — cap, disable, low-confidence discipline. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ACROSS_LOW_CONFIDENCE,
  appendMemoryEntry,
  createMemoryTools,
  renderWorkspaceRegistry,
  searchAcrossWorkspaces,
  type MemoryToolExec,
} from '../src/index.ts'

let base: string
let current: string
let currentMemory: string
let userDir: string
let exec: MemoryToolExec

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'dsh-memory-curb-'))
  current = join(base, 'current')
  currentMemory = join(current, '.dsh', 'memory')
  userDir = join(base, 'user-home')
  await mkdir(currentMemory, { recursive: true })
  await mkdir(userDir, { recursive: true })
  exec = { agent: { session: { header: { cwd: current } } } }
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

/** Register `count` workspaces (w1..wN) with a marker entry each. */
async function seedWorkspaces(count: number): Promise<string[]> {
  const paths: string[] = []
  const { registerWorkspace } = await import('../src/index.ts')
  for (let i = 1; i <= count; i += 1) {
    const w = join(base, `w${i}`, '.dsh', 'memory')
    await appendMemoryEntry(w, 'patterns', `工作区${i}模式`, `仅工作区${i}独有的 docker 知识`)
    await registerWorkspace(userDir, w)
    paths.push(w)
  }
  return paths
}

describe('searchAcrossWorkspaces cap', () => {
  it('searches only the first N workspaces and reports skipped ones at the HEAD', async () => {
    await seedWorkspaces(8)
    const result = await searchAcrossWorkspaces(userDir, currentMemory, 'docker', 5)
    // 首部标注（评审修订）
    expect(result.startsWith(ACROSS_LOW_CONFIDENCE)).toBe(true)
    expect(result).toContain('已检索 5 个工作区，另有 3 个未检索')
    // 只搜了前 5 个（w1..w5），w6..w8 不出现
    expect(result).toContain('工作区<w1>/')
    expect(result).toContain('工作区<w5>/')
    expect(result).not.toContain('工作区<w6>/')
    expect(result).not.toContain('工作区<w8>/')
  })

  it('maxWorkspaces=0 disables cross-workspace search', async () => {
    await seedWorkspaces(3)
    const result = await searchAcrossWorkspaces(userDir, currentMemory, 'docker', 0)
    expect(result).toContain('已禁用')
    expect(result).not.toContain('工作区<')
  })

  it('skips the current workspace before capping', async () => {
    const paths = await seedWorkspaces(3)
    // 当前工作区也在注册表里
    const { registerWorkspace } = await import('../src/index.ts')
    await registerWorkspace(userDir, currentMemory)
    const result = await searchAcrossWorkspaces(userDir, currentMemory, 'docker', 2)
    // 排除当前后取前 2 个注册工作区；当前工作区内容不出现
    expect(result).not.toContain('工作区<current>/')
    expect(result).toContain('工作区<w1>/')
    expect(result).toContain('工作区<w2>/')
    expect(result).not.toContain('工作区<w3>/') // 第 3 个注册工作区被上限截掉
    expect(paths).toHaveLength(3)
  })
})

describe('low-confidence discipline', () => {
  it('prefixes results with the low-confidence + negative-example text', async () => {
    await seedWorkspaces(2)
    const result = await searchAcrossWorkspaces(userDir, currentMemory, 'docker', 5)
    expect(result).toContain('默认低置信')
    expect(result).toContain('不要把别的工作区中的项目决策、命名约定、路径结构、工具命令直接套用')
  })

  it('prefixes the no-match message too', async () => {
    await seedWorkspaces(2)
    const result = await searchAcrossWorkspaces(userDir, currentMemory, '不存在的词', 5)
    expect(result).toContain('默认低置信')
    expect(result).toContain('跨工作区无匹配')
  })

  it('registry listing carries the discipline and explicit-trigger note', async () => {
    await seedWorkspaces(2)
    const text = renderWorkspaceRegistry(await (await import('../src/index.ts')).listWorkspaces(userDir))
    expect(text).toContain('默认低置信')
    expect(text).toContain('显式触发，普通检索不自动跨区')
  })
})

describe('memory_recall tool maxWorkspaces', () => {
  it('accepts maxWorkspaces override on scope=across', async () => {
    await seedWorkspaces(6)
    const list = createMemoryTools({
      maxBytes: 8192,
      maxIndexLines: 200,
      maxIndexBytes: 25_000,
      userMemoryDir: userDir,
      acrossMaxWorkspaces: 5, // 配置默认 5
    })
    const tool = list.find(t => t.name === 'memory_recall')!
    // 覆盖为 3
    const result = await (tool.execute as any)({ scope: 'across', query: 'docker', maxWorkspaces: 3 }, exec)
    expect(result.text).toContain('已检索 3 个工作区，另有 3 个未检索')
    expect(result.text).toContain('工作区<w3>/')
    expect(result.text).not.toContain('工作区<w6>/')
  })

  it('falls back to the config default when maxWorkspaces is absent', async () => {
    await seedWorkspaces(6)
    const list = createMemoryTools({
      maxBytes: 8192,
      maxIndexLines: 200,
      maxIndexBytes: 25_000,
      userMemoryDir: userDir,
      acrossMaxWorkspaces: 2,
    })
    const tool = list.find(t => t.name === 'memory_recall')!
    const result = await (tool.execute as any)({ scope: 'across', query: 'docker' }, exec)
    expect(result.text).toContain('已检索 2 个工作区，另有 4 个未检索')
  })
})
