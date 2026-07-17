import type { Player } from "../../data/types"
import { getPlayerItemSync, givePlayerItemSync } from "../../data/domains/item"
import { updatePlayerSync } from "../../data/domains/player"
import { givePlayerCharacterSync } from "../character"
import { givePlayerEquipmentSync } from "../equipment"
import type { ActiveMissionReward } from "./rewards"
import { givePlayerDegreeSync } from "../../data/domains/degree"

export class MissionRewardGranter {
    readonly itemList: Record<string, number> = {}
    readonly degreeList: number[] = []
    private readonly characterMap = new Map<number, Object>()
    private readonly equipmentMap = new Map<number, Object>()
    private freeVmoney: number
    private freeMana: number
    private expPool: number
    private totalManaGained = 0
    private latestDegreeId: number | undefined

    constructor(private readonly playerId: number, private readonly player: Player) {
        this.freeVmoney = player.freeVmoney
        this.freeMana = player.freeMana
        this.expPool = player.expPool
    }

    grant(rewards: ActiveMissionReward[]): void {
        for (const reward of rewards) {
            switch (reward.kind) {
                case 0:
                    this.freeVmoney += reward.amount
                    break
                case 1:
                    if (reward.itemId !== undefined) {
                        this.itemList[String(reward.itemId)] = givePlayerItemSync(this.playerId, reward.itemId, reward.amount)
                    }
                    break
                case 2:
                    if (reward.equipmentId !== undefined) {
                        const equipment = givePlayerEquipmentSync(this.playerId, reward.equipmentId, reward.amount)
                        this.equipmentMap.set(reward.equipmentId, equipment)
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
                        this.characterMap.set(reward.characterId, result.character)
                        if (result.item) {
                            this.itemList[String(result.item.id)] = getPlayerItemSync(this.playerId, result.item.id) ?? 0
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
                    }
                    break
            }
        }
    }

    persistPlayer(): void {
        if (!this.hasPlayerChanges()) return
        updatePlayerSync({
            id: this.playerId,
            freeVmoney: this.freeVmoney,
            freeMana: this.freeMana,
            expPool: this.expPool,
            ...(this.latestDegreeId !== undefined ? { degreeId: this.latestDegreeId } : {}),
            totalManaObtained: (this.player.totalManaObtained ?? 0) + this.totalManaGained,
        })
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
