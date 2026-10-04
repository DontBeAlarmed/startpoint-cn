import { getDb } from "../../../data/db"
import { getPlayerSync } from "../../../data/domains/player"
import { updatePlayerCharacterSync } from "../../../data/domains/character"
import { incrementActiveMissionInjectedExpCountSync } from "../../../data/domains/active_mission_counters"
import { publishActiveMissionOwnerStateWithinTransaction } from "../../mission/active-publication-owner"
import { createCharacterGrowthRequestContext } from "../request-context"
import { convergeBondTokenForExpWithinTransaction } from "../bond-token-qualification"
import type { BondTokenStatus } from "../model"
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
import { settleMissionCategories } from "../../mission/settlement"
import { getMissionCatalog } from "../../mission/mission-catalog"
import { getDegreeMissionIdsForConditionTypes } from "../../mission/degree-candidates"
import type { MissionSettlementResult } from "../../mission/settlement"
import { mutationContent } from "../node-command-support"

// 客户端等级称号族(3000=Lv60 / 3010=Lv80 / 3020=Lv100),经验注入同事务定向结算
const CHARACTER_LEVEL_DEGREE_IDS: readonly number[] = [3000, 3010, 3020]

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
    readonly bondTokens: ReadonlyMap<number, BondTokenStatus>
    readonly activeMissionList: readonly unknown[]
    readonly missionSettlement: MissionSettlementResult | null
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
        const bondConvergence = convergeBondTokenForExpWithinTransaction(
            command.playerId,
            command.characterId,
            context.bondTokens(),
            {
                rarity: before.rarity,
                beforeExp: before.exp,
                exp: calculation.afterExp,
                loadBoardFacts: () => {
                    const boardOneContent = mutationContent(command.characterId, 1)
                    return {
                        requiredNodeIds: [...Object.keys(boardOneContent.nodes).map(Number)],
                        learnedNodeIds: new Set(context.normalManaNodes().keys()),
                    }
                },
            },
        )
        const afterBondTokens = new Map(context.bondTokens())
        if (bondConvergence.granted) afterBondTokens.set(1, 1)
        incrementActiveMissionInjectedExpCountSync(command.playerId)
        // 角色等级是状态派生事实(无事件),注入跨过等级阈值后必须在同事务
        // 定向结算角色等级任务(cat1)与等级称号(cat5),否则任务奖励被推迟到
        // 下次进关/任务页才补发(2026-10-01 用户实测「进关才提示完成」)。
        // 注入还可能改变:Lv80 角色数(任务 36 族)、信赖证授予(0→1,
        // 任务 39 族)及其好感称号(cat5 condition 44 的信赖证分量与 Lv100
        // 分量都可能在注入中跨越)。
        const injectMissionIds = [
            ...getMissionCatalog().getDefinitionsByPattern("character_level"),
            ...getMissionCatalog().getDefinitionsByPattern("character_80_level"),
            ...getMissionCatalog().getDefinitionsByPattern("total_obtained_bond_token_count"),
        ].map(definition => definition.missionId)
        const favorDegreeMissionIds = getDegreeMissionIdsForConditionTypes(
            [44],
            [command.characterId],
        )
        const missionSettlement = settleMissionCategories(
            command.playerId,
            [
                { category: 1, missionIds: injectMissionIds },
                {
                    category: 5,
                    missionIds: [...CHARACTER_LEVEL_DEGREE_IDS, ...favorDegreeMissionIds],
                },
            ],
            command.evaluationTime,
        )
        const activeMission = publishActiveMissionOwnerStateWithinTransaction({
            playerId: command.playerId,
            now: command.evaluationTime,
            source: "character-growth/inject-exp",
        })
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
            bondTokens: afterBondTokens,
            activeMissionList: activeMission.activeMissionList,
            missionSettlement,
            replayed: false,
        } as InjectCharacterExpResult
    })()
}

export const injectCharacterExp = executeInjectCharacterExp
