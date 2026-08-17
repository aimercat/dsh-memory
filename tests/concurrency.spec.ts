// @vitest-environment node
/** dsh-memory concurrency: serialized-write queue + atomic write, no lost entries. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendMemoryEntry,
  compactMemory,
  serializedWrite,
  supersedeEntry,
  updateStateSection,
} from '../src/index.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-conc-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('serializedWrite queue semantics', () => {
  it('executes queued ops strictly in order without interleaving', async () => {
    const order: number[] = []
    const ops = Array.from({ length: 10 }, (_, i) =>
      serializedWrite(async () => {
        order.push(i * 2) // enter
        await new Promise(resolve => setTimeout(resolve, Math.random() * 5))
        order.push(i * 2 + 1) // leave
      }))
    await Promise.all(ops)
    // Each op's enter/leave pair must be adjacent: no interleaving.
    for (let i = 0; i < 10; i += 1) {
      expect(order[i * 2]!).toBe(i * 2)
      expect(order[i * 2 + 1]!).toBe(i * 2 + 1)
    }
  })

  it('keeps serving later ops after an earlier op throws', async () => {
    await expect(serializedWrite(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    const seen: string[] = []
    await serializedWrite(async () => { seen.push('ok') })
    expect(seen).toEqual(['ok'])
  })
})

describe('concurrent writes', () => {
  it('appends 20 entries concurrently without losing any (file + index)', async () => {
    const writes = Array.from({ length: 20 }, (_, i) =>
      appendMemoryEntry(root, 'patterns', `条目${i}`, `内容${i}`))
    await Promise.all(writes)

    const text = await readFile(join(root, 'patterns.md'), 'utf8')
    for (let i = 0; i < 20; i += 1) {
      expect(text).toContain(`## [+] 条目${i} (`)
    }
    expect(text.match(/^## \[\+\] 条目\d+ \(/gm)).toHaveLength(20)

    const index = await readFile(join(root, 'index.md'), 'utf8')
    for (let i = 0; i < 20; i += 1) {
      expect(index).toContain(`条目${i}`)
    }
  })

  it('mixes append / state / supersede / compact concurrently with a consistent result', async () => {
    await appendMemoryEntry(root, 'decisions', '旧方案', 'v1')
    const mixed = [
      appendMemoryEntry(root, 'decisions', '方案A', 'a'),
      appendMemoryEntry(root, 'decisions', '方案B', 'b'),
      appendMemoryEntry(root, 'decisions', '旧方案 v2', 'v2'),
      updateStateSection(root, '当前进度', 'stage-01 完成'),
      updateStateSection(root, '上次会话状态', '试验中'),
      supersedeEntry(root, 'decisions', '旧方案', '旧方案 v2'),
      appendMemoryEntry(root, 'patterns', '并发模式', '串行队列'),
      compactMemory(root, 0),
    ]
    const results = await Promise.all(mixed)
    expect(results[5]).toEqual(['旧方案']) // supersede 标记成功

    const decisions = await readFile(join(root, 'decisions.md'), 'utf8')
    expect(decisions).toContain('## [+] 方案A')
    expect(decisions).toContain('## [+] 方案B')
    // compact(maxAgeDays=0) archives every superseded entry immediately,
    // so 「旧方案」landed in archive.md instead of staying as [-]
    expect(decisions).not.toContain('## [-] 旧方案')
    expect(decisions).toContain('## [+] 旧方案 v2')
    expect(decisions.match(/^## \[\+\] 方案A \(/gm)).toHaveLength(1)
    expect(decisions.match(/^## \[\+\] 方案B \(/gm)).toHaveLength(1)

    const archive = await readFile(join(root, 'archive.md'), 'utf8')
    expect(archive).toContain('[archived] 旧方案')

    const state = await readFile(join(root, 'state.md'), 'utf8')
    expect(state).toContain('stage-01 完成')
    expect(state).toContain('试验中')

    const index = await readFile(join(root, 'index.md'), 'utf8')
    expect(index).toContain('方案A')
    expect(index).toContain('方案B')
  })

  it('leaves no temp files behind after concurrent writes', async () => {
    const writes = Array.from({ length: 15 }, (_, i) =>
      appendMemoryEntry(root, 'user', `偏好${i}`, `内容${i}`))
    await Promise.all(writes)
    const files = await readdir(join(root))
    expect(files.some(name => name.includes('.tmp'))).toBe(false)
  })
})
