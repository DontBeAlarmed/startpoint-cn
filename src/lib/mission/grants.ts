import type { Player } from "../../data/types"
import { getPlayerItemSync, givePlayerItemSync } from "../../data/domains/item"
import { updatePlayerSync } from "../../data/domains/player"
import { givePlayerCharacterSync } from "../character"
import { givePlayerEquipmentSync } from "../equipment"
import type { ActiveMissionReward } from "./rewards"
import { givePlayerDegreeSync } from "../../data/domains/degree"
import { addPlayerPassCardPointWithChangeSync } from "../../data/domains/pass-card"
import { getPassCardEventDefinition } from "../pass-card"
import { getFactKeyId, normalizeFactKey, type FactKey } from "./facts/fact-key"
import { RewardType } from "../types/rewards"
import { createRewardGrantPlan } from "../reward-grant"
import type {
    RewardGrantPlan,
    RewardGrantPlayerAfter,
    RewardGrantResult,
    RewardGrantReward,
} from "../reward-grant"

type MissionRewardPlayer = Pick<
    Player,
    "freeVmoney" | "freeMana" | "expPool" | "totalManaObtained"
>

export interface MissionRewardSource {
    readonly kind: "mission"
    readonly definitionId?: number
    readonly rewardIndex: number
}

export interface MissionRewardGrantContext {
    definitionId?: number
    passCardEventId?: number
    standardRewardGrant?: (
        plan: RewardGrantPlan<MissionRewardSource>,
        knownPlayerBefore: RewardGrantPlayerAfter,
        playerUpdate: { readonly degreeId?: number },
    ) => RewardGrantResult<MissionRewardSource>
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
    private readonly pendingStandardEntries: {
        source: MissionRewardSource
        reward: RewardGrantReward
    }[] = []
    private standardRewardGrant: MissionRewardGrantContext["standardRewardGrant"]

    constructor(private readonly playerId: number, private readonly player: MissionRewardPlayer) {
        this.freeVmoney = player.freeVmoney
        this.freeMana = player.freeMana
        this.expPool = player.expPool
    }

    grant(rewards: ActiveMissionReward[], context: MissionRewardGrantContext = {}): readonly FactKey[] {
        if (context.standardRewardGrant !== undefined) {
            this.standardRewardGrant = context.standardRewardGrant
        }

        for (const [rewardIndex, reward] of rewards.entries()) {
            if (this.standardRewardGrant !== undefined) {
                const standardReward = this.toStandardRewardEntries(
                    reward,
                    rewardIndex,
                    context.definitionId,
                )
                if (standardReward.length > 0) {
                    this.pendingStandardEntries.push(...standardReward)
                    continue
                }
            }
            switch (reward.kind) {
                case 0:
                    this.freeVmoney += reward.amount
                    break
                case 1:
                    if (reward.itemId !== undefined && reward.amount > 0) {
                        const next = givePlayerItemSync(this.playerId, reward.itemId, reward.amount)
                        this.itemList[String(reward.itemId)] = next
                        this.invalidateItem(reward.itemId)
                    }
                    break
                case 2:
                    if (reward.equipmentId !== undefined && reward.amount > 0) {
                        const equipment = givePlayerEquipmentSync(this.playerId, reward.equipmentId, reward.amount)
                        this.equipmentMap.set(reward.equipmentId, equipment)
                        this.addInvalidation({ kind: "equipment" })
                    }
                    break
                case 3:
                    this.freeMana += reward.amount
                    this.totalManaGained += reward.amount
                    break
                case 4:
                    if (reward.characterId === undefined) break
                    for (let count = 0; count < reward.amount; count++) {
                        const result = givePlayerCharacterSync(this.playerId, reward.characterId)
                        if (!result) continue
                        this.addInvalidation({ kind: "characters" })
                        this.characterMap.set(reward.characterId, result.character)
                        if (result.item) {
                            const itemAmount = getPlayerItemSync(this.playerId, result.item.id) ?? 0
                            this.itemList[String(result.item.id)] = itemAmount
                            this.invalidateItem(result.item.id)
                        }
                    }
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

    private flushStandardRewards(): void {
        if (this.pendingStandardEntries.length === 0 || this.standardRewardGrant === undefined) return
        const grant = this.standardRewardGrant(
            createRewardGrantPlan(this.pendingStandardEntries),
            {
                freeMana: this.freeMana,
                freeVmoney: this.freeVmoney,
                expPool: this.expPool,
            },
            { degreeId: this.latestDegreeId },
        )
        this.pendingStandardEntries.length = 0
        this.standardRewardGranted = true
        this.freeMana = grant.playerAfter.freeMana
        this.freeVmoney = grant.playerAfter.freeVmoney
        this.expPool = grant.playerAfter.expPool
        Object.assign(this.itemList, grant.aggregate.items)

        for (const entry of grant.entries) {
            switch (entry.reward.type) {
                case RewardType.ITEM:
                    this.invalidateItem(entry.reward.id)
                    break
                case RewardType.EQUIPMENT: {
                    const equipment = entry.result.equipment_list[0]
                    if (equipment !== undefined) this.equipmentMap.set(entry.reward.id, equipment)
                    this.addInvalidation({ kind: "equipment" })
                    break
                }
                case RewardType.CHARACTER:
                    if (entry.result.character_list.length > 0) {
                        this.addInvalidation({ kind: "characters" })
                    }
                    for (const itemId of Object.keys(entry.result.items)) {
                        this.invalidateItem(Number(itemId))
                    }
                    for (const character of entry.result.character_list) {
                        this.characterMap.set(entry.reward.id, character)
                    }
                    break
            }
        }
    }

    private toStandardRewardEntries(
        reward: ActiveMissionReward,
        rewardIndex: number,
        definitionId: number | undefined,
    ): { source: MissionRewardSource, reward: RewardGrantReward }[] {
        const source = {
            kind: "mission" as const,
            ...(definitionId === undefined ? {} : { definitionId }),
            rewardIndex,
        }
        if (reward.amount <= 0) return []
        switch (reward.kind) {
            case 0:
                return [{ source, reward: { type: RewardType.BEADS, count: reward.amount } }]
            case 1:
                return reward.itemId === undefined ? [] : [{
                    source,
                    reward: { type: RewardType.ITEM, id: reward.itemId, count: reward.amount },
                }]
            case 2:
                return reward.equipmentId === undefined ? [] : [{
                    source,
                    reward: { type: RewardType.EQUIPMENT, id: reward.equipmentId, count: reward.amount },
                }]
            case 3:
                return [{ source, reward: { type: RewardType.MANA, count: reward.amount } }]
            case 4:
                if (reward.characterId === undefined) return []
                const characterId = reward.characterId
                return Array.from(
                    { length: reward.amount },
                    () => ({ source, reward: { type: RewardType.CHARACTER, id: characterId } }),
                )
            case 5:
                return [{ source, reward: { type: RewardType.EXP, count: reward.amount } }]
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
}
