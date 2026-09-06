import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../../content/runtime/content-snapshot"

/**
 * Limited static content consumed by the Active Mission production fact
 * domains: battle quest ids for chapter progress and the shop item id sets
 * behind purchase-count facts. Each group loads lazily on first use so the
 * session's layered fact-kind loading keeps its D24 semantics; player state
 * never flows through here, and a missing or broken table fails closed
 * instead of degrading to empty facts.
 */
export interface ActiveMissionFactContent {
    /** Battle-capable main (offset 0) or ex (offset +10,000,000) quest ids. */
    getBattleQuestIds(section: "main" | "ex"): readonly number[]
    getTreasureShopItemIds(): ReadonlySet<string>
    getBossCoinShopItemIds(): ReadonlySet<string>
    getBossCoinEquipmentShopItemIds(): ReadonlySet<string>
}

interface QuestLikeTable {
    readonly [questId: string]: unknown
}

interface BossCoinShopReward {
    readonly type?: number
}

interface BossCoinShopItem {
    readonly rewards?: readonly BossCoinShopReward[]
}

function isBattleQuest(quest: unknown): boolean {
    return quest !== null
    && typeof quest === "object"
    && "rankPointReward" in quest
}

function battleQuestIds(table: QuestLikeTable, offset: number): number[] {
    return Object.entries(table).flatMap(([questId, quest]) => {
        const parsedQuestId = Number(questId)
        if (!Number.isSafeInteger(parsedQuestId) || !isBattleQuest(quest)) return []
        return [parsedQuestId + offset]
    })
}

function keySet(table: Readonly<Record<string, unknown>>): ReadonlySet<string> {
    return new Set(Object.keys(table))
}

function bossCoinEquipmentItemIds(
    table: Readonly<Record<string, Readonly<Record<string, BossCoinShopItem>>>>,
): ReadonlySet<string> {
    const ids = new Set<string>()
    for (const category of Object.values(table)) {
        for (const [itemId, item] of Object.entries(category ?? {})) {
            if (item.rewards?.some(reward => reward.type === 4)) ids.add(itemId)
        }
    }
    return ids
}

export function buildActiveMissionFactContent(
    repository: ReadonlyContentRepository,
): ActiveMissionFactContent {
    let mainBattleQuestIds: readonly number[] | null = null
    let exBattleQuestIds: readonly number[] | null = null
    let treasureShopItemIds: ReadonlySet<string> | null = null
    let bossCoinShopItemIds: ReadonlySet<string> | null = null
    let bossCoinEquipmentShopItemIds: ReadonlySet<string> | null = null
    return Object.freeze({
        getBattleQuestIds: (section: "main" | "ex"): readonly number[] => {
            if (section === "main") {
                if (mainBattleQuestIds === null) {
                    mainBattleQuestIds = Object.freeze(battleQuestIds(
                        repository.table<QuestLikeTable>("main_quest.json"),
                        0,
                    ))
                }
                return mainBattleQuestIds
            }
            if (exBattleQuestIds === null) {
                exBattleQuestIds = Object.freeze(battleQuestIds(
                    repository.table<QuestLikeTable>("ex_quest.json"),
                    10_000_000,
                ))
            }
            return exBattleQuestIds
        },
        getTreasureShopItemIds: (): ReadonlySet<string> => {
            if (treasureShopItemIds === null) {
                treasureShopItemIds = keySet(repository
                    .table<Readonly<Record<string, unknown>>>("treasure_shop.json"))
            }
            return treasureShopItemIds
        },
        getBossCoinShopItemIds: (): ReadonlySet<string> => {
            if (bossCoinShopItemIds === null) {
                bossCoinShopItemIds = keySet(repository
                    .table<Readonly<Record<string, unknown>>>(
                        "boss_coin_shop_item_category_map.json",
                    ))
            }
            return bossCoinShopItemIds
        },
        getBossCoinEquipmentShopItemIds: (): ReadonlySet<string> => {
            if (bossCoinEquipmentShopItemIds === null) {
                bossCoinEquipmentShopItemIds = bossCoinEquipmentItemIds(
                    repository.table("boss_coin_shop.json"),
                )
            }
            return bossCoinEquipmentShopItemIds
        },
    })
}

const contentByRepository = new WeakMap<ReadonlyContentRepository, ActiveMissionFactContent>()

export function getActiveMissionFactContent(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): ActiveMissionFactContent {
    const cached = contentByRepository.get(repository)
    if (cached !== undefined) return cached
    const content = buildActiveMissionFactContent(repository)
    contentByRepository.set(repository, content)
    return content
}
