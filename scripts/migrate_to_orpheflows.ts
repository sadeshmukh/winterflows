/**
 * migrate_to_orpheflows.ts
 *
 * Exports winterflows workflows to orpheflows-compatible format, producing both:
 *   - Blockly workspace JSON (`blocks` column) — loadable in the visual editor
 *   - Orphejson code (`code` column) — executable by the orpheflows engine
 *
 * Usage: bun scripts/migrate_to_orpheflows.ts [output.json]
 *
 * Step outputs ($!{outputs.X.Y}) are carried forward using Blockly variables:
 *   - Steps that produce referenced outputs use the value-block variant
 *     wrapped in variables_set.
 *   - Later references become variables_get blocks.
 *
 * Branching (step.branching) is converted to controls_if blocks.
 *
 * Limitations (flagged as _warnings in output):
 *   - rich_text inputs are kept as raw JSON strings; simplify in editor
 *   - Mixed $!{} templates in a single string are kept as text_embed placeholders
 *   - Trigger types cron/time/member_join/modal need manual listener setup
 *   - Steps with no equivalent (usergroup-*, pin-message, set-channel-topic,
 *     channel-kick, delay, stop, get-user-info) are skipped
 *   - Button interaction outputs (component, user from dm-user) cannot be
 *     migrated — the interaction model is fundamentally different
 */

import { sql } from 'bun'
import type { Workflow } from '../src/database/workflows'
import type { WorkflowVersion } from '../src/database/workflow_versions'
import type { Trigger } from '../src/database/triggers'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A winterflows step as stored in workflow_versions.steps */
interface WFStep {
  id: string
  type_id: string
  branching?: string
  inputs: Record<string, string>
}

// === Orphejson types (flat code array for the execution engine) ===

interface CodeBlock {
  id: string
  type: string
  params: Record<string, CodeParam>
}
type CodeParam = CodeBlock | CodeBlock[] | string | null

// === Blockly workspace JSON types ===

interface BlocklyWorkspace {
  blocks: { languageVersion: 0; blocks: BlocklyBlock[] }
  variables: BlocklyVariable[]
}

interface BlocklyBlock {
  type: string
  id: string
  x?: number
  y?: number
  extraState?: Record<string, unknown>
  fields?: Record<string, unknown>
  inputs?: Record<string, { block: BlocklyBlock } | { shadow: BlocklyBlock }>
  next?: { block: BlocklyBlock }
}

interface BlocklyVariable {
  name: string
  id: string
}

// ---------------------------------------------------------------------------
// Step classification
// ---------------------------------------------------------------------------

/** null = no orpheflows equivalent */
const STEP_MAP: Record<
  string,
  | null
  | {
      /** orpheflows block type for the value-block variant (produces output) */
      value?: string
      /** orpheflows block type for the statement-block variant */
      stmt?: string
      /** is this purely a value block with no side effects? */
      pureValue?: boolean
    }
