import type { EnvelopedEvent } from '@slack/bolt'
import type { SlackEvent } from '@slack/types'
import type { Workflow } from '../database/workflows'
import { updateHomeTab } from './blocks'

export async function handleWorkflowEvent({
  event,
  workflow,
}: {
  event: SlackEvent
  envelope: EnvelopedEvent
  workflow: Workflow
}) {
  if (!workflow.access_token) return

  if (event.type === 'app_home_opened') {
    if (event.tab !== 'home') return

    await updateHomeTab(workflow, event.user)
  }
}
