// @vitest-environment node
/** dsh-memory tool layer: exercise the real createMemoryTools factory paths. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createMemoryTools,
  type MemoryToolExec,
} from '../src/index.ts'

let root: string
let exec: MemoryToolExec

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-tools-'))
  exec = { agent: { session: { header: { cwd: root } } } }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const tools = (): Record<string, ReturnType<typeof createMemoryTools>[number]> => {
  const list = createMemoryTools({ maxBytes: 8192, maxIndexLines: 200, maxIndexBytes: 25_000 })
  return Object.fromEntries(list.map(tool => [tool.name, tool]))
}

const run = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const tool = tools()[name]
  expect(tool, `tool ${name} exists`).toBeDefined()
  return await (tool!.execute as any)(args, exec)
}

describe('memory_update tool', () => {
  it('appends an entry and rebuilds the pointer index', async () => {
    const result = await run('memory_update', { category: 'decisions', title: '选型', body: 'PostgreSQL。' })
    expect(result).toMatchObject({ ok: true, file: 'decisions.md', superseded: [], duplicates: [] })
    const decisions = await readFile(join(root, '.dsh', 'memory', 'decisions.md'), 'utf8')
    expect(decisions).toContain('## [+] 选型')
  })

  it('wires the supersede parameter to mark the old entry deprecated', async () => {
    await run('memory_update', { category: 'patterns', title: '状态机', body: 'v1。' })
    const result = await run('memory_update', {
      category: 'patterns',
      title: '状态机 v2',
      body: 'v2：状态表。',
      supersede: '状态机',
    })
    expect(result.superseded).toEqual(['状态机'])
    const patterns = await readFile(join(root, '.dsh', 'memory', 'patterns.md'), 'utf8')
    expect(patterns).toContain('## [-] 状态机')
    expect(patterns).toContain('已废弃，由「状态机 v2」取代')
  })

  it('reports duplicates when the same title already exists', async () => {
    await run('memory_update', { category: 'patterns', title: '命名规范', body: 'a' })
    const result = await run('memory_update', { category: 'patterns', title: '命名规范', body: 'b' })
    expect(result.duplicates).toHaveLength(1)
    expect(result.duplicates[0]).toContain('命名规范')
  })

  it('throws when required args are missing', async () => {
    await expect(run('memory_update', { category: 'patterns', title: '' , body: 'x' }))
      .rejects.toThrow('memory_update 需要 category / title / body')
  })
})

describe('memory_recall tool', () => {
  it('returns the index digest with no arguments', async () => {
    await run('memory_update', { category: 'user', title: '偏好', body: '简洁回答。' })
    const result = await run('memory_recall', {})
    expect(result.text).toContain('记忆索引')
    expect(result.text).toContain('user.md')
  })

  it('reads a category file', async () => {
    await run('memory_update', { category: 'user', title: '偏好', body: '简洁回答。' })
    const result = await run('memory_recall', { category: 'user' })
    expect(result.text).toContain('## [+] 偏好')
  })

  it('greps with a query', async () => {
    await run('memory_update', { category: 'troubleshooting', title: '端口冲突', body: 'docker-compose 改 host 端口' })
    const result = await run('memory_recall', { query: 'docker-compose' })
    expect(result.text).toContain('troubleshooting.md')
    expect(result.text).toContain('docker-compose')
  })

  it('rejects traversal paths', async () => {
    await expect(run('memory_recall', { path: '../secret.md' })).rejects.toThrow('非法记忆路径')
    await expect(run('memory_recall', { path: 'a/../../secret.md' })).rejects.toThrow('非法记忆路径')
  })

  it('reads a raw path inside .dsh/memory', async () => {
    await run('memory_update', { category: 'user', title: '偏好', body: '简洁回答。' })
    const result = await run('memory_recall', { path: 'user.md' })
    expect(result.text).toContain('## [+] 偏好')
  })

  it('reports missing files gracefully', async () => {
    const result = await run('memory_recall', { path: 'nope.md' })
    expect(result.text).toContain('无此文件')
  })
})

describe('memory_state tool', () => {
  it('updates a state section', async () => {
    const result = await run('memory_state', { section: '当前进度', body: 'stage-02 完成' })
    expect(result).toEqual({ ok: true })
    const state = await readFile(join(root, '.dsh', 'memory', 'state.md'), 'utf8')
    expect(state).toContain('## 当前进度')
    expect(state).toContain('stage-02 完成')
  })
})

describe('memory_compact tool', () => {
  it('reports statistics without mutating (applied: false)', async () => {
    await run('memory_update', { category: 'patterns', title: '重复', body: 'a' })
    await run('memory_update', { category: 'patterns', title: '重复', body: 'b' })
    const result = await run('memory_compact', {})
    expect(result.applied).toBe(false)
    expect(result.text).toContain('记忆概览')
    expect(result.text).toContain('patterns.md')
    expect(result.text).toContain('1 条重复')
    // report 不改文件
    const patterns = await readFile(join(root, '.dsh', 'memory', 'patterns.md'), 'utf8')
    expect(patterns).toContain('## [+] 重复')
  })

  it('applies the tidy-up: merges duplicates and rebuilds', async () => {
    await run('memory_update', { category: 'patterns', title: '重复', body: 'a' })
    await run('memory_update', { category: 'patterns', title: '重复', body: 'b（最新）' })
    const result = await run('memory_compact', { action: 'apply', maxAgeDays: 180 })
    expect(result.applied).toBe(true)
    expect(result.text).toContain('合并重复 1 条')
    const patterns = await readFile(join(root, '.dsh', 'memory', 'patterns.md'), 'utf8')
    expect(patterns).not.toContain('body: a') // 旧条目已归档
    const archive = await readFile(join(root, '.dsh', 'memory', 'archive.md'), 'utf8')
    expect(archive).toContain('[archived] 重复')
  })
})

describe('memory_confirm tool', () => {
  it('lists staged entries with no index', async () => {
    await run('memory_state', { section: '经验暂存', body: '- [ ] patterns: 状态机 — 用枚举' })
    const result = await run('memory_confirm', {})
    expect(result.archived).toEqual([])
    expect(result.remaining).toBe(1)
    expect(result.text).toContain('1. [ ] patterns: 状态机')
  })

  it('archives selected indices and clears them from staging', async () => {
    await run('memory_state', {
      section: '经验暂存',
      body: '- [ ] patterns: 状态机 — 用枚举\n- [ ] user: 喜欢简洁回答',
    })
    const result = await run('memory_confirm', { index: '1,2' })
    expect(result.archived).toEqual(['patterns: 状态机', 'user: 喜欢简洁回答'])
    expect(result.remaining).toBe(0)
    const state = await readFile(join(root, '.dsh', 'memory', 'state.md'), 'utf8')
    expect(state).not.toContain('状态机 — 用枚举')
  })

  it('supports index="all"', async () => {
    await run('memory_state', { section: '经验暂存', body: '- [ ] decisions: 用 PostgreSQL' })
    const result = await run('memory_confirm', { index: 'all' })
    expect(result.archived).toEqual(['decisions: 用 PostgreSQL'])
    expect(result.remaining).toBe(0)
  })

  it('reports invalid indices without archiving', async () => {
    await run('memory_state', { section: '经验暂存', body: '- [ ] decisions: 用 PostgreSQL' })
    const result = await run('memory_confirm', { index: 'abc,0' })
    expect(result.archived).toEqual([])
    expect(result.remaining).toBe(1)
    expect(result.text).toContain('未选择有效条目编号')
  })
})

describe('end-to-end lifecycle', () => {
  it('write → duplicate warn → supersede → compact → confirm → archive recovery', async () => {
    // 1. 写入 + 重复告警
    await run('memory_update', { category: 'patterns', title: 'API 风格', body: 'REST。' })
    const dup = await run('memory_update', { category: 'patterns', title: 'API 风格', body: 'REST 补充。' })
    expect(dup.duplicates).toHaveLength(1)

    // 2. supersede 取代旧条目
    const replaced = await run('memory_update', {
      category: 'patterns',
      title: 'API 风格 v2',
      body: 'RPC 更优。',
      supersede: 'API 风格',
    })
    expect(replaced.superseded).toEqual(['API 风格', 'API 风格'])
    const index = await readFile(join(root, '.dsh', 'memory', 'index.md'), 'utf8')
    expect(index).toContain('API 风格 v2')
    expect(index).not.toContain('REST')

    // 3. compact 合并重复（同标题 v2 只有一条，但旧的两条 API 风格已被 supersede）
    const compacted = await run('memory_compact', { action: 'apply', maxAgeDays: 0 })
    expect(compacted.applied).toBe(true)
    const archive = await readFile(join(root, '.dsh', 'memory', 'archive.md'), 'utf8')
    expect(archive).toContain('[archived]')

    // 4. 暂存 → 确认归档
    await run('memory_state', { section: '经验暂存', body: '- [ ] troubleshooting: 端口冲突 — 改 host 端口' })
    const confirmed = await run('memory_confirm', { index: 'all' })
    expect(confirmed.archived).toEqual(['troubleshooting: 端口冲突'])

    // 5. 归档可恢复：archive.md 保留了被取代的条目正文
    expect(archive).toContain('REST')
  })
})