> = {
  // Messages — value variant returns the sent message reference
  'dm-user': { value: 'messaging_send_v1', stmt: 'messaging_send_v1_stmt' },
  'message-channel': { value: 'messaging_send_v1', stmt: 'messaging_send_v1_stmt' },
  'message-reply': { value: 'messaging_send_v1', stmt: 'messaging_send_v1_stmt' },
  'send-ephemeral': { stmt: 'messaging_send_v1_stmt' }, // ephemeral returns ''
  // Reactions — statement only
  'react-message': { stmt: 'messaging_add_reaction' },
  'unreact-message': { stmt: 'messaging_unreact' },
  // Forms
  'form-collect': { stmt: 'form_present' },
  // Channels
  'channel-invite': { stmt: 'channel_invite' },
  'archive-channel': { stmt: 'channel_archive' },
  'create-public-channel': { value: 'channel_create' },
  'create-private-channel': { value: 'channel_create' },
  // Converters — pure value blocks, no side effects
  'convert-user-to-id': { value: 'user_to_id', pureValue: true },
  'convert-user-to-ping': { value: 'user_mention', pureValue: true },
  'convert-user-id-to-user': { value: 'user_from_id', pureValue: true },
  'convert-channel-to-id': { value: 'channel_to_id', pureValue: true },
  'convert-id-to-channel': { value: 'channel_from_id', pureValue: true },
  'convert-message-to-ts': { value: 'message_to_ts', pureValue: true },
  'convert-message-to-channel': { value: 'message_to_channel', pureValue: true },
  'convert-channel-ts-to-message': { value: 'message_from_ts', pureValue: true },
  // No equivalent
  'channel-kick': null,
  'pin-message': null,
  'set-channel-topic': null,
  'get-user-info': null,
  'usergroup-add': null,
  'usergroup-remove': null,
  'usergroup-create': null,
  delay: null,
  stop: null,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _counter = 0
function uid(): string {
  return crypto.randomUUID()
}

function varId(name: string): string {
  return `var_${name.replace(/\./g, '_')}_${_counter++}`
}

// ---------------------------------------------------------------------------
// Collect output references across all steps
// ---------------------------------------------------------------------------

/** Returns a Set of "stepId.outputKey" strings that are referenced. */
function collectOutputRefs(steps: WFStep[]): Set<string> {
  const refs = new Set<string>()
  const pattern = /\$!\{outputs\.([^}]+)\}/g
  for (const step of steps) {
    for (const value of Object.values(step.inputs)) {
      if (!value) continue
      for (const m of value.matchAll(pattern)) {
        refs.add(m[1]) // e.g. "step1.message"
      }
    }
    if (step.branching) {
      for (const m of step.branching.matchAll(pattern)) {
        refs.add(m[1])
      }
    }
  }
  return refs
}

// ---------------------------------------------------------------------------
// Input conversion → value blocks
// ---------------------------------------------------------------------------

/**
 * Builds a value block (both CodeBlock and BlocklyBlock) for a winterflows
 * input string.  Returns both representations at once.
 */
function convertInput(
  value: string | undefined | null,
  warnings: string[]
): { code: CodeParam; blockly: BlocklyBlock | null } {
  if (value == null || value === '') return { code: null, blockly: null }

  // Pure single reference
  if (/^\$!\{[^}]+\}$/.test(value)) {
    return convertRef(value, warnings)
  }

  // Mixed templates
  if (value.includes('$!{')) {
    warnings.push(`Mixed template "${value}" — kept as text_embed placeholder, needs manual update`)
  }

  return makeText(value)
}

function makeText(text: string): { code: CodeBlock; blockly: BlocklyBlock } {
  const id = uid()
  return {
    code: { id, type: 'text', params: { TEXT: text } },
    blockly: { type: 'text', id, fields: { TEXT: text } },
  }
}

function convertRef(
  ref: string,
  warnings: string[]
): { code: CodeBlock; blockly: BlocklyBlock } {
  if (ref === '$!{ctx.trigger_user_id}' || ref === '$!{trigger.user}') {
    const id = uid()
    return {
      code: { id, type: 'trigger_user', params: {} },
      blockly: { type: 'trigger_user', id },
    }
  }

  if (ref === '$!{ctx.trigger_user_ping}') {
    const id = uid()
    const inner = convertRef('$!{ctx.trigger_user_id}', warnings)
    return {
      code: { id, type: 'user_mention', params: { USER: inner.code } },
      blockly: { type: 'user_mention', id, inputs: { USER: { block: inner.blockly } } },
    }
  }

  if (ref === '$!{trigger.message}') {
    const id = uid()
    return {
      code: { id, type: 'trigger_message', params: {} },
      blockly: { type: 'trigger_message', id },
    }
  }

  if (ref === '$!{trigger.trigger_id}') {
    const id = uid()
    return {
      code: { id, type: 'trigger_trigger_id', params: {} },
      blockly: { type: 'trigger_trigger_id', id },
    }
  }

  // $!{outputs.stepId.key} → variables_get
  const outputMatch = ref.match(/^\$!\{outputs\.(.+)\}$/)
  if (outputMatch) {
    const varName = outputMatch[1]
    const id = uid()
    const vId = varId(varName)
    return {
      code: { id, type: 'variables_get', params: { VAR: varName } },
      blockly: {
        type: 'variables_get',
        id,
        fields: { VAR: { id: vId, name: varName, type: '' } },
      },
    }
  }

  warnings.push(`Unknown reference "${ref}" — kept as text_embed`)
  return makeText(ref)
}

