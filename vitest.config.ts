import { defineConfig } from 'vitest/config'

// Two projects keep deterministic tests and real-capture tests apart:
//   * `unit`        - runs everywhere, never touches a real screen or a native helper.
//   * `integration` - really captures the screen/windows of the current machine.
// Keeping them separate lets CI report "logic passed" and "native capture passed"
// as different facts.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/**/*.integration.test.ts', 'node_modules/**'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/**/*.integration.test.ts'],
          environment: 'node',
          // Real captures launch a PowerShell script or a native helper, so the
          // default 5s timeout is not enough on slow or loaded machines.
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
})
