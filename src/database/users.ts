import { sql } from 'bun'

export interface User {
  id: string
  api_key: string | null
}

export async function getUserById(id: string) {
  return (await sql<User[]>`SELECT * FROM users WHERE id = ${id}`)[0]
}

export async function updateOrCreateUser(user: User) {
  // FIXME: make this atomic?
  const result = await sql<User[]>`UPDATE users SET ${sql(user)} WHERE id = ${
    user.id
  } RETURNING *`
  if (result[0]) return result[0]
  return (await sql<[User]>`INSERT INTO users ${sql(user)} RETURNING *`)[0]
}