// ---------------------------------------------------------------------------
// Build value block for a step's core action (messaging_send_v1, etc.)
// Returns both code and blockly representations.
// ---------------------------------------------------------------------------

function buildValueBlock(
  step: WFStep,
  blockType: string,
  warnings: string[]
): { code: CodeBlock; blockly: BlocklyBlock } {
  const id = step.id
  const codeParams: Record<string, CodeParam> = {}
  const blocklyFields: Record<string, unknown> = {}
  const blocklyInputs: Record<string, { block: BlocklyBlock }> = {}
  let extraState: Record<string, unknown> | undefined

  function addValueInput(name: string, inputKey: string) {
    const { code, blockly } = convertInput(step.inputs[inputKey], warnings)
    if (code) codeParams[name] = code
    if (blockly) blocklyInputs[name] = { block: blockly }
  }

  function addField(name: string, value: string) {
    codeParams[name] = value
    blocklyFields[name] = value
  }

  function addEmptyList(name: string) {
    const listId = uid()
    codeParams[name] = { id: listId, type: 'lists_create_with', params: {} }
    blocklyInputs[name] = {
      block: { type: 'lists_create_with', id: listId, extraState: { itemCount: 0 } },
    }
  }

  switch (step.type_id) {
    case 'dm-user': {
      addField('MODE', 'USER')
      addValueInput('LOC', 'user_id')
      addValueInput('TEXT', 'message')
      if (step.inputs.components) addValueInput('COMPS', 'components')
      else addEmptyList('COMPS')
      extraState = { mode: 'USER', ephemeral: false }
      break
    }
    case 'message-channel': {
      addField('MODE', 'CHANNEL')
      addValueInput('LOC', 'channel')
      addValueInput('TEXT', 'message')
      if (step.inputs.components) addValueInput('COMPS', 'components')
      else addEmptyList('COMPS')
      extraState = { mode: 'CHANNEL', ephemeral: false }
      break
    }
    case 'message-reply': {
      addField('MODE', 'THREAD')
      addValueInput('LOC', 'thread')
      addValueInput('TEXT', 'message')
      if (step.inputs.components) addValueInput('COMPS', 'components')
      else addEmptyList('COMPS')
      extraState = { mode: 'THREAD', ephemeral: false }
      break
    }
    case 'send-ephemeral': {
      addField('MODE', 'CHANNEL')
      addField('EPHEMERAL', 'TRUE')
      addValueInput('LOC', 'channel')
      addValueInput('TEXT', 'message')
      addValueInput('USER', 'user')
      if (step.inputs.components) addValueInput('COMPS', 'components')
      else addEmptyList('COMPS')
      extraState = { mode: 'CHANNEL', ephemeral: true }
      break
    }
    case 'react-message':
    case 'unreact-message':
      addValueInput('MESSAGE', 'message')
      addValueInput('EMOJI', 'emoji')
      break
    case 'form-collect':
      addValueInput('TITLE', 'title')
      addValueInput('TEXT', 'body')
      addValueInput('QUESTIONS', 'questions')
      // trigger_id comes from trigger_trigger_id value block
      {
        const trigId = uid()
        codeParams['TRIGGER_ID'] = { id: trigId, type: 'trigger_trigger_id', params: {} }
        blocklyInputs['TRIGGER_ID'] = { block: { type: 'trigger_trigger_id', id: trigId } }
      }
      // OUTPUT and TRIGGER_OUTPUT are field_variable in Blockly
      codeParams['OUTPUT'] = `${step.id}.responses`
      codeParams['TRIGGER_OUTPUT'] = `${step.id}.trigger_id`
      blocklyFields['OUTPUT'] = {
        id: varId(`${step.id}.responses`),
        name: `${step.id}.responses`,
        type: '',
      }
      blocklyFields['TRIGGER_OUTPUT'] = {
        id: varId(`${step.id}.trigger_id`),
        name: `${step.id}.trigger_id`,
        type: '',
      }
      break
    case 'channel-invite':
      addValueInput('USER', 'user')
      addValueInput('CHANNEL', 'channel')
      break
    case 'archive-channel':
      addValueInput('CHANNEL', 'channel')
      break
    case 'create-public-channel':
      addField('MODE', 'PUBLIC')
      addValueInput('NAME', 'name')
      break
    case 'create-private-channel':
      addField('MODE', 'PRIVATE')
      addValueInput('NAME', 'name')
      break
    case 'convert-user-to-id':
      addValueInput('USER', 'value')
      break
    case 'convert-user-id-to-user':
      addValueInput('ID', 'value')
      break
    case 'convert-user-to-ping':
      addValueInput('USER', 'value')
      break
    case 'convert-channel-to-id':
      addValueInput('CHANNEL', 'value')
      break
    case 'convert-id-to-channel':
      addValueInput('ID', 'value')
      break
    case 'convert-message-to-ts':
    case 'convert-message-to-channel':
      addValueInput('MESSAGE', 'message')
      break
    case 'convert-channel-ts-to-message':
      addValueInput('CHANNEL', 'channel')
      addValueInput('TS', 'ts')
      break
    default:
      warnings.push(`No param mapping for "${step.type_id}"`)
  }

  const codeBlock: CodeBlock = { id, type: blockType, params: codeParams }
  const blocklyBlock: BlocklyBlock = { type: blockType, id }
  if (extraState) blocklyBlock.extraState = extraState
  if (Object.keys(blocklyFields).length) blocklyBlock.fields = blocklyFields
  if (Object.keys(blocklyInputs).length) blocklyBlock.inputs = blocklyInputs

  return { code: codeBlock, blockly: blocklyBlock }
}

