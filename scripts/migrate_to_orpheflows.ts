/**
 * migrate_to_orpheflows.ts
 *
 * Exports winterflows workflows to an orpheflows-compatible JSON file.
 * The output can be imported into orpheflows to migrate workflows to the new system.
 *
 * Usage: bun scripts/migrate_to_orpheflows.ts [output.json]
 *
 * Limitations / things that need manual review after migration:
 *   - References to previous step outputs ($!{outputs.stepId.key}) are converted to
 *     text_embed placeholders and WON'T work until manually replaced with the right
 *     orpheflows blocks in the visual editor.
 *   - Branching (conditional steps) is flagged with a warning; orpheflows handles
 *     conditions through logic blocks that need to be rebuilt manually.
 *   - Trigger types with no orpheflows equivalent (cron, time, member_join, modal)
 *     need a manual listener setup in orpheflows.
 *   - Usergroup steps, delay/stop utilities, pin-message, set-channel-topic, and
 *     channel-kick have no direct orpheflows equivalent and are skipped.
 */

import { sql } from 'bun'
import type { Workflow } from '../src/database/workflows'
import type { WorkflowVersion } from '../src/database/workflow_versions'
import type { Trigger } from '../src/database/triggers'

// ---------------------------------------------------------------------------
// Orpheflows block types
// ---------------------------------------------------------------------------

interface OrpheBlock {
  id: string
  type: string
  params: Record<string, OrpheParam>
}

type OrpheParam = OrpheBlock | OrpheBlock[] | string | null

// ---------------------------------------------------------------------------
// Step type mapping: winterflows type_id → orpheflows block type
// null means "no equivalent, skip with warning"
// ---------------------------------------------------------------------------

const STEP_TYPE_MAP: Record<string, string | null> = {
  // Messages
  'dm-user': 'messaging_send_text',
  'message-channel': 'messaging_send_text',
  'message-reply': 'messaging_reply',
  'react-message': 'messaging_add_reaction',
  'unreact-message': 'messaging_unreact',
  'send-ephemeral': 'messaging_send_text',
  // Forms
  'form-collect': 'form_present',
  // Channels
  'channel-invite': 'channel_invite',
  'channel-kick': null, // no equivalent in orpheflows
  'archive-channel': 'channel_archive',
  'create-public-channel': 'channel_create',
  'create-private-channel': 'channel_create',
  'pin-message': null, // no equivalent in orpheflows
  'set-channel-topic': null, // no equivalent in orpheflows
  // Converters
  'convert-user-to-id': 'user_to_id',
  'convert-user-to-ping': 'user_mention',
  'convert-user-id-to-user': 'user_from_id',
  'convert-channel-to-id': 'channel_to_id',
  'convert-id-to-channel': 'channel_from_id',
  'convert-message-to-ts': 'message_to_ts',
  'convert-message-to-channel': 'message_to_channel',
  'convert-channel-ts-to-message': 'message_from_ts',
  // Users
  'get-user-info': null, // no equivalent in orpheflows
  'usergroup-add': null, // no equivalent in orpheflows
  'usergroup-remove': null, // no equivalent in orpheflows
  'usergroup-create': null, // no equivalent in orpheflows
  // Utilities
  delay: null, // no equivalent in orpheflows
  stop: null, // no equivalent in orpheflows
}

// ---------------------------------------------------------------------------
// Value conversion helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return crypto.randomUUID()
}

/**
 * Wraps a plain string in a text_embed value block.
 */
function textBlock(text: string): OrpheBlock {
  return { id: uid(), type: 'text_embed', params: { TEXT: text } }
}

/**
 * Converts a winterflows input string to the appropriate orpheflows param.
 *
 * Handles the well-known $!{...} template patterns that can be converted
 * automatically.  Everything else is kept as a text_embed placeholder so
 * the workflow is importable even if not yet fully functional.
 */
function convertInput(value: string | undefined | null, warnings: string[]): OrpheParam {
  if (value == null || value === '') return null

  // Pure single-reference values
  if (/^\$!\{[^}]+\}$/.test(value)) {
    return convertRef(value, warnings)
  }

  // Mixed content (literal text interleaved with references) — keep as-is
  // and let the user update it in the orpheflows editor.
  if (value.includes('$!{')) {
    warnings.push(
      `Input "${value}" contains mixed template variables — kept as placeholder, needs manual update`
    )
  }

  return textBlock(value)
}

/**
 * Converts a pure $!{...} reference string to the matching orpheflows value block.
 */
