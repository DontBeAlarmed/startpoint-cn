import { getDb } from "../../../data/db"
import { getPlayerSync } from "../../../data/domains/player"
import { updatePlayerCharacterSync } from "../../../data/domains/character"
import { incrementActiveMissionInjectedExpCountSync } from "../../../data/domains/active_mission_counters"
import { createCharacterGrowthRequestContext } from "../request-context"
import { growthError } from "../errors"
import {
    addSafeInteger,
    observedCore,
    updatePlayerExpPoolSync,
    validateEvaluationTime,
    validateGrowthCommandIds,
    validatePositiveAmount,
} from "../mutation-support"
import { calculateCharacterExpAfter } from "../exp-calculation"

export interface InjectCharacterExpCommand {
    readonly playerId: number
    readonly characterId: number
    readonly addExp: number
    readonly evaluationTime: Date
}

export interface InjectCharacterExpResult {
    readonly command: "inject_exp"
    readonly before: ReturnType<typeof observedCore>
    readonly after: ReturnType<typeof observedCore>
    readonly addExp: number
    readonly addExpList: readonly Record<string, number>[]
    readonly overflowExp: number
    readonly expPool: number
    readonly replayed: false
}

export function executeInjectCharacterExp(command: InjectCharacterExpCommand): InjectCharacterExpResult {
    validateGrowthCommandIds(command.playerId, command.characterId)
    validatePositiveAmount(command.addExp, "addExp")
    validateEvaluationTime(command.evaluationTime)
    return getDb().transaction(() => {
        const context = createCharacterGrowthRequestContext({
            playerId: command.playerId,
            characterId: command.characterId,
        })
        const before = context.character()
        const player = getPlayerSync(command.playerId)
        if (player === null) throw growthError("INVALID_GROWTH_STATE", "player is unavailable.")
        if (command.addExp > player.expPool) {
            throw growthError("INSUFFICIENT_EXP", "player does not have enough exp pool.")
        }
        const calculation = calculateCharacterExpAfter(
            before.rarity,
            before.overLimitStep,
            before.exp,
            command.addExp,
        )
        const afterPool = addSafeInteger(
            player.expPool - command.addExp,
            calculation.overflowExp,
            "player.expPool",
        )
        updatePlayerExpPoolSync(command.playerId, afterPool)
        updatePlayerCharacterSync(command.playerId, command.characterId, { exp: calculation.afterExp })
        incrementActiveMissionInjectedExpCountSync(command.playerId)
        return {
            command: "inject_exp",
            before,
            after: observedCore(before, { exp: calculation.afterExp }),
            addExp: command.addExp,
            addExpList: [{
                character_id: command.characterId,
                add_exp: calculation.characterExpAdded,
                after_exp: calculation.afterExp,
                add_exp_pool: calculation.overflowExp,
            }],
            overflowExp: calculation.overflowExp,
            expPool: afterPool,
            replayed: false,
        } as InjectCharacterExpResult
    })()
}

export const injectCharacterExp = executeInjectCharacterExp
