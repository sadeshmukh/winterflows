import slack from '../clients/slack'
import type { ExecutionContext } from './context'

export type DataType = 'user' | 'channel' | 'text' | 'rich_text'

export type StepFunction<
  Inputs extends Record<string, string> = Record<string, string>,
  Outputs = void
> = (ctx: ExecutionContext, inputs: Inputs) => Outputs | Promise<Outputs>

export type StepIOSpec<
  T extends Record<string, string> = Record<string, string>
> = {
  [K in keyof T]: {
    name: string
    type: DataType
    required: boolean
  }
}

type StepSpec<
  Inputs extends Record<string, string> = Record<string, string>,
  Outputs = void
> = {
  name: string
  inputs: StepIOSpec<Inputs>
} & (Outputs extends {} ? { outputs: StepIOSpec<Outputs> } : {})

export type WorkflowStepSpec<
  Inputs extends Record<string, string> = Record<string, string>,
  Outputs = void
> = {
  func: StepFunction<Inputs, Outputs>
} & StepSpec<Inputs, Outputs>

function defineStep<
  Inputs extends Record<string, string> = Record<string, string>,
  Outputs = void
>(
  func: StepFunction<Inputs, Outputs>,
  spec: StepSpec<Inputs, Outputs>
): WorkflowStepSpec<Inputs, Outputs> {
  return { func, ...spec }
}

// steps

async function sendMessageToUser(
  ctx: ExecutionContext,
  { user_id, message }: { user_id: string; message: string }
) {
  const msg = await slack.chat.postMessage({
    token: ctx.token,
    channel: user_id,
    blocks: [JSON.parse(message)],
  })
  return {
    ts: msg.ts!,
  }
}

// end steps

const steps = {
  'test-dm-user': defineStep(sendMessageToUser, {
    name: 'Send a message to a person',
    inputs: {
      user_id: {
        name: 'User',
        required: true,
        type: 'user',
      },
      message: {
        name: 'message',
        required: true,
        type: 'rich_text',
      },
    },
    outputs: {
      ts: {
        name: 'Timestamp of message',
        required: true,
        type: 'text',
      },
    },
  }),
} as const

export default steps
export type WorkflowStepMap = typeof steps
