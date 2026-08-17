// @vitest-environment node
/** dsh-memory v2 core: memory dir resolution, pointer index, state sections, entry append, grep search. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendMemoryEntry,
  composeMemoryContext,
  memoryDirOf,
  rebuildIndex,
  renderMemoryContext,
  searchMemory,
  updateStateSection,
  readState,
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

describe('appendMemoryEntry + rebuildIndex (pointer style)', () => {
  it('appends a dated entry and rebuilds a pointer-style index', async () => {
    const dir = await memoryDirOf(root)
    await appendMemoryEntry(dir, 'decisions', 'OAuth2 方案', '选用 refresh token 轮换。')
    const decisions = await readFile(join(dir, 'decisions.md'), 'utf8')
    expect(decisions).toContain('## [+] OAuth2 方案 (')
    const index = await readFile(join(dir, 'index.md'), 'utf8')
    expect(index).toContain('- [OAuth2 方案](<decisions.md>)')
    expect(index).toContain('OAuth2 方案')
  })

  it('covers all four knowledge categories in the index', async () => {
    const dir = await memoryDirOf(root)
    for (const cat of ['decisions', 'patterns', 'troubleshooting', 'user']) {
      await appendMemoryEntry(dir, cat, `${cat} 条目`, '内容')
    }
    const index = await readFile(join(dir, 'index.md'), 'utf8')
    for (const cat of ['decisions.md', 'patterns.md', 'troubleshooting.md', 'user.md']) {
      expect(index).toContain(`(<${cat}>)`)
    }
  })
})

describe('state.md sections', () => {
  it('updates one section and preserves others', async () => {
    const dir = await memoryDirOf(root)
    await updateStateSection(dir, '当前进度', 'stage-02 完成 3/7')
    await updateStateSection(dir, '经验暂存', '- [ ] patterns: 状态机用 Switch+Enum')
    const state = await readFile(join(dir, 'state.md'), 'utf8')
    expect(state).toContain('## 当前进度')
    expect(state).toContain('stage-02 完成 3/7')
    expect(state).toContain('## 经验暂存')
    expect(state).toContain('状态机用 Switch+Enum')
  })

  it('clears a section with an empty body', async () => {
    const dir = await memoryDirOf(root)
    await updateStateSection(dir, '当前进度', '内容')
    await updateStateSection(dir, '当前进度', '')
    const sections = await readState(dir)
    expect(sections['当前进度'] ?? '').toBe('')
  })
})

describe('composeMemoryContext', () => {
  it('reads pointer rows and truncates state.md to half the budget', async () => {
    const dir = await memoryDirOf(root)
    await appendMemoryEntry(dir, 'decisions', '方案 A', '内容')
    await updateStateSection(dir, '上次会话状态', 'x'.repeat(2000))
    const context = await composeMemoryContext(dir, 1000)
    expect(context.index.some(row => row.file === 'decisions.md')).toBe(true)
    expect(context.state!.length).toBeLessThanOrEqual(600)
    expect(context.indexOverCap).toBe(false)
  })

  it('marks indexOverCap when the index exceeds the line cap', async () => {
    const dir = await memoryDirOf(root)
    await mkdir(dir, { recursive: true })
    const many = Array.from({ length: 250 }, (_, i) => `- [标题${i}](<decisions.md>) — 条目 ${i}`).join('\n')
    await writeFile(join(dir, 'index.md'), `# 记忆索引\n\n${many}\n`, 'utf8')
    const context = await composeMemoryContext(dir, 8192, 200, 25_000)
    expect(context.indexOverCap).toBe(true)
    expect(context.index.length).toBeLessThan(250)
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
  it('renders index rows, state block, over-cap warning, and memory discipline', () => {
    const text = renderMemoryContext({
      index: [{ file: 'decisions.md', summary: '方案 A' }],
      state: '上次在 stage-02。',
      indexOverCap: true,
      budget: 8192,
    })
    expect(text).toContain('decisions.md')
    expect(text).toContain('当前工作区状态')
    expect(text).toContain('WARNING')
    expect(text).toContain('memory_recall')
    expect(text).toContain('行动前用真实文件核实')
  })

  it('returns empty text for an empty context', () => {
    expect(renderMemoryContext({ index: [], indexOverCap: false, budget: 8192 })).toBe('')
  })
})

describe('searchMemory (grep)', () => {
  it('finds keyword matches across memory files', async () => {
    const dir = await memoryDirOf(root)
    await appendMemoryEntry(dir, 'troubleshooting', '端口冲突', 'docker-compose port mapping 冲突时改 host 端口')
    const result = await searchMemory(dir, 'docker-compose')
    expect(result).toContain('troubleshooting.md')
    expect(result).toContain('docker-compose port mapping')
  })

  it('reports no match', async () => {
    const dir = await memoryDirOf(root)
    const result = await searchMemory(dir, '不存在的词')
    expect(result).toContain('无匹配')
  })
})

/**
 * Minimal model of the agent inbox contract: every pending message carries a
 * unique `id`, and a second pending message with the same identity throws
 * `message "<id>" is already pending` (the harness's `Inbox.validate`).
 * The memory plugin's turn-end reminder queues into this face.
 */
