import type { Player } from "../../data/types"
import { updatePlayerSync } from "../../data/domains/player"
import type { ActiveMissionReward } from "./rewards"
import { givePlayerDegreeSync } from "../../data/domains/degree"
import { addPlayerPassCardPointWithChangeSync } from "../../data/domains/pass-card"
import { getPassCardEventDefinition } from "../pass-card"
import { getFactKeyId, normalizeFactKey, type FactKey } from "./facts/fact-key"
import { RewardType } from "../types/rewards"
import {
    assertRewardGrantExecutionTransactionOwnerSync,
    collectRewardGrantItemOverflowDispositions,
    createRewardGrantExecutionPlan,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    snapshotRewardGrantExecutionResultForPlan,
    type RewardGrantCommand,
    type RewardGrantExecutionPlan,
    type RewardGrantExecutionResult,
    type RewardGrantKnownPlayerState,
} from "../reward-grant"
import type { PlannedItemOverflowDisposition } from "../item-overflow"

type MissionRewardPlayer = Pick<
    Player,
    "id" | "freeVmoney" | "freeMana" | "expPool" | "totalManaObtained"
>

export interface MissionRewardGrantContext {
    passCardEventId?: number
    standardRewardGrant?: (
        plan: RewardGrantExecutionPlan,
        knownPlayerBefore: RewardGrantKnownPlayerState,
    ) => RewardGrantExecutionResult
}

export class MissionRewardGranter {
    readonly itemList: Record<string, number> = {}
    readonly degreeList: number[] = []
    readonly passCardPoints: Record<string, number> = {}
    private readonly characterMap = new Map<number, Object>()
    private readonly equipmentMap = new Map<number, Object>()
    private freeVmoney: number
    private freeMana: number
    private expPool: number
    private totalManaGained = 0
    private latestDegreeId: number | undefined
    private readonly invalidatedFacts = new Map<string, FactKey>()
    private standardRewardGranted = false
    private readonly pendingStandardEntries: RewardGrantCommand[] = []
    private readonly itemOverflowDispositionList: PlannedItemOverflowDisposition[] = []
    private standardRewardGrant: NonNullable<MissionRewardGrantContext["standardRewardGrant"]>
    private standardRewardGrantRequiresTransaction = true

