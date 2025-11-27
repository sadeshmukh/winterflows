import type { EnvelopedEvent } from '@slack/bolt'
import type { SlackEvent } from '@slack/types'

export async function handleCoreEvent({
  event,
  envelope,
}: {
  event: SlackEvent
  envelope: EnvelopedEvent
}) {
  console.log(envelope)
  console.log(event)
}