function convertRef(ref: string, warnings: string[]): OrpheParam {
  if (ref === '$!{ctx.trigger_user_id}') {
    return { id: uid(), type: 'trigger_user', params: {} }
  }

  if (ref === '$!{ctx.trigger_user_ping}') {
    return {
      id: uid(),
      type: 'user_mention',
      params: { USER: { id: uid(), type: 'trigger_user', params: {} } },
    }
  }

  if (ref === '$!{trigger.message}') {
    return { id: uid(), type: 'trigger_message', params: {} }
  }

  if (ref === '$!{trigger.user}') {
    return { id: uid(), type: 'trigger_user', params: {} }
  }

  if (ref === '$!{trigger.trigger_id}') {
    return { id: uid(), type: 'trigger_trigger_id', params: {} }
  }

  // Step output references like $!{outputs.stepId.key} can't be automatically
  // converted because orpheflows has no equivalent "carry output forward"
  // mechanism for statement blocks.  Leave as a placeholder.
  if (ref.startsWith('$!{outputs.')) {
    warnings.push(
      `Output reference "${ref}" cannot be automatically converted — replace with the appropriate orpheflows block manually`
    )
    return textBlock(ref)
  }

  warnings.push(`Unknown template reference "${ref}" — kept as placeholder`)
  return textBlock(ref)
}

// ---------------------------------------------------------------------------
// Step conversion
// ---------------------------------------------------------------------------

interface ConvertedStep {
  block: OrpheBlock | null
  warnings: string[]
}

function convertStep(step: {
  id: string
  type_id: string
  branching?: string
  inputs: Record<string, string>
}): ConvertedStep {
  const warnings: string[] = []

  if (!(step.type_id in STEP_TYPE_MAP)) {
    warnings.push(`Unknown step type "${step.type_id}" — skipped`)
    return { block: null, warnings }
  }

  const orpheType = STEP_TYPE_MAP[step.type_id]
  if (orpheType === null) {
    warnings.push(`Step type "${step.type_id}" has no orpheflows equivalent — skipped`)
    return { block: null, warnings }
  }

  if (step.branching) {
    warnings.push(
      `Step "${step.id}" uses conditional branching — rebuild the condition using orpheflows logic blocks`
    )
  }

  const inp = (key: string) => convertInput(step.inputs[key], warnings)

  let params: Record<string, OrpheParam> = {}

  switch (step.type_id) {
    case 'dm-user':
      params = {
        MODE: 'user',
        USER: inp('user_id'),
        TEXT: inp('message'),
        EPHEMERAL: 'FALSE',
        COMPS: step.inputs.components ? inp('components') : null,
      }
      break

    case 'message-channel':
      params = {
        MODE: 'channel',
        LOC: inp('channel'),
        TEXT: inp('message'),
        EPHEMERAL: 'FALSE',
        COMPS: step.inputs.components ? inp('components') : null,
      }
      break

    case 'message-reply':
      params = {
        LOC: inp('thread'),
        TEXT: inp('message'),
        COMPS: step.inputs.components ? inp('components') : null,
      }
      break

    case 'send-ephemeral':
      params = {
        MODE: 'channel',
        LOC: inp('channel'),
        USER: inp('user'),
        TEXT: inp('message'),
        EPHEMERAL: 'TRUE',
      }
      break

    case 'react-message':
    case 'unreact-message':
      params = {
        MESSAGE: inp('message'),
        EMOJI: inp('emoji'),
      }
      break

    case 'form-collect':
      params = {
        TITLE: inp('title'),
        TEXT: inp('body'),
        QUESTIONS: inp('questions'),
        // trigger_id must come from a block — use the trigger_trigger_id value block
        TRIGGER_ID: { id: uid(), type: 'trigger_trigger_id', params: {} },
        OUTPUT: textBlock(`${step.id}.0`),
        TRIGGER_OUTPUT: textBlock(`${step.id}.trigger_id`),
      }
      break

    case 'channel-invite':
      params = {
        CHANNEL: inp('channel'),
        USER: inp('user'),
      }
      break

    case 'archive-channel':
      params = { CHANNEL: inp('channel') }
      break

    case 'create-public-channel':
      params = { NAME: inp('name'), MODE: 'public' }
      break

    case 'create-private-channel':
      params = { NAME: inp('name'), MODE: 'private' }
      break

    case 'convert-user-to-id':
    case 'convert-user-id-to-user':
      params = { USER: inp('value') }
      break

    case 'convert-user-to-ping':
      params = { USER: inp('value') }
      break

    case 'convert-channel-to-id':
    case 'convert-id-to-channel':
      params = { CHANNEL: inp('value') }
      break

    case 'convert-message-to-ts':
    case 'convert-message-to-channel':
      params = { MESSAGE: inp('message') }
      break

    case 'convert-channel-ts-to-message':
      params = {
        CHANNEL: inp('channel'),
        TS: inp('ts'),
      }
      break

    default:
      warnings.push(`No param mapping defined for step type "${step.type_id}" — skipped`)
      return { block: null, warnings }
  }

  return { block: { id: step.id, type: orpheType, params }, warnings }
}

