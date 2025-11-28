import type { RespondArguments } from '@slack/bolt'
import { getConfigToken, updateConfigToken } from '../database/config_tokens'
import slack from '../clients/slack'

export async function respond(
  event: { response_url: string },
  data: string | RespondArguments
) {
  const isText = typeof data === 'string'
  const contentType = isText ? 'text/plain' : 'application/json'
  const body = isText ? data : JSON.stringify(data)

  return await fetch(event.response_url, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': contentType,
    },
  })
}

export async function getActiveConfigToken() {
  const token = await getConfigToken()
  if (!token) return
  if (token.expires_at > Date.now()) return token.access_token
  try {
    const res = await slack.tooling.tokens.rotate({
      refresh_token: token.refresh_token,
    })
    token.access_token = res.token!
    token.refresh_token = res.refresh_token!
    token.expires_at = res.exp! * 1000
  } catch (e) {
    console.error('Failed to rotate app config token:', e)
    return
  }
  await updateConfigToken(token)
  console.log('Successfully rotated config token!')
  return token.access_token
}
