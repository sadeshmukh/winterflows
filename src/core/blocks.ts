import type { HomeView, KnownBlock } from '@slack/types'
import { getWorkflowsByCreator, type Workflow } from '../database/workflows'
import slack from '../clients/slack'

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!

export async function updateCoreHomeTab(userId: string, search?: string) {
  const workflows = await getWorkflowsByCreator(userId)

  await slack.views.publish({
    token: SLACK_BOT_TOKEN,
    user_id: userId,
    view: await generateCoreHomeView(workflows, search),
  })
}

async function generateCoreHomeView(
  workflows: Workflow[],
  search?: string
): Promise<HomeView> {
  const filteredWorkflows = workflows.filter(
    (w) => !search || w.name.toLowerCase().includes(search.toLowerCase())
  )

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Welcome to Winterflows!' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Next-gen workflows, as the winter of Slack workflows arrives...',
      },
    },
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: 'Your workflows' } },
  ]

  if (!workflows.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "You don't have any workflows yet. Use the `/winterflows-create` command to create one!",
      },
    })
  } else {
    blocks.push({
      type: 'input',
      label: { type: 'plain_text', text: ':mag: Search', emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: 'search_workflows',
        placeholder: {
          type: 'plain_text',
          text: 'Search your workflows...',
          emoji: true,
        },
        initial_value: search || undefined,
        dispatch_action_config: { trigger_actions_on: ['on_enter_pressed'] },
      },
      dispatch_action: true,
    })
    if (!filteredWorkflows.length) {
      blocks.push({
        type: 'section',
        text: { type: 'plain_text', text: 'No matching workflows found.' },
      })
    }
    for (const workflow of filteredWorkflows) {
      blocks.push(
        { type: 'header', text: { type: 'plain_text', text: workflow.name } },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: workflow.description },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Edit' },
              url: `slack://app?id=${workflow.app_id}`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Run workflow' },
              action_id: 'run_workflow_home',
              value: JSON.stringify({ id: workflow.id }),
              style: 'primary',
            },
          ],
        }
      )
    }
  }

  return { type: 'home', blocks }
}
