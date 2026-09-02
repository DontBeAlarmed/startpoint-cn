import {
    RewardGrantContractValidationError,
    type RewardGrantCommand,
    type RewardGrantEntryOutcome,
    type RewardGrantExecutionPlan,
    type RewardGrantExecutionResult,
    type RewardGrantKnownPlayerState,
} from "./execution-contract"
import { aggregateRewardGrantAssets } from "./execution-assets"
import {
    createRewardGrantExecutionPlan,
    rewardGrantFingerprint,
} from "./execution-plan"
import {
    normalizeRewardGrantEntryOutcome,
    normalizeRewardGrantKnownPlayerState,
} from "./execution-outcome"
import { rewardGrantSnapshotsEqual } from "./snapshot"

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createRewardGrantExecutionResult(
    expectedPlayerId: number,
    plan: RewardGrantExecutionPlan,
    outcomes: readonly RewardGrantEntryOutcome[],
    playerAfter: RewardGrantKnownPlayerState,
): RewardGrantExecutionResult {
    const normalizedPlan = createRewardGrantExecutionPlan(plan.entries)
    if (!Array.isArray(outcomes) || outcomes.length !== normalizedPlan.entries.length) {
        throw new RewardGrantContractValidationError(-1, "entries")
    }
    for (let index = 0; index < outcomes.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(outcomes, index)) {
            throw new RewardGrantContractValidationError(index, "outcome")
        }
    }
    const entries = normalizedPlan.entries.map((reward, index) => Object.freeze({
        index,
        reward,
        outcome: normalizeRewardGrantEntryOutcome(reward, outcomes[index], index),
    }))
    const normalizedPlayerAfter = normalizeRewardGrantKnownPlayerState(
        expectedPlayerId,
        playerAfter,
    )
    const assets = aggregateRewardGrantAssets(entries)
    for (const currency of assets.currencies) {
        if (normalizedPlayerAfter[currency.currency] !== currency.afterAmount) {
            throw new RewardGrantContractValidationError(-1, "playerAfter")
        }
    }
    return Object.freeze({
        entries: Object.freeze(entries),
        assets,
        playerAfter: normalizedPlayerAfter,
    })
}

export function snapshotRewardGrantExecutionResultForPlan(
    expectedPlayerId: number,
    plan: RewardGrantExecutionPlan,
    value: unknown,
): RewardGrantExecutionResult {
    if (!isRecord(value) || !Array.isArray(value.entries)) {
        throw new RewardGrantContractValidationError(-1, "entries")
    }
    const normalizedPlan = createRewardGrantExecutionPlan(plan.entries)
    if (value.entries.length !== normalizedPlan.entries.length) {
        throw new RewardGrantContractValidationError(-1, "entries")
    }
    const outcomes: RewardGrantEntryOutcome[] = []
    for (let index = 0; index < value.entries.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value.entries, index)) {
            throw new RewardGrantContractValidationError(index, "entry")
        }
        const raw = value.entries[index]
        if (!isRecord(raw) || raw.index !== index) {
            throw new RewardGrantContractValidationError(index, "index")
        }
        const rewardPlan = createRewardGrantExecutionPlan([raw.reward as RewardGrantCommand])
        if (rewardGrantFingerprint(rewardPlan.entries[0])
            !== rewardGrantFingerprint(normalizedPlan.entries[index])) {
            throw new RewardGrantContractValidationError(index, "reward")
        }
        outcomes.push(raw.outcome as RewardGrantEntryOutcome)
    }
    const canonical = createRewardGrantExecutionResult(
        expectedPlayerId,
        normalizedPlan,
        outcomes,
        value.playerAfter as RewardGrantKnownPlayerState,
    )
    if (!rewardGrantSnapshotsEqual(value.assets, canonical.assets)) {
        throw new RewardGrantContractValidationError(-1, "assets")
    }
    return canonical
}
