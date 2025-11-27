import { sql } from 'bun'

export interface Workflow {
  id: number
  name: string
  app_id: string
  client_id: string
  client_secret: string
  signing_secret: string
  access_token: string | null
}

export async function getWorkflowById(id: number) {
  const result = await sql<Workflow[]>`SELECT * FROM workflows WHERE id = ${id}`
  return result[0]
}
