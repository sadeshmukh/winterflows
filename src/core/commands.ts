import type { SlashCommand } from '@slack/bolt'
import type { AppsManifestCreateResponse } from '@slack/web-api'
import slack from '../clients/slack'
import { addWorkflow } from '../database/workflows'
import {
  generateManifest,
  getActiveConfigToken,
  getDMLink,
  respond,
} from '../utils/slack'

const { SLACK_BOT_TOKEN } = process.env

export async function handleCommand(payload: SlashCommand) {
  if (payload.command.endsWith('winterflows-create')) {
    return await handleCreateCommand(payload)
  } else if (payload.command.endsWith('winterflows')) {
    handleRootCommand(payload)
  }
  return ''
}

async function handleCreateCommand(payload: SlashCommand) {
  const name = payload.text
  if (!name) {
    return 'Please try again, giving your workflow a frosty name!'
  }

  const configToken = await getActiveConfigToken()
  if (!configToken) {
    return 'No app config token was set, or it has expired. Please contact the devs for assistance.'
  }

  ;(async () => {
    let app: AppsManifestCreateResponse
    try {
      app = await slack.apps.manifest.create({
        token: configToken,
        manifest: generateManifest(name),
      })
    } catch (e) {
      console.error('Failed to create app from manifest:', e)
      await respond(payload, 'There was an error creating the app.')
      return
    }

    await addWorkflow({
      name,
      app_id: app.app_id!,
      creator_user_id: payload.user_id,
      client_id: app.credentials!.client_id!,
      client_secret: app.credentials!.client_secret!,
      signing_secret: app.credentials!.signing_secret!,
      access_token: null,
    })

    const url = new URL(app.oauth_authorize_url!)
    url.searchParams.set('state', app.app_id!)

    await respond(payload, {
      text: `To complete workflow setup, visit <${url.toString()}|this frosty link> and install the app.`,
    })
  })()
}

async function handleRootCommand(payload: SlashCommand) {
  const url = await getDMLink(payload.user_id, SLACK_BOT_TOKEN!)
  await respond(payload, {
    text: `\
:hyper-dino-wave: Hi, and welcome to Winterflows!

I'm here to replace Slack workflows as the long, cold winter of classic workflows settles in soon...

To get started, <${url}|head over to my snowy app home>, or use the \`/winterflows-create\` command to create your first frosty workflow!`,
  })
}
