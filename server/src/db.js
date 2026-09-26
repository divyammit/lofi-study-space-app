import pg from 'pg'
import { readFile } from 'node:fs/promises'

// Return BIGINT as a JS number and DATE as a plain 'YYYY-MM-DD' string (no timezone shifting).
pg.types.setTypeParser(20, v => Number(v))
pg.types.setTypeParser(1082, v => v)

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy server/.env.example to server/.env and fill it in.')
  process.exit(1)
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10,
})

export const q = (text, params) => pool.query(text, params)

/** SQL fragment: a timestamptz column as epoch milliseconds (what the React app uses). */
export const ms = col => `floor(extract(epoch from ${col}) * 1000)::float8`

export async function migrate() {
  const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8')
  await pool.query(sql)
}