class FakeInbox {
  nextStep: { id?: string; source: { kind?: string } }[] = []

  prepend(_phase: 'next-step', message: { id?: string; source: { kind?: string } }): void {
    if (this.nextStep.some(pending => pending.id === message.id)) {
      throw new Error(`message "${message.id}" is already pending`)
    }
    this.nextStep.unshift(message)
  }
}

describe('turn-end reminder inbox discipline', () => {
  it('reproduces the crash: two id-less reminders collide as "undefined"', () => {
    const inbox = new FakeInbox()
    const first = { content: [{ type: 'text', text: '第一回合' }], source: { kind: 'dsh-memory' } }
    const second = { content: [{ type: 'text', text: '第二回合' }], source: { kind: 'dsh-memory' } }
    inbox.prepend('next-step', first)
    expect(() => inbox.prepend('next-step', second))
      .toThrow('message "undefined" is already pending')
  })

  it('queues at most one identified dsh-memory reminder per pending batch', () => {
    const inbox = new FakeInbox()
    const queueReminder = (): number => {
      // Same decision the plugin's turn-end handler makes.
      if (inbox.nextStep.some(message => message.source?.kind === 'dsh-memory')) {
        return inbox.nextStep.length
      }
      inbox.prepend('next-step', {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: '本回合已结束。' }],
        source: { kind: 'dsh-memory' },
      })
      return inbox.nextStep.length
    }
    expect(queueReminder()).toBe(1)
    expect(queueReminder()).toBe(1)
    expect(inbox.nextStep).toHaveLength(1)
    expect(inbox.nextStep[0]?.id).toBeTypeOf('string')
    expect(inbox.nextStep[0]?.role).toBe('user')
  })
})

describe('pre-step digest injection turn-level dedup', () => {
  it('injects once per turn even across plugin instances and roots', () => {
    // The plugin keeps a module-level singleton map: a profile may mount the
    // plugin twice (host-plane bundle + agent-plane preset row) on different
    // Cordis roots, so per-root maps would let each instance inject its own
    // digest copy. Keyed by agent.id (unique per session), cross-root sharing
    // cannot collide unrelated agents.
    const shared = new Map<string, number>()
    const makeInstance = (): ((agentId: string, turn: number) => boolean) => {
      const shouldInject = (agentId: string, turn: number): boolean => {
        if (shared.get(agentId) === turn) return false
        shared.set(agentId, turn)
        return true
      }
      return shouldInject
    }

    const hostPlane = makeInstance()
    const agentPlane = makeInstance()

    // Turn 1, step 1 (user message): host-plane instance injects.
    expect(hostPlane('session-1', 1)).toBe(true)
    // Turn 1, step 2 (tool call): agent-plane instance skips — shared map.
    expect(agentPlane('session-1', 1)).toBe(false)
    // Turn 1, step 3 (continuation): host-plane skips too.
    expect(hostPlane('session-1', 1)).toBe(false)

    // Turn 2 opens (next user round): fresh digest, inject again (via agent).
    expect(agentPlane('session-1', 2)).toBe(true)
    expect(hostPlane('session-1', 2)).toBe(false)

    // Another agent is tracked independently.
    expect(agentPlane('session-2', 1)).toBe(true)
    expect(hostPlane('session-1', 2)).toBe(false)
  })
})
