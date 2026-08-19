// @vitest-environment node
/** dsh-memory v1.1 P1: index dual-threshold watermark — pressure reminder, compact verdict. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  composeMemoryContext,
  compactMemory,
  createMemoryTools,
  normalizeWatermarkRatios,
  renderCompactOutcome,
  renderMemoryReport,
  reportMemory,
  watermarkStatus,
  type MemoryToolExec,
} from '../src/index.ts'

let root: string
let memoryDir: string
let exec: MemoryToolExec

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-wm-'))
  memoryDir = join(root, '.dsh', 'memory')
  exec = { agent: { session: { header: { cwd: root } } } }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Build an index.md with `count` pointer rows. */
async function seedIndex(count: number): Promise<void> {
  await mkdir(memoryDir, { recursive: true })
  const rows = Array.from({ length: count }, (_, i) => `- [标题${i}](<patterns.md>) — 条目 ${i} 内容填充`)
  await writeFile(join(memoryDir, 'index.md'), `# 记忆索引\n\n${rows.join('\n')}\n`, 'utf8')
}

describe('normalizeWatermarkRatios', () => {
  it('passes valid ratios through', () => {
    expect(normalizeWatermarkRatios(0.8, 0.6)).toEqual({ high: 0.8, low: 0.6 })
  })

  it('falls back to defaults on inverted/equal/out-of-range config (review revision)', () => {
    expect(normalizeWatermarkRatios(0.5, 0.8)).toEqual({ high: 0.8, low: 0.6 }) // 反向
    expect(normalizeWatermarkRatios(0.6, 0.6)).toEqual({ high: 0.8, low: 0.6 }) // 等值
    expect(normalizeWatermarkRatios(1.2, 0.6)).toEqual({ high: 0.8, low: 0.6 }) // 越界
    expect(normalizeWatermarkRatios(undefined, undefined)).toEqual({ high: 0.8, low: 0.6 })
  })
})

describe('watermarkStatus', () => {
  it('classifies healthy/pressure/over on either dimension', () => {
    // 100 行 / 100KB，上限 200/25000B
    expect(watermarkStatus(100, 10_000, 200, 25_000, 0.8, 0.6).status).toBe('healthy')
    expect(watermarkStatus(170, 10_000, 200, 25_000, 0.8, 0.6).status).toBe('pressure') // 85% 行
    expect(watermarkStatus(100, 21_000, 200, 25_000, 0.8, 0.6).status).toBe('pressure') // 84% 字节
    expect(watermarkStatus(201, 10_000, 200, 25_000, 0.8, 0.6).status).toBe('over')
  })

  it('treats the boundary (exactly highWater) as pressure', () => {
    expect(watermarkStatus(160, 10_000, 200, 25_000, 0.8, 0.6).status).toBe('pressure')
  })

  it('computes the worst-dimension percent', () => {
    const info = watermarkStatus(170, 10_000, 200, 25_000, 0.8, 0.6)
    expect(info.percent).toBeCloseTo(0.85)
    expect(info.highLines).toBe(160)
    expect(info.lowLines).toBe(120)
  })
})

describe('composeMemoryContext watermark', () => {
  it('carries watermark info for the whole index file (not just injected rows)', async () => {
    await seedIndex(150) // 150 行 = 75% → healthy
    const ctx = await composeMemoryContext(memoryDir, 8192, 200, 25_000, { high: 0.8, low: 0.6 })
    expect(ctx.watermark).toBeDefined()
    expect(ctx.watermark!.lines).toBe(150)
    expect(ctx.watermark!.status).toBe('healthy')
  })

  it('marks pressure when over the high-water line', async () => {
    await seedIndex(170) // 85% → pressure
    const ctx = await composeMemoryContext(memoryDir, 8192, 200, 25_000, { high: 0.8, low: 0.6 })
    expect(ctx.watermark!.status).toBe('pressure')
  })
})

describe('memory_compact report watermark display', () => {
  it('shows single-state watermark with high/low lines', async () => {
    await seedIndex(170)
    const list = createMemoryTools({
      maxBytes: 8192,
      maxIndexLines: 200,
      maxIndexBytes: 25_000,
      userMemoryDir: join(root, 'user'),
      indexHighWaterRatio: 0.8,
      indexLowWaterRatio: 0.6,
    })
    const tool = list.find(t => t.name === 'memory_compact')!
    const result = await (tool.execute as any)({}, exec)
    expect(result.text).toContain('高水位 160 行')
    expect(result.text).toContain('低水位 120 行')
    expect(result.text).toContain('当前：85%（压力区')
  })

  it('validates inverted ratios back to defaults in the report', async () => {
    await seedIndex(170)
    const report = await reportMemory(memoryDir)
    const text = renderMemoryReport(report, 180, undefined, watermarkStatus(report.indexLines, report.indexBytes, 200, 25_000, 0.8, 0.6))
    expect(text).toContain('85%')
  })
})

describe('compactMemory watermark verdict', () => {
  it('reports the pressure verdict with next-step advice when compact cannot clear it', async () => {
    await seedIndex(170) // 85% → pressure
    // compact 无重复/废弃可合并 → 水位不变 → pressure + 明确建议
    const outcome = await compactMemory(memoryDir, 0, { high: 0.8, low: 0.6 })
    expect(outcome.watermark!.status).toBe('pressure')
    const text = renderCompactOutcome(outcome)
    expect(text).toContain('未到低水位')
    expect(text).toContain('建议')
    expect(outcome.coldCandidates).toBeInstanceOf(Array)
  })

  it('gives explicit next steps when still over the high-water line', async () => {
    await seedIndex(210) // over
    const outcome = await compactMemory(memoryDir, 0, { high: 0.8, low: 0.6 })
    const text = renderCompactOutcome(outcome)
    expect(text).toContain('需人工')
    expect(text).toContain('拆分')
  })
})

describe('injection pressure hint', () => {
  it('composeMemoryContext itself does not append pressure text (rendered separately)', async () => {
    // 压力提醒文本由 pre-step 注入逻辑追加；compose 只携带 watermark 数据。
    await seedIndex(170)
    const ctx = await composeMemoryContext(memoryDir, 8192, 200, 25_000, { high: 0.8, low: 0.6 })
    expect(ctx.watermark!.status).toBe('pressure')
    // renderMemoryContext 不含压力文案（避免与 overCap WARNING 混淆）
    const { renderMemoryContext } = await import('../src/index.ts')
    expect(renderMemoryContext(ctx)).not.toContain('压力区')
  })
})

describe('index pressure integration via compact outcome file check', () => {
  it('compact outcome persists index state', async () => {
    await seedIndex(120)
    const outcome = await compactMemory(memoryDir, 0, { high: 0.8, low: 0.6 })
    expect(outcome.watermark!.status).toBe('healthy')
    // index.md 未被 compact 改动（无重复/废弃）
    const index = await readFile(join(memoryDir, 'index.md'), 'utf8')
    expect(index).toContain('标题0')
  })
})
