// @vitest-environment node
/** dsh-memory fuzzy fallback: token overlap suggestions when exact grep misses. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendMemoryEntry,
  createMemoryTools,
  fuzzyScore,
  fuzzySuggest,
  renderFuzzySuggestions,
  searchMemory,
  supersedeEntry,
  tokenizeForFuzzy,
  type MemoryToolExec,
} from '../src/index.ts'

let root: string
let exec: MemoryToolExec

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-fuzzy-'))
  exec = { agent: { session: { header: { cwd: root } } } }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('tokenizeForFuzzy', () => {
  it('extracts ASCII words and CJK bigrams', () => {
    const tokens = tokenizeForFuzzy('docker-compose 端口映射冲突 host 端口')
    expect(tokens.has('docker-compose')).toBe(true)
    expect(tokens.has('host')).toBe(true)
    // CJK bigrams of 端口映射冲突
    expect(tokens.has('端口')).toBe(true)
    expect(tokens.has('映射')).toBe(true)
    expect(tokens.has('冲突')).toBe(true)
  })

  it('is case-insensitive', () => {
    const tokens = tokenizeForFuzzy('PostgreSQL')
    expect(tokens.has('postgresql')).toBe(true)
  })
})

describe('fuzzyScore', () => {
  it('returns 1 for full query coverage and 0 for none', () => {
    const q = tokenizeForFuzzy('docker compose')
    expect(fuzzyScore(q, tokenizeForFuzzy('docker compose 端口'))).toBe(1)
    expect(fuzzyScore(q, tokenizeForFuzzy('完全无关的内容'))).toBe(0)
  })

  it('returns partial scores for partial coverage', () => {
    const q = tokenizeForFuzzy('a b c d')
    expect(fuzzyScore(q, tokenizeForFuzzy('a b'))).toBe(0.5)
  })
})

describe('fuzzySuggest', () => {
  it('bridges wording mismatches: English query vs stored entry', async () => {
    await appendMemoryEntry(root, 'troubleshooting', '端口冲突', 'docker-compose 端口映射冲突时改 host 端口')
    const hits = await fuzzySuggest(root, 'port mapping docker compose')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.title).toContain('端口冲突')
    // docker + compose both hit via the hyphen-split of "docker-compose"
    expect(hits[0]!.score).toBeGreaterThan(0.4)
  })

  it('bridges Chinese wording: query bigrams vs stored entry', async () => {
    await appendMemoryEntry(root, 'patterns', '状态机方案', '用状态表表达状态转移')
    const hits = await fuzzySuggest(root, '状态表 转移')
    expect(hits.some(hit => hit.title.includes('状态机方案'))).toBe(true)
  })

  it('skips superseded entries', async () => {
    await appendMemoryEntry(root, 'patterns', '旧方案', '已被取代的内容')
    await supersedeEntry(root, 'patterns', '旧方案', '新方案')
    const hits = await fuzzySuggest(root, '已被取代')
    expect(hits).toHaveLength(0)
  })

  it('returns nothing for an empty memory or a tokenless query', async () => {
    expect(await fuzzySuggest(root, '任何词')).toHaveLength(0)
    expect(await fuzzySuggest(root, '！！！！！')).toHaveLength(0)
  })
})

describe('searchMemory fuzzy fallback', () => {
  it('returns suggestions instead of a bare miss on wording mismatch', async () => {
    await appendMemoryEntry(root, 'troubleshooting', '端口冲突', 'docker-compose 端口映射冲突时改 host 端口')
    const result = await searchMemory(root, 'port mapping docker compose')
    expect(result).toContain('相关条目候选')
    expect(result).toContain('端口冲突')
    expect(result).toContain('相关度')
  })

  it('keeps exact matches untouched (no fuzzy text)', async () => {
    await appendMemoryEntry(root, 'patterns', '命名规范', 'PascalCase')
    const result = await searchMemory(root, 'PascalCase')
    expect(result).toContain('### patterns.md')
    expect(result).not.toContain('相关条目候选')
  })

  it('keeps the bare miss when nothing is close', async () => {
    const result = await searchMemory(root, '完全不存在的关键词')
    expect(result).toBe('（无匹配：完全不存在的关键词）')
  })

  it('renders suggestions with titles and scores', () => {
    const text = renderFuzzySuggestions('port', [
      { file: 'troubleshooting.md', title: '端口冲突 (2026-01-01)', score: 0.8 },
    ])
    expect(text).toContain('相关条目候选')
    expect(text).toContain('troubleshooting.md：端口冲突 (2026-01-01)')
    expect(text).toContain('相关度 80%')
  })
})

describe('memory_recall tool integration', () => {
  it('surfaces fuzzy candidates through the query path', async () => {
    // The tool resolves the memory dir via memoryDirOf (root/.dsh/memory),
    // so the entry must live there — not in root itself.
    await appendMemoryEntry(join(root, '.dsh', 'memory'), 'troubleshooting', '端口冲突', 'docker-compose 端口映射冲突时改 host 端口')
    const list = createMemoryTools({ maxBytes: 8192, maxIndexLines: 200, maxIndexBytes: 25_000, userMemoryDir: join(root, 'user') })
    const tool = list.find(t => t.name === 'memory_recall')!
    const result = await (tool.execute as any)({ query: 'port mapping docker compose' }, exec)
    expect(result.text).toContain('相关条目候选')
    expect(result.text).toContain('端口冲突')
  })
})
