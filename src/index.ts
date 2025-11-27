import type { EnvelopedEvent } from '@slack/bolt'
import { getVerifiedData } from './signature'
import type { SlackEvent } from '@slack/types'

const PORT = process.env.PORT || '8000'
const { SLACK_APP_ID } = process.env

const NOT_FOUND = new Response('', { status: 404 })

Bun.serve({
  routes: {
    '/slack/events': {
      POST: async (req) => {
        const unsafeData = (await req.clone().json()) as any

        if (
          unsafeData.type === 'url_verification' &&
          typeof unsafeData.challenge === 'string'
        )
          return new Response(unsafeData.challenge)

        if (unsafeData.type !== 'event_callback') return NOT_FOUND
        if (typeof unsafeData.api_app_id !== 'string') return NOT_FOUND
        const appId: string = unsafeData.api_app_id

        if (appId === SLACK_APP_ID) {
          // handle self event
          const data = await getVerifiedData(req)
          if (!data.success) return NOT_FOUND
          const envelope: EnvelopedEvent = JSON.parse(data.data)
          const event = envelope.event as SlackEvent
        } else {
          // handle workflow event
        }

        return new Response()
      },
    },
  },
  port: PORT,
})

console.log(`Server started on http://localhost:${PORT}`)
