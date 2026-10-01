import { defineConfig } from 'vitest/config'

import baseConfig from './vitest.config'

// Explicit manual workflow only; never mix live paid requests into ordinary CI.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['scripts/agent-live-grounding.evaluation.ts'],
    testTimeout: 120_000,
    hookTimeout: 15_000,
  },
})
