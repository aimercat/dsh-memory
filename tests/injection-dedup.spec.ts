// @vitest-environment node
/** dsh-memory v1.2 P0: session-level injection dedup — hash, decision logic, counters. */
import { describe, expect, it } from 'vitest'
import {
  decideInjectionDedup,
  fnv1a64,
  injectionDedupCounters,
} from '../src/index.ts'

describe('fnv1a64', () => {
  it('is deterministic and 16-hex-char', () => {
    const a = fnv1a64('工作区记忆索引')
    expect(a).toBe(fnv1a64('工作区记忆索引'))
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('differs for different texts and handles empty string', () => {
    expect(fnv1a64('a')).not.toBe(fnv1a64('b'))
    expect(fnv1a64('')).toBe(fnv1a64(''))
    // 微变也产生不同哈希（压力提醒尾部变化场景）
    expect(fnv1a64('记忆纪律：提示')).not.toBe(fnv1a64('记忆纪律：提示。'))
  })
})

describe('decideInjectionDedup', () => {
  const entry = { hash: 'abc', len: 10, skipCount: 0 }

  it('injects when there is no cache (first turn of a session)', () => {
    expect(decideInjectionDedup(undefined, 'abc', 10, 20)).toBe('inject')
  })

  it('skips when content is identical and under the refresh limit', () => {
    expect(decideInjectionDedup(entry, 'abc', 10, 20)).toBe('skip')
    expect(decideInjectionDedup({ ...entry, skipCount: 19 }, 'abc', 10, 20)).toBe('skip')
  })

  it('forces a refresh after the skip limit', () => {
    expect(decideInjectionDedup({ ...entry, skipCount: 20 }, 'abc', 10, 20)).toBe('refresh')
    expect(decideInjectionDedup({ ...entry, skipCount: 25 }, 'abc', 10, 20)).toBe('refresh')
  })

  it('injects when the hash or length changed (memory updated)', () => {
    expect(decideInjectionDedup(entry, 'abd', 10, 20)).toBe('inject') // 哈希变
    expect(decideInjectionDedup(entry, 'abc', 11, 20)).toBe('inject') // 长度变
  })
})

describe('debug counters', () => {
  it('are observable but not part of formal stats', () => {
    expect(injectionDedupCounters).toHaveProperty('skipped')
    expect(injectionDedupCounters).toHaveProperty('forcedRefresh')
    expect(injectionDedupCounters.skipped).toBeTypeOf('number')
    expect(injectionDedupCounters.forcedRefresh).toBeTypeOf('number')
  })
})