// ---------------------------------------------------------------------------
// Trigger → listener conversion
// ---------------------------------------------------------------------------

interface ConvertedListener {
  event: string | null
  param: string | null
  paramNum: number | null
  warnings: string[]
}

function convertTrigger(trigger: Trigger | undefined): ConvertedListener {
  if (!trigger) {
    return {
      event: null,
      param: null,
      paramNum: null,
      warnings: ['No trigger found — set up a listener in orpheflows manually'],
    }
  }

  const warnings: string[] = []

  switch (trigger.type) {
    case 'message':
      return { event: 'message_received', param: trigger.val_string, paramNum: null, warnings }

    case 'reaction': {
      // winterflows stores "channel|reaction", orpheflows expects "channel;reaction"
      const param = trigger.val_string?.replace('|', ';') ?? null
      return { event: 'reaction_added', param, paramNum: null, warnings }
    }

    case 'time':
    case 'cron':
    case 'member_join':
    case 'modal':
      warnings.push(
        `Trigger type "${trigger.type}" has no orpheflows equivalent — set up the listener manually`
      )
      return { event: null, param: null, paramNum: null, warnings }

    default:
      warnings.push(`Unknown trigger type "${trigger.type}" — set up the listener manually`)
      return { event: null, param: null, paramNum: null, warnings }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function migrate() {
  const outputFile = process.argv[2] ?? 'orpheflows_migration.json'

  console.log('Fetching workflows from winterflows database…')
  const workflows = await sql<Workflow[]>`SELECT * FROM workflows ORDER BY id ASC`
  console.log(`Found ${workflows.length} workflow(s)`)

  const results = []

  for (const workflow of workflows) {
    console.log(`  Processing #${workflow.id}: ${workflow.name}`)

    const [version] = await sql<WorkflowVersion[]>`
      SELECT * FROM workflow_versions
      WHERE workflow_id = ${workflow.id}
      ORDER BY created_at DESC
      LIMIT 1
    `

    const [trigger] = await sql<Trigger[]>`
      SELECT * FROM triggers WHERE workflow_id = ${workflow.id}
    `

    const warnings: string[] = []
    const steps: Array<{
      id: string
      type_id: string
      branching?: string
      inputs: Record<string, string>
    }> = version ? JSON.parse(version.steps) : []

    // Convert each action step to an orpheflows block
    const actionBlocks: OrpheBlock[] = []
    for (const step of steps) {
      const { block, warnings: sw } = convertStep(step)
      warnings.push(...sw)
      if (block) actionBlocks.push(block)
    }

    // Wrap everything in a trigger block (orpheflows top-level structure)
    const triggerBlockId = uid()
    const triggerBlock: OrpheBlock = {
      id: triggerBlockId,
      type: 'trigger',
      params: { DO: actionBlocks },
    }

    const { event, param, paramNum, warnings: tw } = convertTrigger(trigger)
    warnings.push(...tw)

    results.push({
      workflow: {
        name: workflow.name,
        description: workflow.description,
        authorId: workflow.creator_user_id,
        appId: workflow.app_id,
        clientId: workflow.client_id,
        clientSecret: workflow.client_secret,
        signingSecret: workflow.signing_secret,
        // winterflows doesn't have a verification token; set manually after import
        verificationToken: '',
        blocks: null,
        code: JSON.stringify([triggerBlock]),
      },
      installation: workflow.access_token
        ? { userId: workflow.creator_user_id, token: workflow.access_token }
        : null,
      listener: event
        ? { event, param, paramNum, handler: triggerBlockId, data: null }
        : null,
      _source: { winterflows_id: workflow.id, version_id: version?.id ?? null },
      _warnings: warnings,
    })
  }

  const output = {
    exported_at: new Date().toISOString(),
    source: 'winterflows',
    target: 'orpheflows',
    workflows: results,
  }

  await Bun.write(outputFile, JSON.stringify(output, null, 2))

  const totalWarnings = results.reduce((sum, r) => sum + r._warnings.length, 0)
  console.log(`\nDone! Exported to ${outputFile}`)
  console.log(`  ${results.length} workflow(s), ${totalWarnings} warning(s)`)

  if (totalWarnings > 0) {
    console.log('\nWarnings:')
    for (const r of results) {
      if (r._warnings.length === 0) continue
      console.log(`  Workflow "${r.workflow.name}" (winterflows #${r._source.winterflows_id}):`)
      for (const w of r._warnings) {
        console.log(`    • ${w}`)
      }
    }
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
