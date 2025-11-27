import type { BlockElementAction, SlackAction } from '@slack/bolt'
import { getWorkflowById, updateWorkflow } from '../database/workflows'
import { getWorkflowSteps } from '../utils/workflows'
import { generateStepEditView, updateHomeTab } from './blocks'
import { startWorkflow } from './execute'
import slack from '../clients/slack'

export async function handleInteraction(interaction: SlackAction) {
  if (interaction.type === 'block_actions') {
    console.log(interaction)
    const action = interaction.actions[0]
    if (!action) return
    const actionId = action.action_id

    if (actionId.startsWith('update_input:')) {
      const [, workflowId, stepId, inputKey] = actionId.split(':')

      const workflow = await getWorkflowById(parseInt(workflowId!))
      if (!workflow || !workflow.access_token) return

      const steps = getWorkflowSteps(workflow)
      const stepIndex = steps.findIndex((s) => s.id === stepId)
      if (stepIndex < 0) return
      const step = steps[stepIndex]!

      const value = JSON.parse(getValue(action))

      if (value.type === 'text') {
        step.inputs[inputKey!] = value.text
      } else if (value.type === 'custom') {
        step.inputs[inputKey!] = ''
      }

      workflow.steps = JSON.stringify(steps)
      await updateWorkflow(workflow)

      await Promise.all([
        slack.views.update({
          token: workflow.access_token,
          view_id: interaction.view!.id,
          view: await generateStepEditView(workflow, stepIndex),
        }),
        updateHomeTab(workflow, interaction.user.id),
      ])
    } else if (actionId === 'run_workflow_home') {
      if (action.type !== 'button') return

      const { id } = JSON.parse(action.value!) as { id: number }
      const workflow = await getWorkflowById(id)
      if (!workflow) return

      await startWorkflow(workflow, interaction.user.id)
    } else if (actionId === 'edit_step') {
      if (action.type !== 'button') return

      const { workflowId, stepId } = JSON.parse(action.value!) as {
        workflowId: number
        stepId: string
      }
      const workflow = await getWorkflowById(workflowId)
      if (!workflow || !workflow.access_token) return

      const steps = getWorkflowSteps(workflow)
      const stepIndex = steps.findIndex((s) => s.id === stepId)
      if (stepIndex < 0) return

      await slack.views.open({
        token: workflow.access_token,
        trigger_id: interaction.trigger_id,
        view: await generateStepEditView(workflow, stepIndex),
      })
    }
  }
}

function getValue(action: BlockElementAction) {
  switch (action.type) {
    case 'static_select':
      return action.selected_option.value
    case 'users_select':
      return JSON.stringify({ type: 'text', text: action.selected_user })
    case 'conversations_select':
      return JSON.stringify({ type: 'text', text: action.selected_conversation })
    default:
      return ''
  }
}
