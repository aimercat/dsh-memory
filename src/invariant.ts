/**
 * @deepseek-ai/dsh-memory invariant: the package-manifest registration.
 *
 * No runtime invariant: memory is a pure optional capability — the tools
 * register into the host tool registry, and the injection filter composes
 * file digests that may legitimately be absent. There is no event/data
 * relationship to check that is owned by this package.
 * @module @deepseek-ai/dsh-memory/invariant
 */

export const name = 'memory-invariant'