// ---------------------------------------------------------------------------
// Convert a winterflows step to statement block(s)
// Returns code blocks (flat array) and a single Blockly statement block.
// ---------------------------------------------------------------------------

interface ConvertedStatement {
  codeBlocks: CodeBlock[]
  blocklyBlock: BlocklyBlock | null
  variables: BlocklyVariable[]
  warnings: string[]
}

function convertStepToStatement(
  step: WFStep,
  outputRefs: Set<string>
): ConvertedStatement {
  const warnings: string[] = []
  const variables: BlocklyVariable[] = []

  const spec = STEP_MAP[step.type_id]
  if (spec === undefined) {
    warnings.push(`Unknown step type "${step.type_id}" — skipped`)
    return { codeBlocks: [], blocklyBlock: null, variables, warnings }
  }
  if (spec === null) {
    warnings.push(`Step type "${step.type_id}" has no orpheflows equivalent — skipped`)
    return { codeBlocks: [], blocklyBlock: null, variables, warnings }
  }

  // Check if any of this step's outputs are referenced
  const needsOutput = [...outputRefs].some((ref) => ref.startsWith(step.id + '.'))

  // For button interaction outputs — can't migrate
  if (
    needsOutput &&
    ['dm-user', 'message-channel', 'message-reply'].includes(step.type_id)
  ) {
    const usedKeys = [...outputRefs]
      .filter((r) => r.startsWith(step.id + '.'))
      .map((r) => r.split('.').slice(1).join('.'))
    for (const key of usedKeys) {
      if (key === 'component' || key === 'user') {
        warnings.push(
          `Button interaction output "${step.id}.${key}" cannot be migrated — orpheflows handles button interactions differently`
        )
      }
    }
  }

  // Determine block type and strategy
  const useValue = needsOutput && spec.value
  const blockType = useValue ? spec.value! : spec.stmt ?? spec.value!

  // Pure value blocks with no references → skip entirely (no side effects)
  if (spec.pureValue && !needsOutput) {
    return { codeBlocks: [], blocklyBlock: null, variables, warnings }
  }

  // Build the core action block
  const { code: actionCode, blockly: actionBlockly } = buildValueBlock(
    step,
    blockType,
    warnings
  )

  // Handle branching → wrap in controls_if
  let codeBlocks: CodeBlock[]
  let blocklyBlock: BlocklyBlock

  if (useValue) {
    // Wrap in variables_set to capture the output
    const outputKey = [...outputRefs]
      .filter((r) => r.startsWith(step.id + '.'))
      .find((r) => r.endsWith('.message') || r.endsWith('.id') || r.endsWith('.value'))
      ?? `${step.id}.message`

    const setId = uid()
    const vId = varId(outputKey)
    variables.push({ name: outputKey, id: vId })

    codeBlocks = [
      {
        id: setId,
        type: 'variables_set',
        params: { VAR: outputKey, VALUE: actionCode },
      },
    ]
    blocklyBlock = {
      type: 'variables_set',
      id: setId,
      fields: { VAR: { id: vId, name: outputKey, type: '' } },
      inputs: { VALUE: { block: actionBlockly } },
    }
  } else if (spec.pureValue) {
    // Pure value block whose output IS needed → wrap in variables_set
    const outputKey = `${step.id}.value`
    const setId = uid()
    const vId = varId(outputKey)
    variables.push({ name: outputKey, id: vId })

    codeBlocks = [
      {
        id: setId,
        type: 'variables_set',
        params: { VAR: outputKey, VALUE: actionCode },
      },
    ]
    blocklyBlock = {
      type: 'variables_set',
      id: setId,
      fields: { VAR: { id: vId, name: outputKey, type: '' } },
      inputs: { VALUE: { block: actionBlockly } },
    }
  } else if (blockType === spec.value && !spec.stmt) {
    // Value block with side effects but no statement variant → wrap in ignore_output
    const ignoreId = uid()
    codeBlocks = [
      {
        id: ignoreId,
        type: 'ignore_output',
        params: { VALUE: actionCode },
      },
    ]
    blocklyBlock = {
      type: 'ignore_output',
      id: ignoreId,
      inputs: { VALUE: { block: actionBlockly } },
    }
  } else {
    // Regular statement block
    codeBlocks = [actionCode]
    blocklyBlock = actionBlockly
  }

  // form_present stores outputs in Blockly variables automatically
  if (step.type_id === 'form-collect') {
    const respVar = `${step.id}.responses`
    const trigVar = `${step.id}.trigger_id`
    variables.push(
      { name: respVar, id: varId(respVar) },
      { name: trigVar, id: varId(trigVar) }
    )
  }

  // Handle branching → wrap in controls_if
  if (step.branching) {
    try {
      const { left, op, right } = JSON.parse(step.branching) as {
        left: string
        op: string
        right: string
      }

      const leftVal = convertInput(left, warnings)
      const rightVal = convertInput(right, warnings)
      const orpheOp = op === '==' ? 'EQ' : 'NEQ'

      const condId = uid()
      const ifId = uid()

      // Condition value block
      const condCode: CodeBlock = {
        id: condId,
        type: 'logic_compare',
        params: {
          OP: orpheOp,
          A: leftVal.code ?? { id: uid(), type: 'text', params: { TEXT: '' } },
          B: rightVal.code ?? { id: uid(), type: 'text', params: { TEXT: '' } },
        },
      }
      const condBlockly: BlocklyBlock = {
        type: 'logic_compare',
        id: condId,
        fields: { OP: orpheOp },
        inputs: {
          A: { block: leftVal.blockly ?? { type: 'text', id: uid(), fields: { TEXT: '' } } },
          B: { block: rightVal.blockly ?? { type: 'text', id: uid(), fields: { TEXT: '' } } },
        },
      }

      // Wrap: controls_if with DO0 containing original statement blocks
      const wrappedCode: CodeBlock = {
        id: ifId,
        type: 'controls_if',
        params: {
          IF0: condCode,
          DO0: codeBlocks,
        },
      }
      const wrappedBlockly: BlocklyBlock = {
        type: 'controls_if',
        id: ifId,
        inputs: {
          IF0: { block: condBlockly },
          DO0: { block: blocklyBlock },
        },
      }

      codeBlocks = [wrappedCode]
      blocklyBlock = wrappedBlockly
    } catch {
      warnings.push(
        `Could not parse branching for step "${step.id}" — branching skipped`
      )
    }
  }

  return { codeBlocks, blocklyBlock, variables, warnings }
}