    constructor(private readonly playerId: number, private readonly player: MissionRewardPlayer) {
        if (player.id !== playerId) {
            throw new Error(`Mission reward Player ${player.id} does not match owner ${playerId}`)
        }
        this.freeVmoney = player.freeVmoney
        this.freeMana = player.freeMana
        this.expPool = player.expPool
        this.standardRewardGrant = (plan, knownPlayerBefore) => (
            executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                this.playerId,
                plan,
                knownPlayerBefore,
            )
        )
    }

    grant(rewards: ActiveMissionReward[], context: MissionRewardGrantContext = {}): readonly FactKey[] {
        if (context.standardRewardGrant !== undefined) {
            this.standardRewardGrant = context.standardRewardGrant
            this.standardRewardGrantRequiresTransaction = false
        }
        if (this.standardRewardGrantRequiresTransaction
            && rewards.some(reward => this.canMutatePlayerState(reward, context))) {
            assertRewardGrantExecutionTransactionOwnerSync()
        }

        for (const reward of rewards) {
            const standardReward = this.toStandardRewardCommands(reward)
            if (standardReward.length > 0) {
                this.pendingStandardEntries.push(...standardReward)
                continue
            }
            switch (reward.kind) {
                case 0:
                    this.freeVmoney += reward.amount
                    break
                case 1:
                    break
                case 2:
                    break
                case 3:
                    this.freeMana += reward.amount
                    this.totalManaGained += reward.amount
                    break
                case 4:
                    break
                case 5:
                    this.expPool += reward.amount
                    break
                case 6:
                    if (reward.degreeId !== undefined
                        && !this.degreeList.includes(reward.degreeId)
                        && givePlayerDegreeSync(this.playerId, reward.degreeId)) {
                        this.degreeList.push(reward.degreeId)
                        this.latestDegreeId = reward.degreeId
                        this.addInvalidation({ kind: "player" })
                    }
                    break
                case 7:
                    if (reward.amount <= 0) break
                    if (context.passCardEventId === undefined) {
                        throw new Error("Pass card point reward is missing its event scope.")
                    }
                    const passCardEvent = getPassCardEventDefinition(context.passCardEventId)
                    if (!passCardEvent) {
                        throw new Error(`Pass card event ${context.passCardEventId} is missing.`)
                    }
                    const result = addPlayerPassCardPointWithChangeSync(
                        this.playerId,
                        context.passCardEventId,
                        reward.amount,
                        passCardEvent.thresholdPoint,
                    )
                    this.passCardPoints[String(context.passCardEventId)] = result.point
                    if (result.changed) {
                        this.addInvalidation({ kind: "passState", eventId: context.passCardEventId })
                    }
                    break
            }
        }
        return this.invalidatedFactKeys
    }

    private canMutatePlayerState(
        reward: ActiveMissionReward,
        context: MissionRewardGrantContext,
    ): boolean {
        switch (reward.kind) {
            case 0:
            case 3:
            case 5:
                return reward.amount !== 0
            case 1:
                return reward.itemId !== undefined && reward.amount > 0
            case 2:
                return reward.equipmentId !== undefined && reward.amount > 0
            case 4:
                return reward.characterId !== undefined && reward.amount > 0
            case 6:
                return reward.degreeId !== undefined
            case 7:
                return context.passCardEventId !== undefined && reward.amount > 0
            default:
                return false
        }
    }

    private flushStandardRewards(): void {
        if (this.pendingStandardEntries.length === 0) return
        const plan = createRewardGrantExecutionPlan(this.pendingStandardEntries)
        const grant = snapshotRewardGrantExecutionResultForPlan(
            this.playerId,
            plan,
            this.standardRewardGrant(
                plan,
                {
                    playerId: this.player.id,
                    freeMana: this.freeMana,
                    freeVmoney: this.freeVmoney,
                    expPool: this.expPool,
                },
            ),
        )
        this.pendingStandardEntries.length = 0
        this.standardRewardGranted = true
        this.itemOverflowDispositionList.push(...collectRewardGrantItemOverflowDispositions(grant))
        this.freeMana = grant.playerAfter.freeMana
        this.freeVmoney = grant.playerAfter.freeVmoney
        this.expPool = grant.playerAfter.expPool
        for (const item of grant.assets.items) {
            this.itemList[String(item.itemId)] = item.afterAmount
            this.invalidateItem(item.itemId)
        }
        for (const equipment of grant.assets.equipment) {
            this.equipmentMap.set(equipment.equipmentId, equipment.after)
            this.addInvalidation({ kind: "equipment" })
        }
        if (grant.assets.characters.length > 0) {
            this.addInvalidation({ kind: "characters" })
        }
        for (const character of grant.assets.characters) {
            this.characterMap.set(character.characterId, character.after)
        }
    }

    private toStandardRewardCommands(
        reward: ActiveMissionReward,
    ): RewardGrantCommand[] {
        if (reward.amount <= 0) return []
        switch (reward.kind) {
            case 0:
                return [{ type: RewardType.BEADS, count: reward.amount }]
            case 1:
                return reward.itemId === undefined ? [] : [{
                    type: RewardType.ITEM, id: reward.itemId, count: reward.amount,
                }]
            case 2:
                return reward.equipmentId === undefined ? [] : [{
                    type: RewardType.EQUIPMENT, id: reward.equipmentId, count: reward.amount,
                }]
            case 3:
                return [{ type: RewardType.MANA, count: reward.amount }]
            case 4:
                if (reward.characterId === undefined) return []
                const characterId = reward.characterId
                return Array.from(
                    { length: reward.amount },
                    () => ({ type: RewardType.CHARACTER, id: characterId }),
                )
            case 5:
                return [{ type: RewardType.EXP, count: reward.amount }]
            default:
                return []
        }
    }

    persistPlayer(): readonly FactKey[] {
        this.flushStandardRewards()
        if (!this.hasPlayerChanges()) return this.invalidatedFactKeys
        if (!this.standardRewardGranted) {
            updatePlayerSync({
                id: this.playerId,
                freeVmoney: this.freeVmoney,
                freeMana: this.freeMana,
                expPool: this.expPool,
                ...(this.latestDegreeId !== undefined ? { degreeId: this.latestDegreeId } : {}),
                totalManaObtained: (this.player.totalManaObtained ?? 0) + this.totalManaGained,
            })
        } else if (this.latestDegreeId !== undefined) {
            updatePlayerSync({ id: this.playerId, degreeId: this.latestDegreeId })
        }
        this.addInvalidation({ kind: "player" })
        return this.invalidatedFactKeys
    }

    get invalidatedFactKeys(): readonly FactKey[] {
        return Object.freeze([...this.invalidatedFacts.values()])
    }

    private addInvalidation(key: FactKey): void {
        const normalized = normalizeFactKey(key)
        this.invalidatedFacts.set(getFactKeyId(normalized), normalized)
    }

    private invalidateItem(itemId: number): void {
        this.addInvalidation({ kind: "items" })
        this.addInvalidation({ kind: "collectedItems", itemIds: [itemId] })
    }

    hasPlayerChanges(): boolean {
        return this.freeVmoney !== this.player.freeVmoney
            || this.freeMana !== this.player.freeMana
            || this.expPool !== this.player.expPool
            || this.latestDegreeId !== undefined
    }

    getUserInfo(): Record<string, number> {
        return {
            free_vmoney: this.freeVmoney,
            free_mana: this.freeMana,
            exp_pool: this.expPool,
            ...(this.latestDegreeId !== undefined ? { degree_id: this.latestDegreeId } : {}),
        }
    }

    get characterList(): Object[] {
        return [...this.characterMap.values()]
    }

    get equipmentList(): Object[] {
        return [...this.equipmentMap.values()]
    }

    get itemOverflowDispositions(): readonly PlannedItemOverflowDisposition[] {
        return Object.freeze([...this.itemOverflowDispositionList])
    }
}
