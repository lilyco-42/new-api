import { defineConfig, mergeConfig } from 'vitest/config'

import baseConfig from './vitest.config'

// Explicit manual workflow only; never mix live paid requests into ordinary CI.
export default mergeConfig(baseConfig, defineConfig({
  test: {
    include: ['scripts/agent-live-grounding.evaluation.ts'],
    testTimeout: 120_000,
    hookTimeout: 15_000,
  },
}))
