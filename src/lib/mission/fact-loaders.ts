import type { MissionBattleCounters } from "../../data/domains/mission_battle_facts"
import type { DegreeBattleStats } from "../../data/domains/degree_battle_stats"
import type { ShopPurchaseMap } from "../../data/domains/shopPurchase"
import type { Player, PlayerCharacter, PlayerEquipment, PlayerQuestProgress } from "../../data/types"
import type { FactKey } from "./facts/fact-key"
import type { MissionCatalog } from "./mission-catalog"
import type { MissionFactRequirementRegistry } from "./requirements/types"
import type { SnapshotData } from "./snapshot"

export interface MissionFactValueByKind {
    readonly player: Player
    readonly characters: Record<string, PlayerCharacter>
    readonly characterManaNodes: Record<string, number[]>
    readonly equipment: Record<string, PlayerEquipment>
    readonly collectedItems: Record<string, number>
    readonly questProgress: Record<string, PlayerQuestProgress[]>
    readonly missionBattleCounters: MissionBattleCounters
    readonly degreeBattleStats: DegreeBattleStats
    readonly shopPurchases: ShopPurchaseMap
    readonly periodicSnapshot: SnapshotData | null
}

export type MissionFactValue<Key extends FactKey> = Key["kind"] extends keyof MissionFactValueByKind
    ? MissionFactValueByKind[Key["kind"]]
    : unknown

export interface MissionFactLoaderContext<Key extends FactKey = FactKey> {
    readonly playerId: number
    readonly evaluationTime: Date
    readonly catalog: MissionCatalog
    readonly requirementRegistry: MissionFactRequirementRegistry
    readonly key: Key
}

export type MissionFactLoader<Key extends FactKey = FactKey> = (
    context: MissionFactLoaderContext<Key>,
) => MissionFactValue<Key>

export class MissionFactLoaderRegistry {
    readonly #loaders = new Map<FactKey["kind"], MissionFactLoader>()

    register<Kind extends FactKey["kind"]>(
        kind: Kind,
        loader: MissionFactLoader<Extract<FactKey, { kind: Kind }>>,
    ): this {
        if (this.#loaders.has(kind)) {
            throw new Error(`Mission fact loader already registered for kind ${kind}`)
        }
        this.#loaders.set(kind, loader as unknown as MissionFactLoader)
        return this
    }

    get<Key extends FactKey>(key: Key): MissionFactLoader<Key> | undefined {
        return this.#loaders.get(key.kind) as MissionFactLoader<Key> | undefined
    }
}