// ---------------------------------------------------------------------------
// Trigger conversion
// ---------------------------------------------------------------------------

interface TriggerInfo {
  /** MANUAL, REACTION, MESSAGE, DM, BUTTON, SLASH, etc. */
  blocklyTriggerType: string
  /** Extra fields on the trigger block (CHANNEL, EMOJI, ACTIONID, NAME) */
  triggerFields: Record<string, string>
  /** Listener event for the listeners table */
  event: string | null
  /** Listener param */
  param: string | null
  paramNum: number | null
  warnings: string[]
}

function convertTrigger(trigger: Trigger | undefined): TriggerInfo {
  if (!trigger) {
    return {
      blocklyTriggerType: 'MANUAL',
      triggerFields: {},
      event: null,
      param: null,
      paramNum: null,
      warnings: ['No trigger found — defaults to MANUAL; set up a listener in orpheflows if needed'],
    }
  }

  const warnings: string[] = []

  switch (trigger.type) {
    case 'message':
      return {
        blocklyTriggerType: 'MESSAGE',
        triggerFields: { CHANNEL: trigger.val_string ?? 'C' },
        event: 'message_received',
        param: trigger.val_string,
        paramNum: null,
        warnings,
      }

    case 'reaction': {
      // winterflows: "channel|reaction", orpheflows listener: "channel;reaction"
      const parts = trigger.val_string?.split('|') ?? ['C', 'yay']
      return {
        blocklyTriggerType: 'REACTION',
        triggerFields: { CHANNEL: parts[0], EMOJI: parts[1] ?? 'yay' },
        event: 'reaction_added',
        param: parts.join(';'),
        paramNum: null,
        warnings,
      }
    }

    case 'time':
    case 'cron':
      warnings.push(
        `Trigger type "${trigger.type}" has no orpheflows equivalent — set up manually`
      )
      return {
        blocklyTriggerType: 'MANUAL',
        triggerFields: {},
        event: null,
        param: null,
        paramNum: null,
        warnings,
      }

    case 'member_join':
      warnings.push(
        'Trigger type "member_join" has no orpheflows equivalent — set up manually'
      )
      return {
        blocklyTriggerType: 'MANUAL',
        triggerFields: {},
        event: null,
        param: null,
        paramNum: null,
        warnings,
      }

    case 'modal':
      // Modal triggers are internal (button click → form), not a top-level trigger
      return {
        blocklyTriggerType: 'MANUAL',
        triggerFields: {},
        event: null,
        param: null,
        paramNum: null,
        warnings: [
          'Modal trigger is internal — the workflow will default to MANUAL trigger',
        ],
      }

    default:
      warnings.push(`Unknown trigger type "${trigger.type}" — defaults to MANUAL`)
      return {
        blocklyTriggerType: 'MANUAL',
        triggerFields: {},
        event: null,
        param: null,
        paramNum: null,
        warnings,
      }
  }
}

