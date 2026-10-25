import { defineConfig } from 'vitest/config';

// Default discovery would also run the agent skills' own test files under .agents, .claude, .codex.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], globalSetup: ['src/db/globalSetup.ts'] } });
