import { sql } from 'bun'

export interface ConfigToken {
  id: number
  access_token: string
  refresh_token: string
  expires_at: number
  user_id: string
}

export async function getConfigToken() {
  const result = await sql<ConfigToken[]>`SELECT * FROM config_tokens LIMIT 1`
  return result[0]
}
