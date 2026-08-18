import {
    planAwakeManaNodeMutation,
    planLearnManaNodeMutation,
    type AwakeManaNodeMutationInput,
    type LearnManaNodeMutationInput,
    type ManaNodeMutationPlan,
} from "./character-mana-mutation-plan"

declare const learnInput: LearnManaNodeMutationInput
declare const awakeInput: AwakeManaNodeMutationInput

const learnPlan: ManaNodeMutationPlan = planLearnManaNodeMutation(learnInput)
const awakePlan: ManaNodeMutationPlan = planAwakeManaNodeMutation(awakeInput)
const learned: readonly number[] = learnPlan.finalLearnedNodeIds
const awakeLevel: number = awakePlan.finalAwakeLevels["1"]
const responseId: number = awakePlan.responseNodeEntries[0].multiplied_id

void learned
void awakeLevel
void responseId
