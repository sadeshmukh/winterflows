import type { RespondArguments } from '@slack/bolt'

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
