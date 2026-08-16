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

type MissionRewardPlayer = Pick<
    Player,
    "freeVmoney" | "freeMana" | "expPool" | "totalManaObtained"
>

interface MissionRewardGrantContext {
    passCardEventId?: number
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

    constructor(private readonly playerId: number, private readonly player: MissionRewardPlayer) {
        this.freeVmoney = player.freeVmoney
        this.freeMana = player.freeMana
        this.expPool = player.expPool
    }

    grant(rewards: ActiveMissionReward[], context: MissionRewardGrantContext = {}): readonly FactKey[] {
        for (const reward of rewards) {
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

    persistPlayer(): readonly FactKey[] {
        if (!this.hasPlayerChanges()) return this.invalidatedFactKeys
        updatePlayerSync({
            id: this.playerId,
            freeVmoney: this.freeVmoney,
            freeMana: this.freeMana,
            expPool: this.expPool,
            ...(this.latestDegreeId !== undefined ? { degreeId: this.latestDegreeId } : {}),
            totalManaObtained: (this.player.totalManaObtained ?? 0) + this.totalManaGained,
        })
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
