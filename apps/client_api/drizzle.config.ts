import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/clientSchema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'local.db',
  },
})
