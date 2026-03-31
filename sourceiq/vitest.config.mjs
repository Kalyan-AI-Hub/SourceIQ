import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    env: {
      FOUNDRY_LOCAL_ENDPOINT: 'http://127.0.0.1:5273',
      FOUNDRY_LOCAL_MODEL: 'phi-4-mini',
      LANCEDB_PATH: './data/lancedb',
      SQLITE_PATH: './data/sourceiq.db',
      GDELT_ENDPOINT: 'https://api.gdeltproject.org/api/v2/doc/doc',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    },
  },
  resolve: {
    conditions: ['node'],
  },
});
