import type { EnvelopedEvent, SlashCommand } from '@slack/bolt'
import type { SlackEvent } from '@slack/types'
import { handleCoreEvent } from './core/events'
import { getVerifiedData } from './signature'
import { handleCommand } from './core/commands'

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
        ) {
          console.debug('URL verification challenge received:', unsafeData)
          return new Response(unsafeData.challenge)
        }

        if (unsafeData.type !== 'event_callback') {
          console.debug(`Unknown payload type:`, unsafeData)
          return NOT_FOUND
        }
        if (typeof unsafeData.api_app_id !== 'string') {
          console.debug('No app ID in payload:', unsafeData)
          return NOT_FOUND
        }
        const appId: string = unsafeData.api_app_id

        console.debug(`Received event for app ID ${appId} (${SLACK_APP_ID})`)
        if (appId === SLACK_APP_ID) {
          // handle self event
          const data = await getVerifiedData(req)
          if (!data.success) {
            console.warn(`Signature verification failed:`, unsafeData)
            return NOT_FOUND
          }
          const envelope: EnvelopedEvent = JSON.parse(data.data)
          const event = envelope.event as SlackEvent

          handleCoreEvent({ event, envelope })
        } else {
          // handle workflow event
        }

        return new Response()
      },
    },

    '/slack/command': {
      POST: async (req) => {
        const data = await getVerifiedData(req)
        if (!data.success) {
          console.warn(`Signature verification failed for command`)
          return NOT_FOUND
        }
        const payload: SlashCommand = new URLSearchParams(
          data.data
        ).toJSON() as SlashCommand

        const res = await handleCommand(payload)

        return new Response(res)
      },
    },

    '/oauth/callback': {
      GET: async (req) => {
        const query = new URL(req.url).searchParams
        const code = query.get('code')
        if (!code) {
          return new Response('No code in URL', { status: 400 })
        }

        // todo: update workflow
        return new Response('Thank you!')
      },
    },
  },
  port: PORT,
})

console.log(`Server started on http://localhost:${PORT}`)
