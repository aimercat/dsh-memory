import { defineConfig } from 'tsdown'

export default defineConfig({
  name: '@linxin666/dsh-memory',
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // The cordis framework and harness SDK resolve at runtime from the dsh
  // profile tree, never from this repo's install.
  external: ['@deepseek-ai/cordis', /^@deepseek-ai\/dsh-/],
})
