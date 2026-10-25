import { defineConfig } from 'drizzle-kit';

// DATABASE_URL: direct connection or session pooler (port 5432), never transaction mode (decision 0010).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
