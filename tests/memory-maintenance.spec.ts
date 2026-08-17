// @vitest-environment node
/** dsh-memory v2 maintenance: entry block parsing, supersede, archive, compact, staged confirm. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendMemoryEntry,
  archiveEntryBlocks,
  compactMemory,
  confirmStagedEntries,
  findDuplicateTitles,
  parseEntryHeader,
  parseStagedEntries,
  removeEntryBlocks,
  renderStagedEntries,
  reportMemory,
  splitEntryBlocks,
  supersedeEntry,
  updateStateSection,
} from '../src/index.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-maint-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const join2 = (...parts: string[]): string => join(root, ...parts)

describe('splitEntryBlocks / parseEntryHeader', () => {
  it('splits a knowledge file into entry blocks with line spans', async () => {
    const text = [
      '# patterns',
      '',
      '## [+] 状态机 (2026-01-01)',
      '',
      '用 Switch + Enum 表达状态机。',
      '',
      '## [-] 旧方案 (2025-12-01) — 已废弃，由「新方案」取代 (2026-01-02)',
      '',
      '曾被采用的旧方案。',
      '',
    ].join('\n')
    const blocks = splitEntryBlocks(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({
      plainTitle: '状态机',
      date: '2026-01-01',
      superseded: false,
      start: 2,
      end: 5,
      rawBody: '用 Switch + Enum 表达状态机。',
    })
    expect(blocks[1]).toMatchObject({
      plainTitle: '旧方案',
      date: '2025-12-01',
      superseded: true,
    })
  })

  it('handles entries without a date', () => {
    const blocks = splitEntryBlocks('## [+] 无日期条目\n\n正文\n')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ plainTitle: '无日期条目', date: '', superseded: false })
  })

  it('parseEntryHeader tolerates non-entry headings', () => {
    expect(parseEntryHeader('## 不是条目'))
      .toEqual({ plainTitle: '不是条目', date: '', superseded: false, supersededDate: '' })
  })
})

describe('supersedeEntry', () => {
  it('marks matching active entries as superseded and rebuilds the index', async () => {
    await appendMemoryEntry(root, 'patterns', '状态机方案', '用 Switch + Enum。')
    await appendMemoryEntry(root, 'patterns', '状态机方案', '更新：用状态表。')
    const marked = await supersedeEntry(root, 'patterns', '状态机方案', '状态机方案 v2')
    expect(marked).toHaveLength(2)

    const text = await readFile(join2('patterns.md'), 'utf8')
    expect(text.match(/^## \[-\]/gm)).toHaveLength(2)
    expect(text).toContain('已废弃，由「状态机方案 v2」取代')

    const index = await readFile(join2('index.md'), 'utf8')
    expect(index).not.toContain('状态机方案')
  })

  it('is idempotent: already-superseded entries are not marked twice', async () => {
    await appendMemoryEntry(root, 'decisions', '数据库选型', 'PostgreSQL。')
    await supersedeEntry(root, 'decisions', '数据库选型', '数据库选型 v2')
    const again = await supersedeEntry(root, 'decisions', '数据库选型', '数据库选型 v3')
    expect(again).toHaveLength(0)
  })

  it('returns empty when nothing matches and writes nothing', async () => {
    await appendMemoryEntry(root, 'patterns', 'A', 'a')
    const marked = await supersedeEntry(root, 'patterns', '不存在的标题', 'x')
    expect(marked).toHaveLength(0)
    const text = await readFile(join2('patterns.md'), 'utf8')
    expect(text).toContain('## [+] A')
  })
})

describe('findDuplicateTitles', () => {
  it('finds active entries with the same normalized title (case/whitespace insensitive)', async () => {
    await appendMemoryEntry(root, 'patterns', 'Naming Convention', 'PascalCase。')
    await appendMemoryEntry(root, 'patterns', 'Naming Convention', '补充：私有成员 _ 前缀。')
    const hits = await findDuplicateTitles(root, 'patterns', ' naming   convention ')
    expect(hits).toHaveLength(2)
    expect(hits[0]).toContain('Naming Convention')
  })

  it('ignores superseded entries', async () => {
    await appendMemoryEntry(root, 'patterns', '命名规范', '旧。')
    await supersedeEntry(root, 'patterns', '命名规范', '命名规范 v2')
    const hits = await findDuplicateTitles(root, 'patterns', '命名规范')
    expect(hits).toHaveLength(0)
  })
})

describe('archiveEntryBlocks + removeEntryBlocks', () => {
  it('archives blocks with reason and date, then removes them from the source', async () => {
    await appendMemoryEntry(root, 'troubleshooting', '端口冲突', 'docker-compose 端口映射冲突时改 host 端口')
    const text = await readFile(join2('troubleshooting.md'), 'utf8')
    const blocks = splitEntryBlocks(text)
    const today = new Date().toISOString().slice(0, 10)

    await archiveEntryBlocks(root, 'troubleshooting', blocks, '重复合并')
    await removeEntryBlocks(root, 'troubleshooting', blocks)

    const archive = await readFile(join2('archive.md'), 'utf8')
    expect(archive).toContain('## [archived] 端口冲突 (')
    expect(archive).toContain(`— ${today} 归档：重复合并（原分类 troubleshooting）`)
    expect(archive).toContain('docker-compose 端口映射冲突时改 host 端口')

    const remaining = await readFile(join2('troubleshooting.md'), 'utf8')
    expect(remaining).not.toContain('端口冲突')
  })

  it('is a no-op for an empty block list', async () => {
    await appendMemoryEntry(root, 'patterns', 'A', 'a')
    const text = await readFile(join2('patterns.md'), 'utf8')
    const blocks = splitEntryBlocks(text)
    await archiveEntryBlocks(root, 'patterns', blocks, '原因')
    const before = await readFile(join2('archive.md'), 'utf8')
    await archiveEntryBlocks(root, 'patterns', [], '原因2')
    const after = await readFile(join2('archive.md'), 'utf8')
    expect(after).toBe(before)
  })
})

describe('reportMemory', () => {
  it('reports totals, duplicates, superseded and stale counts', async () => {
    await appendMemoryEntry(root, 'patterns', '重复标题', 'a')
    await appendMemoryEntry(root, 'patterns', '重复标题', 'b')
    await appendMemoryEntry(root, 'patterns', '独立条目', 'c')
    await supersedeEntry(root, 'patterns', '独立条目', '独立条目 v2')
    // 一个 500 天前的陈旧条目
    const old = new Date(Date.now() - 500 * 86_400_000).toISOString().slice(0, 10)
    const text = await readFile(join2('patterns.md'), 'utf8')
    await writeFile(join2('patterns.md'), text + `\n## [+] 陈旧条目 (${old})\n\n过期的知识。\n`, 'utf8')

    const report = await reportMemory(root, 180)
    const patterns = report.files.find(file => file.name === 'patterns.md')!
    expect(patterns.total).toBe(4)
    expect(patterns.duplicates).toBe(1)
    expect(patterns.superseded).toBe(1)
    expect(patterns.stale).toBe(1)
    expect(report.totalEntries).toBe(4)
  })

  it('reports index pressure against the hard caps', async () => {
    await mkdir(join2('x'), { recursive: true })
    const many = Array.from({ length: 250 }, (_, i) => `- [标题${i}](<decisions.md>) — 条目 ${i}`).join('\n')
    await writeFile(join2('index.md'), `# 记忆索引\n\n${many}\n`, 'utf8')
    const report = await reportMemory(root)
    expect(report.indexLines).toBe(250)
    expect(report.indexOverCap).toBe(true)
  })
})

describe('compactMemory', () => {
  it('merges duplicate groups keeping the newest, archives stale superseded, leaves fresh superseded', async () => {
    await appendMemoryEntry(root, 'patterns', '状态机', 'v1：Switch + Enum。')
    await appendMemoryEntry(root, 'patterns', '状态机', 'v2：状态表更清晰。')
    await appendMemoryEntry(root, 'patterns', '独立', '有效知识。')
    await supersedeEntry(root, 'patterns', '独立', '独立 v2')
    // 手工把「独立」的废弃日期改老，模拟过期废弃
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10)
    const today = new Date().toISOString().slice(0, 10)
    const text = await readFile(join2('patterns.md'), 'utf8')
    await writeFile(
      join2('patterns.md'),
      text.replace(`已废弃，由「独立 v2」取代 (${today})`, `已废弃，由「独立 v2」取代 (${old})`),
      'utf8',
    )

    const outcome = await compactMemory(root, 180)
    expect(outcome.merged).toEqual(['patterns: 状态机'])
    expect(outcome.archivedSuperseded).toEqual(['patterns: 独立'])
    expect(outcome.indexRebuilt).toBe(true)

    const patterns = await readFile(join2('patterns.md'), 'utf8')
    expect(patterns).toContain('## [+] 状态机')
    expect(patterns).not.toContain('v1：Switch + Enum。')
    expect(patterns).not.toContain('独立') // 过期的废弃条目已归档

    const archive = await readFile(join2('archive.md'), 'utf8')
    expect(archive).toContain('[archived] 状态机')
    expect(archive).toContain('[archived] 独立')

    const index = await readFile(join2('index.md'), 'utf8')
    expect(index).toContain('状态机')
    expect(index).not.toContain('独立')
  })

  it('returns empty outcome when there is nothing to tidy', async () => {
    await appendMemoryEntry(root, 'patterns', '唯一', '内容。')
    const outcome = await compactMemory(root, 180)
    expect(outcome.merged).toHaveLength(0)
    expect(outcome.archivedSuperseded).toHaveLength(0)
    expect(outcome.indexRebuilt).toBe(false)
  })
})

describe('parseStagedEntries', () => {
  it('parses the three staging formats with line numbers', () => {
    const text = [
      '（说明文字，不匹配条目模式）',
      '- [ ] patterns: 状态机用 Switch+Enum',
      '- [ ] troubleshooting: 端口冲突 — docker-compose 端口映射冲突时改 host 端口',
      '- [x] decisions: 已确认条目',
      '',
    ].join('\n')
    const entries = parseStagedEntries(text)
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ index: 1, line: 1, category: 'patterns', title: '状态机用 Switch+Enum', body: '', checked: false })
    expect(entries[1]).toMatchObject({ index: 2, line: 2, category: 'troubleshooting', title: '端口冲突', body: 'docker-compose 端口映射冲突时改 host 端口', checked: false })
    expect(entries[2]).toMatchObject({ index: 3, line: 3, category: 'decisions', title: '已确认条目', checked: true })
  })

  it('returns empty for a non-entry staging section', () => {
    expect(parseStagedEntries('（待确认归档的经验条目）')).toHaveLength(0)
  })
})

describe('confirmStagedEntries', () => {
  it('archives selected entries into knowledge files and clears them from staging', async () => {
    await updateStateSection(root, '经验暂存', [
      '- [ ] patterns: 状态机方案 — 用 Switch+Enum 表达',
      '- [ ] troubleshooting: 端口冲突 — 改 host 端口',
      '- [ ] user: 喜欢简洁回答',
    ].join('\n'))

    const result = await confirmStagedEntries(root, [1, 3])
    expect(result.archived).toEqual(['patterns: 状态机方案', 'user: 喜欢简洁回答'])
    expect(result.remaining).toBe(1)

    const patterns = await readFile(join2('patterns.md'), 'utf8')
    expect(patterns).toContain('## [+] 状态机方案')
    expect(patterns).toContain('用 Switch+Enum 表达')

    const user = await readFile(join2('user.md'), 'utf8')
    expect(user).toContain('## [+] 喜欢简洁回答')

    const state = await readFile(join2('state.md'), 'utf8')
    expect(state).toContain('- [ ] troubleshooting: 端口冲突 — 改 host 端口')
    expect(state).not.toContain('状态机方案')
    expect(state).not.toContain('喜欢简洁回答')
  })

  it('supports "all" and falls body back to the title', async () => {
    await updateStateSection(root, '经验暂存', '- [ ] decisions: 用 PostgreSQL')
    const result = await confirmStagedEntries(root, 'all')
    expect(result.archived).toEqual(['decisions: 用 PostgreSQL'])
    expect(result.remaining).toBe(0)

    const decisions = await readFile(join2('decisions.md'), 'utf8')
    expect(decisions).toContain('## [+] 用 PostgreSQL')
    expect(decisions).toContain('用 PostgreSQL') // body 回退为标题
  })

  it('skips entries with an unknown category', async () => {
    await updateStateSection(root, '经验暂存', '- [ ] secret: 不知名分类')
    const result = await confirmStagedEntries(root, 'all')
    expect(result.archived).toEqual(['secret: 不知名分类（跳过：非知识分类）'])
    expect(result.remaining).toBe(0)
  })

  it('warns about unparseable staging content instead of pretending it is empty', async () => {
    await updateStateSection(root, '经验暂存', '一条没有按格式写的经验')
    const text = renderStagedEntries(parseStagedEntries('一条没有按格式写的经验'), '一条没有按格式写的经验')
    expect(text).toContain('格式无法解析')
    expect(text).toContain('- [ ] {category}: {title}')
    expect(text).toContain('一条没有按格式写的经验') // 原文可见
  })
})