// ---------------------------------------------------------------------------
// Chain Blockly statement blocks via `next`
// ---------------------------------------------------------------------------

function chainBlockly(blocks: BlocklyBlock[]): BlocklyBlock | null {
  if (blocks.length === 0) return null
  for (let i = blocks.length - 2; i >= 0; i--) {
    blocks[i].next = { block: blocks[i + 1] }
  }
  return blocks[0]
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

    const allWarnings: string[] = []
    const allVariables: BlocklyVariable[] = []
    const steps: WFStep[] = version ? JSON.parse(version.steps) : []

    // 1. Collect all output references
    const outputRefs = collectOutputRefs(steps)

    // 2. Convert trigger
    const triggerInfo = convertTrigger(trigger)
    allWarnings.push(...triggerInfo.warnings)

    // 3. Convert each step to statement block(s)
    const codeStatements: CodeBlock[] = []
    const blocklyStatements: BlocklyBlock[] = []

    for (const step of steps) {
      const { codeBlocks, blocklyBlock, variables, warnings } =
        convertStepToStatement(step, outputRefs)
      allWarnings.push(...warnings)
      allVariables.push(...variables)
      codeStatements.push(...codeBlocks)
      if (blocklyBlock) blocklyStatements.push(blocklyBlock)
    }

    // Also add variables referenced by variables_get that aren't yet declared
    for (const ref of outputRefs) {
      if (!allVariables.some((v) => v.name === ref)) {
        allVariables.push({ name: ref, id: varId(ref) })
      }
    }

    // 4. Build trigger block

    const triggerBlockId = uid()

    // -- Orphejson code: flat array starting with trigger, then statements
    const triggerCodeParams: Record<string, CodeParam> = {
      TRIGGER: triggerInfo.blocklyTriggerType,
    }
    for (const [k, v] of Object.entries(triggerInfo.triggerFields)) {
      triggerCodeParams[k] = v
    }
    const triggerCodeBlock: CodeBlock = {
      id: triggerBlockId,
      type: 'trigger',
      params: triggerCodeParams,
    }
    const codeArray: CodeBlock[] = [triggerCodeBlock, ...codeStatements]

    // -- Blockly workspace: trigger block with next chain
    const triggerBlocklyFields: Record<string, string> = {
      TRIGGER: triggerInfo.blocklyTriggerType,
      ...triggerInfo.triggerFields,
    }
    const triggerBlockly: BlocklyBlock = {
      type: 'trigger',
      id: triggerBlockId,
      x: 50,
      y: 50,
      extraState: { trigger: triggerInfo.blocklyTriggerType },
      fields: triggerBlocklyFields,
    }

    const firstStatement = chainBlockly(blocklyStatements)
    if (firstStatement) {
      triggerBlockly.next = { block: firstStatement }
    }

    const workspace: BlocklyWorkspace = {
      blocks: { languageVersion: 0, blocks: [triggerBlockly] },
      variables: allVariables,
    }

    // 5. Assemble result
    results.push({
      workflow: {
        name: workflow.name,
        description: workflow.description,
        authorId: workflow.creator_user_id,
        appId: workflow.app_id,
        clientId: workflow.client_id,
        clientSecret: workflow.client_secret,
        signingSecret: workflow.signing_secret,
        verificationToken: '', // not in winterflows; set manually after import
        blocks: JSON.stringify(workspace),
        code: JSON.stringify(codeArray),
      },
      installation: workflow.access_token
        ? { userId: workflow.creator_user_id, token: workflow.access_token }
        : null,
      listener: triggerInfo.event
        ? {
            event: triggerInfo.event,
            param: triggerInfo.param,
            paramNum: triggerInfo.paramNum,
            handler: triggerBlockId,
            data: null,
          }
        : null,
      _source: { winterflows_id: workflow.id, version_id: version?.id ?? null },
      _warnings: allWarnings,
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
      console.log(
        `  Workflow "${r.workflow.name}" (winterflows #${r._source.winterflows_id}):`
      )
      for (const w of r._warnings) {
        console.log(`    - ${w}`)
      }
    }
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
