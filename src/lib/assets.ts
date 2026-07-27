import boxGacha from "../../assets/box_gacha.json";
import boxGachaBoxSettings from "../../assets/box_gacha_box_settings.json";
import boxReward from "../../assets/box_reward.json";
import exAbility from "../../assets/ex_ability.json";
import exBoost from "../../assets/ex_boost.json";
import exStatus from "../../assets/ex_status.json";
import practiceQuests from "../../assets/practice_quest.json";
import manaNodes from "../../assets/mana_node.json";
import manaNodeAwake from "../../assets/mana_node_awake.json";
import manaBoard from "../../assets/mana_board.json";
import configData from "../../assets/config.json"
import equipmentDissolveData from "../../assets/equipment_dissolve.json"
import equipmentIdsData from "../../assets/equipment_ids.json"
import equipmentLookupData from "../../assets/equipment_lookup.json"
import itemSaleData from "../../assets/item_sale.json"
import itemData from "../../assets/item_data.json"
import itemIdsData from "../../assets/item_ids.json"
import itemLookupData from "../../assets/item_lookup.json"
import equipmentCraftData from "../../assets/equipment_craft.json"
import { AssetCharacter, BattleQuest, BossCoinShopItems, BoxGacha, ClearRewards, ConfigValues, EquipmentCraftEntry, EquipmentDissolveEntry, EventItemShopIdMapItem, EventShopItems, ExAbilities, ExBoostItem, ExBoostItems, ExStatus, Gacha, Gachas, ItemSaleEntry, ManaNode, ManaNodes, QuestCategory, RareScoreReward, RareScoreRewardGroups, RawAssetCharacters, RawBoxGachas, RawBoxRewards, RawQuests, Reward, RushEventFolders, ScoreReward, ScoreRewardGroups, ShopItem, ShopItems, ShopType, StoryQuest } from "./types";
import { RawBoxGachaSettings } from "./types/box-gacha";
import {
    ContentSnapshotError,
    getContentSnapshot,
} from "../content/runtime/content-snapshot";
import type { ScoreAttackBorderTier } from "./quest/finish/score-attack-handler";
import type { QuestTableName } from "../content/converters/quest";
import { getRuntimeContentTableSync } from "../content/runtime/table-access";

export class QuestConfigurationError extends Error {
    constructor(
        public readonly category: QuestCategory,
        public readonly questId: string | number,
        public readonly rewardId: string | number,
        public readonly field: "clearRewardId" | "sPlusRewardId",
    ) {
        super(`Invalid quest reward configuration: category=${category} questId=${questId} rewardId=${rewardId} field=${field}`)
        this.name = "QuestConfigurationError"
    }
}

function getConfiguredQuestRewardSync(
    category: QuestCategory,
    questId: string | number,
    rewardId: string | number | undefined,
    field: "clearRewardId" | "sPlusRewardId",
): Reward | undefined {
    if (rewardId === undefined) return undefined

    const reward = getClearRewardSync(rewardId)
    if (reward === null) throw new QuestConfigurationError(category, questId, rewardId, field)
    return reward
}

export function getQuestContentTableSync(tableName: QuestTableName): RawQuests {
    try {
        return getContentSnapshot().repository.table<RawQuests>(tableName)
    } catch (error) {
        if (!(error instanceof ContentSnapshotError)
            || error.code !== "CONTENT_SNAPSHOT_NOT_INITIALIZED") throw error
        // Low-level tests may import quest logic before startup installs the snapshot.
        return require(`../../assets/${tableName}`) as RawQuests
    }
}

export function getQuestConfigurationErrorResponse(error: unknown): Record<string, unknown> | null {
    if (!(error instanceof QuestConfigurationError)) return null
    return {
        error: "Internal Server Error",
        message: "Quest reward configuration is invalid.",
        category: error.category,
        quest_id: Number(error.questId),
        reward_id: Number(error.rewardId),
        field: error.field,
    }
}

/**
 * Gets a clear reward from its ID.
 * 
 * @param clearRewardId The ID of the clear reward.
 * @returns The clear reward that was found, or null.
 */
export function getClearRewardSync(
    clearRewardId: string | number
): Reward | null {
    const clearReward = getContentSnapshot().repository.table<ClearRewards>(
        "clear_reward.json",
    )[String(clearRewardId)]
    return clearReward ? clearReward as Reward : null
}

/**
 * Gets a rare score reward group from its ID.
 * 
 * @param groupId The ID of the rare score reward group.
 * @returns The score reward group that was found, or null.
 */
export function getRareScoreRewardGroup(
    groupId: string | number
): RareScoreReward[] | null {
    const group = getContentSnapshot().repository.table<RareScoreRewardGroups>(
        "rare_score_reward.json",
    )[String(groupId)]
    return group ? group as RareScoreReward[] : null
}

/**
 * Gets a score reward group from its ID.
 * 
 * @param groupId The ID of the group.
 * @returns The score reward group that was found, or null.
 */
export function getScoreRewardGroup(
    groupId: string | number
): ScoreReward[] | null {
    const group = getContentSnapshot().repository.table<ScoreRewardGroups>(
        "score_reward.json",
    )[String(groupId)]
    return group ? group as ScoreReward[] : null
}

/**
 * Generic quest fetching function.
 * 
 * @param quests The list of quests to search.
 * @param questId The ID of the quest to get.
 * @returns The found BattleQuest, StoryQuest, or null
 */
function getQuestSync(
    quests: RawQuests,
    questId: string | number,
    category: QuestCategory,
): BattleQuest | null {
    const quest = quests[String(questId)]

    // return null if the quest doesn't exist
    if (!quest) return null;

    const clearReward = getConfiguredQuestRewardSync(category, questId, quest.clearRewardId, "clearRewardId")
    const sPlusReward = getConfiguredQuestRewardSync(category, questId, quest.sPlusRewardId, "sPlusRewardId")

    // always return BattleQuest; missing fields default to 0
    return {
        name: quest.name,
        enemyLevel: quest.enemyLevel ?? 0,
        clearReward,
        sPlusReward,
        scoreRewardGroupId: quest.scoreRewardGroupId ?? undefined,
        scoreRewardGroup: quest.scoreRewardGroupId != null ? getScoreRewardGroup(quest.scoreRewardGroupId) ?? undefined : undefined,
        commonRewardCount: quest.commonRewardCount,
        commonRewardCounts: quest.commonRewardCounts,
        element: quest.element,
        eventId: quest.eventId,
        folderId: quest.folderId,
        difficultyScore: quest.difficultyScore,
        timeLimitMs: quest.timeLimitMs,
        killCountWeight: quest.killCountWeight,
        bRankTime: quest.bRankTime ?? 0,
        aRankTime: quest.aRankTime ?? 0,
        sRankTime: quest.sRankTime ?? 0,
        sPlusRankTime: quest.sPlusRankTime ?? 0,
        bRankScore: quest.bRankScore,
        aRankScore: quest.aRankScore,
        sRankScore: quest.sRankScore,
        ssRankScore: quest.ssRankScore,
        scoreAttackQuestId: quest.scoreAttackQuestId,
        rankPointReward: quest.rankPointReward ?? 0,
        characterExpReward: quest.characterExpReward ?? 0,
        manaReward: quest.manaReward ?? 0,
        poolExpReward: quest.poolExpReward ?? 0,
        fixedParty: quest.fixedParty,
        isBothBoss: quest.isBothBoss,
        rushEventId: quest.rushEventId,
        rushEventFolderId: quest.rushEventFolderId,
        rushEventRound: quest.rushEventRound
    }
}

/**
 * Gets the data for a main quest from the database.
 * 
 * @param questId The ID of the quest.
 * @returns A BattleQuest, StoryQuest, or null
 */
export function getMainQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("main_quest.json"), questId, QuestCategory.MAIN)
}

/**
 * Gets an EX quest.
 * 
 * @param questId The ID of the quest to get.
 * @returns The found BattleQuest or null
 */
export function getExQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("ex_quest.json"), questId, QuestCategory.EX)
}

/**
 * Gets a practice quest.
 * 
 * @param questId The ID of the quest to get.
 * @returns The found BattleQuest or null
 */
export function getPracticeQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync((practiceQuests as RawQuests), questId, QuestCategory.PRACTICE)
}

/**
 * Gets a boss battle quest.
 * 
 * @param questId The ID of the quest to get.
 * @returns The found BattleQuest or null
 */
export function getBossBattleQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("boss_battle_quest.json"), questId, QuestCategory.BOSS_BATTLE)
}

/**
 * Gets a character quest.
 * 
 * @param questId The ID of the quest to get.
 * @returns The found StoryQuest or null
 */
export function getCharacterQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("character_quest.json"), questId, QuestCategory.CHARACTER)
}

/**
 * Gets a world story event quest.
 * 
 * @param questId The ID of the quest to get.
 * @returns The found StoryQuest or null
 */
export function getWorldStoryEventQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("world_story_event_quest.json"), questId, QuestCategory.WORLD_STORY_EVENT)
}

/**
 * Gets a world story event boss battle quest.
 * 
 * @param questId The ID of the quest to get.
 * @returns The found StoryQuest or null
 */
export function getWorldStoryEventBossBattleQuestSync(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("world_story_event_boss_battle_quest.json"), questId, QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE)
}

/**
 * Gets an advent quest.
 * 
 * @param questId The ID of the quest to get.
 * @returns The found StoryQuest or null
 */
export function getAdventEventQuest(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("advent_event_quest.json"), questId, QuestCategory.ADVENT_EVENT_SINGLE)
}

/**
 * Gets a hard multi event quest.
 * 
 * @param questId The ID of the quest to get.
 * @returns The found BattleQuest or null
 */
export function getHardMultiEventQuest(
    questId: string | number
): BattleQuest | null {
    return getQuestSync(getQuestContentTableSync("hard_multi_event_quest.json"), questId, QuestCategory.HARD_MULTI_EVENT)
}

/**
 * Gets a quest from a specific quest category.
 * 
 * @param category The category of the quest.
 * @param questId The ID of the quest.
 * @returns The BattleQuest or StoryQuest that was found, or null if nothing was found.
 */
export function getQuestFromCategorySync(
    category: QuestCategory,
    questId: string | number
): BattleQuest | null {
    switch (category) {
        case QuestCategory.MAIN:
            return getQuestSync(getQuestContentTableSync("main_quest.json"), questId, category)
        case QuestCategory.EX:
            return getQuestSync(getQuestContentTableSync("ex_quest.json"), questId, category)
        case QuestCategory.BOSS_BATTLE:
            return getQuestSync(getQuestContentTableSync("boss_battle_quest.json"), questId, category)
        case QuestCategory.CHARACTER:
            return getQuestSync(getQuestContentTableSync("character_quest.json"), questId, category)
        case QuestCategory.WORLD_STORY_EVENT:
            return getQuestSync(getQuestContentTableSync("world_story_event_quest.json"), questId, category)
        case QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE:
            return getQuestSync(getQuestContentTableSync("world_story_event_boss_battle_quest.json"), questId, category)
        case QuestCategory.ADVENT_EVENT_SINGLE:
        case QuestCategory.ADVENT_EVENT_MULTI:
            return getQuestSync(getQuestContentTableSync("advent_event_quest.json"), questId, category)
        case QuestCategory.STORY_EVENT_SINGLE:
            return getQuestSync(getQuestContentTableSync("story_event_single_quest.json"), questId, category)
        case QuestCategory.RANKING_EVENT_SINGLE:
            return getQuestSync(getQuestContentTableSync("ranking_event_single_quest.json"), questId, category)
        case QuestCategory.CHALLENGE_DUNGEON_EVENT:
            return getQuestSync(getQuestContentTableSync("challenge_dungeon_event_quest.json"), questId, category)
        case QuestCategory.DAILY_EXP_MANA_EVENT:
            return getQuestSync(getQuestContentTableSync("daily_exp_mana_event_quest.json"), questId, category)
        case QuestCategory.PRACTICE:
            return getQuestSync((practiceQuests as RawQuests), questId, category)
        case QuestCategory.DAILY_WEEK_EVENT:
            return getQuestSync(getQuestContentTableSync("daily_week_event_quest.json"), questId, category)
        case QuestCategory.TOWER_DUNGEON_EVENT:
            return getQuestSync(getQuestContentTableSync("tower_dungeon_event_quest.json"), questId, category)
        case QuestCategory.EXPERT_SINGLE_EVENT:
            return getQuestSync(getQuestContentTableSync("expert_single_event_quest.json"), questId, category)
        case QuestCategory.CARNIVAL_EVENT:
            return getQuestSync(getQuestContentTableSync("carnival_event_quest.json"), questId, category)
        case QuestCategory.RAID_EVENT:
            return getQuestSync(getQuestContentTableSync("raid_event_quest.json"), questId, category)
        case QuestCategory.RUSH_EVENT:
            return getQuestSync(getQuestContentTableSync("rush_event_quest.json"), questId, category)
        case QuestCategory.SOLO_TIME_ATTACK_EVENT:
            return getQuestSync(getQuestContentTableSync("solo_time_attack_event_quest.json"), questId, category)
        case QuestCategory.SCORE_ATTACK_EVENT:
            return getQuestSync(getQuestContentTableSync("score_attack_event_quest.json"), questId, category)
        case QuestCategory.HARD_MULTI_EVENT:
            return getQuestSync(getQuestContentTableSync("hard_multi_event_quest.json"), questId, category)
        default:
            return null
    }
}

/**
 * Gets a character's asset data from their id.
 * 
 * @param characterId The ID of the character.
 * @returns The character's asset data, or null if it wasn't found.
 */
export function getCharacterDataSync(
    characterId: string | number
): AssetCharacter | null {
    const characters = getContentSnapshot().repository.table<RawAssetCharacters>("character.json")
    const character = (characters as RawAssetCharacters)[String(characterId)]

    if (!character) return null;

    return character
}

/**
 * Gets all mana node data for a character on a specific level.
 * 
 * @param characterId The ID of the character.
 * @param level The mana node level.
 * @returns A record containing ManaNode objects or null.
 */
export function getCharacterManaNodesSync(
    characterId: string | number,
    level: string | number,
): Record<string, ManaNode> | null{
    const characterManaNodes = getRuntimeContentTableSync(
        "mana_node.json",
        manaNodes as ManaNodes,
    )[String(characterId)]
    if (!characterManaNodes) return null;

    return characterManaNodes[String(level)] || null
}

/**
 * Gets the number of mana boards a character has in CDN data.
 */
export function getCharacterManaBoardCountSync(
    characterId: string | number
): number {
    const characterManaNodes = getRuntimeContentTableSync(
        "mana_node.json",
        manaNodes as ManaNodes,
    )[String(characterId)]
    if (!characterManaNodes) return 0
    return Object.keys(characterManaNodes).length
}

/**
 * Gets the data for a character mana node.
 * 
 * @param characterId The ID of the character.
 * @param level The mana node level to get the node from.
 * @param manaNodeId The ID of the mana node.
 * @returns A ManaNode object or null.
 */
export function getCharacterManaNodeSync(
    characterId: string | number,
    level: string | number,
    manaNodeId: string | number
): ManaNode | null {
    const nodes = getCharacterManaNodesSync(characterId, level);
    if (!nodes) return null;

    return nodes[String(manaNodeId)] || null
}

/**
 * Gets the slot (1-4) for a character's mana node from its field6 value.
 * Returns 0 if the node is not found.
 * field6=1/2/3 → ability slot 1/2/3; field6="" → skill slot 4.
 */
function getManaNodeSlot(
    characterId: string | number,
    manaNodeId: string | number
): number {
    const charData = getRuntimeContentTableSync(
        "mana_node.json",
        manaNodes as ManaNodes,
    )[String(characterId)]
    if (!charData) return 0
    for (const level of Object.keys(charData)) {
        const node = charData[level]?.[String(manaNodeId)]
        if (node) {
            const f6 = node.field6
            if (f6 === '1') return 1
            if (f6 === '2') return 2
            if (f6 === '3') return 3
            return 4  // empty → action skill slot
        }
    }
    return 0
}

/**
 * Gets the pedestal_size (0 or 2) for a character's mana node.
 * Returns -1 if not found.
 */
function getManaNodePedestalSize(
    characterId: string | number,
    manaNodeId: string | number
): number {
    const charBoard = getRuntimeContentTableSync(
        "mana_board.json",
        manaBoard as Record<string, any>,
    )[String(characterId)]
    if (!charBoard) return -1
    for (const level of Object.keys(charBoard)) {
        const nodes = charBoard[level]
        for (const nodeIndex of Object.keys(nodes)) {
            const row = nodes[nodeIndex][0]
            if (String(row[0]) === String(manaNodeId)) {
                return parseInt(row[4]) || 0
            }
        }
    }
    return -1
}

export interface ManaNodeAwakeCost {
    manaAmount: number
    items: Record<string, number>
}

/**
 * Gets the awake cost for awakening a mana node.
 * CDN lookup: mana_node_awake[rarity][slot][pedestal_size]
 */
export function getManaNodeAwakeCost(
    characterId: string | number,
    manaNodeId: string | number,
    rarity: number
): ManaNodeAwakeCost | null {
    const slot = getManaNodeSlot(characterId, manaNodeId)
    if (slot === 0) return null

    const pedestalSize = getManaNodePedestalSize(characterId, manaNodeId)
    if (pedestalSize < 0) return null

    const rarityData = getRuntimeContentTableSync(
        "mana_node_awake.json",
        manaNodeAwake as Record<string, any>,
    )[String(rarity)]
    if (!rarityData) return null

    const slotData = rarityData[String(slot)]
    if (!slotData) return null

    const targetRows = slotData[String(pedestalSize)]
    if (!targetRows || !targetRows[0]) return null

    const row = targetRows[0]
    // row[0]: "item_id_1,item_id_2,..." (IDs)
    // row[1]: "count_1,count_2,..." (counts)
    // row[2]: mana amount
    const idStrings = String(row[0]).split(',')
    const countStrings = String(row[1]).split(',')
    const manaAmount = parseInt(String(row[2])) || 0

    const items: Record<string, number> = {}
    for (let i = 0; i < idStrings.length; i++) {
        const id = parseInt(idStrings[i]) || 0
        const count = parseInt(countStrings[i]) || 0
        if (id > 0 && count > 0) {
            items[String(id)] = (items[String(id)] || 0) + count
        }
    }

    return { manaAmount, items }
}

/**
 * Gets the ExAbilities record.
 * 
 * @returns 
 */
export function getExAbilityPoolsSync(): ExAbilities {
    return exAbility as ExAbilities;
}

/**
 * Gets an ex status pool.
 * 
 * @param tier The tier of the pool to get.
 * @returns A list of numbers with the StatusIDs corresponding to the requested pool.
 */
export function getExStatusPoolSync(
    tier: string | number
): number[] | null {
    const pool = getRuntimeContentTableSync(
        "ex_status.json",
        exStatus as ExStatus,
    )[String(tier)]
    return pool === undefined ? null : pool
}

/**
 * Gets an ex boost item.
 * 
 * @param itemId The ID of the item.
 * @returns The ExBoostItem that was found, or null.
 */
export function getExBoostItemSync(
    itemId: string | number
): ExBoostItem | null {
    const item = getRuntimeContentTableSync(
        "ex_boost.json",
        exBoost as ExBoostItems,
    )[String(itemId)]

    return item === undefined ? null : item
}

/**
 * Gets the data for a box gacha from the assets folder.
 * 
 * @param id The ID of the box gacha.
 * @returns A BoxGacha object or null, if it didn't exist.
 */
export function getBoxGachaSync(
    id: string | number
): BoxGacha | null {

    const idString = String(id)
    // get redeem item data
    const redeemItemData = getRuntimeContentTableSync(
        "box_gacha.json",
        boxGacha as RawBoxGachas,
    )[idString]
    if (redeemItemData === undefined) return null;

    // get boxes
    const boxes = getRuntimeContentTableSync(
        "box_reward.json",
        boxReward as RawBoxRewards,
    )[idString]
    if (boxes === undefined) return null;

    const boxSettings = getRuntimeContentTableSync(
        "box_gacha_box_settings.json",
        boxGachaBoxSettings as RawBoxGachaSettings,
    )[idString]
    if (boxSettings === undefined) return null;

    // build box gacha
    return {
        redeemItemId: redeemItemData.itemId,
        redeemItemCount: redeemItemData.count,
        boxes: boxes,
        availableCounts: redeemItemData.availableCounts,
        boxSettings
    }
}

/**
 * Gets the data for a gacha.
 * 
 * @param id The ID of the gacha.
 * @returns The gacha's data, or null.
 */
export function getGachaSync(
    id: string | number
): Gacha | null {
    const gachas = getContentSnapshot().repository.table<Gachas>("gacha.json")
    const data = (gachas as Gachas)[String(id)];
    
    return data ?? null
}

/**
 * Gets the ID of the gacha campaign assigned to a gacha.
 * 
 * @param gachaId The ID of the gacha.
 * @returns The ID of the assigned gacha campaign or null.
 */
export function getGachaCampaignIdSync(
    gachaId: string | number
): number | null {
    const gachaCampaigns = getContentSnapshot().repository.table<Record<string, number>>(
        "gacha_campaign.json",
    )
    return (gachaCampaigns as Record<string, number>)[String(gachaId)] ?? null
}

// shop functions

function getShopContentTable<T>(tableName: string): T {
    return getContentSnapshot().repository.table<T>(tableName)
}

function getEventItemShopItems(): EventShopItems {
    return getShopContentTable<EventShopItems>("event_item_shop.json")
}

function getBossCoinShopItems(): BossCoinShopItems {
    return getShopContentTable<BossCoinShopItems>("boss_coin_shop.json")
}

interface RushCompatibilityEvent {
    sourceEventId: number
    availableFrom: string
    availableUntil: string
}

const RUSH_COMPATIBILITY_EVENTS: Record<number, RushCompatibilityEvent> = Object.fromEntries(
    Array.from({ length: 7 }, (_, index) => [700011 + index, {
        sourceEventId: 700001 + index,
        availableFrom: "2025-06-26 12:00:00",
        availableUntil: "2025-08-14 23:59:59",
    }]),
)

function getRushCompatibilityEvent(eventId: number | string): RushCompatibilityEvent | null {
    const numericEventId = Number(eventId)
    return Number.isInteger(numericEventId) ? RUSH_COMPATIBILITY_EVENTS[numericEventId] ?? null : null
}

function addRushCompatibilityPeriod(item: ShopItem, compatibility: RushCompatibilityEvent): ShopItem {
    const compatibilityPeriod = {
        availableFrom: compatibility.availableFrom,
        availableUntil: compatibility.availableUntil,
    }
    const existingPeriods = item.compatibilityPeriods ?? []
    const compatibilityPeriods = existingPeriods.some(period => (
        period.availableFrom === compatibilityPeriod.availableFrom
        && period.availableUntil === compatibilityPeriod.availableUntil
    ))
        ? existingPeriods
        : [...existingPeriods, compatibilityPeriod]

    return {
        ...item,
        compatibilityPeriods,
    }
}

function addRushCompatibilityPeriods(items: ShopItems, compatibility: RushCompatibilityEvent): ShopItems {
    return Object.fromEntries(Object.entries(items).map(([itemId, item]) => [
        itemId,
        addRushCompatibilityPeriod(item, compatibility),
    ]))
}

function hasShopItems(items: ShopItems | undefined): items is ShopItems {
    return items !== undefined && Object.keys(items).length > 0
}

/**
 * Gets the items for a generic shop.
 * 
 * @param shopType The type of shop to get the items of.
 * @returns A list of shop items belonging to the specified shop type or null.
 */
export function getGenericShopItemsSync(
    shopType: ShopType
): ShopItems | null {
    switch (shopType) {
        case ShopType.TREASURE:
            return getShopContentTable<ShopItems>("treasure_shop.json")
        case ShopType.TREASURE_EQUIPMENT:
            return getShopContentTable<ShopItems>("equipment_enhancement_shop.json")
        case ShopType.GENERAL:
            return getShopContentTable<ShopItems>("general_shop.json")
        case ShopType.STAR_GRAIN:
            return getShopContentTable<ShopItems>("star_grain_shop.json")
    }
    return null
}

/**
 * Gets the items for a specific event shop.
 * 
 * @param eventType The type of event.
 * @param eventId The ID of the event.
 * @returns A list of shop items or null.
 */
export function getEventShopItemsSync(
    eventType: number | string,
    eventId: number | string
): ShopItems | null {
    const typeSection = getEventItemShopItems()[String(eventType)]
    if (typeSection === undefined) return null;

    const exactItems = typeSection[String(eventId)]
    if (hasShopItems(exactItems)) return exactItems

    // CN v1.4.54 has no standalone constant-Rush shop rows. Keep this
    // compatibility fallback until a CDN patch or official response replaces it.
    if (Number(eventType) !== 11) return null
    const compatibility = getRushCompatibilityEvent(eventId)
    if (compatibility === null) return null
    const sourceItems = typeSection[String(compatibility.sourceEventId)]
    return !hasShopItems(sourceItems) ? null : addRushCompatibilityPeriods(sourceItems, compatibility)
}

/**
 * Gets the items belonging to a specific boss coin shop.
 * 
 * @param bossId The ID of the boss to get the items of.
 * @returns A list of shop items or null.
 */
export function getBossCoinShopItemsSync(
    bossId: number | string
): ShopItems | null {
    return getBossCoinShopItems()[String(bossId)] ?? null
}

/**
 * Gets the data for a specfic ShopItem.
 * 
 * @param shopType The type of shop that this item belongs to.
 * @param itemId The ID of this item.
 * @returns The ShopItem data or null.
 */
export function getShopItemSync(
    shopType: ShopType,
    itemId: number | string
): ShopItem | null {
    switch(shopType) {
        case ShopType.TREASURE:
            return getShopContentTable<ShopItems>("treasure_shop.json")[String(itemId)] ?? null
        case ShopType.TREASURE_EQUIPMENT:
            return getShopContentTable<ShopItems>(
                "equipment_enhancement_shop.json",
            )[String(itemId)] ?? null
        case ShopType.GENERAL:
            return getShopContentTable<ShopItems>("general_shop.json")[String(itemId)] ?? null
        case ShopType.STAR_GRAIN:
            return getShopContentTable<ShopItems>("star_grain_shop.json")[String(itemId)] ?? null
        case ShopType.BOSS_COIN:
            const category = getShopContentTable<Record<string, number>>(
                "boss_coin_shop_item_category_map.json",
            )[itemId]
            if (category === undefined) return null;
            return getBossCoinShopItems()[category]?.[itemId] ?? null
        case ShopType.EVENT_ITEM:
            const mapInfo = getShopContentTable<Record<string, EventItemShopIdMapItem>>(
                "event_item_shop_id_map.json",
            )[itemId]
            if (mapInfo === undefined) return null;
            const eventItems = getEventItemShopItems()
            const eventItem = eventItems[mapInfo.eventType]?.[mapInfo.eventId]?.[itemId]
            if (eventItem === undefined) return null
            if (mapInfo.eventType !== 11) return eventItem
            const compatibilityTarget = Object.entries(RUSH_COMPATIBILITY_EVENTS).find(
                ([, entry]) => entry.sourceEventId === mapInfo.eventId,
            )
            if (compatibilityTarget === undefined) return eventItem
            const [targetEventId, compatibilityEntry] = compatibilityTarget
            const targetItems = eventItems[String(mapInfo.eventType)]?.[targetEventId]
            return hasShopItems(targetItems)
                ? eventItem
                : addRushCompatibilityPeriod(eventItem, compatibilityEntry)
        default:
            return null
    }
}

/**
 * Gets the rewards that should be given when clearing a given folder.
 * 
 * @param rushEventId The ID of the rush event.
 * @param folderId The ID of the folder.
 * @returns 
 */
export function getRushEventFolderClearRewards(
    rushEventId: number,
    folderId: number
): Reward[] | null {
    const rushEventQuestFolders = getContentSnapshot().repository.table<RushEventFolders>(
        "rush_event_quest_folder.json",
    )
    const folders = rushEventQuestFolders[rushEventId]
    const rewards = folders?.[folderId]
    if (Array.isArray(rewards) && rewards.length > 0) return rewards

    const compatibility = getRushCompatibilityEvent(rushEventId)
    if (compatibility === null) return null
    const fallbackRewards = rushEventQuestFolders[compatibility.sourceEventId]?.[folderId]
    return Array.isArray(fallbackRewards) && fallbackRewards.length > 0 ? fallbackRewards : null
}

export function getScoreAttackBorderRewards(): Record<string, ScoreAttackBorderTier[]> {
    return getContentSnapshot().repository.table<Record<string, ScoreAttackBorderTier[]>>(
        "score_attack_border_reward.json",
    )
}

export interface RushEventRankingRewardEntry {
    fromRank: number
    toRank: number
    kind: number
    kindId: number
    number: number
}

export type RushEventRankingRewards = Record<
    string,
    Record<string, RushEventRankingRewardEntry[]>
>

export function getRushEventRankingRewards(): RushEventRankingRewards {
    return getContentSnapshot().repository.table<RushEventRankingRewards>(
        "rush_event_ranking_reward.json",
    )
}

// TODO: 待从CDN二进制 config.orderedmap 提取真实数据
const FALLBACK_CONFIG: ConfigValues = {
    continue_virtual_money: 50,
    stamina_recovery_virtual_money: 50,
    stamina_recovery_seconds: 300,
    stamina_recovery_value: 100,
    max_stamina_overflow: 999,
    max_virtual_money: 999999,
    max_mana: 99999999,
    max_star_crumb: 9999,
    pool_exp_gain_value: 1,
    pool_exp_gain_seconds: 1,
    max_pool_exp: 999999,
    max_display_pool_exp: 999999,
    max_follows_count: 100,
    max_followers_count: 50,
    max_display_followers_count: 50,
    max_player_name_length: 12,
    max_player_comment_length: 40,
    overflow_exp_to_mana_conversion_rate: 0.001,
    reward_multiplier_by_boost_point: 1.0,
    common_reward_multiplier_by_multi_play_mode: 1.0,
    limit_payment_under_16: 0,
    limit_payment_16_19: 0,
    alert_payment: 0,
    level_correction_value_by_recommended_element: 0,
    level_correction_value_for_moderate_level_comparison: 0,
    unknown_loc2: 0,
    max_bond_token: 999,
    treasure_shop_item_number: 0,
    special_pack_shop_days_as_new: 7,
    support_url: "",
    max_boss_boost_point: 3,
    max_display_boss_boost_point: 3,
    max_boost_point: 10,
    max_display_boost_point: 10,
    craft_point_item_id: 0,
    wildcard_once_character_ticket_item_id: 0,
    wildcard_ten_times_character_ticket_item_id: 0,
    wildcard_once_rare4_character_ticket_item_id: 0,
    wildcard_once_equipment_ticket_item_id: 0,
    wildcard_ten_times_equipment_ticket_item_id: 0,
    encyclopedia_point_item_id: 0,
    star_grain_item_id: 0,
    gacha_one_max_count: 999,
    gacha_ten_max_count: 999,
    growth_fund_unlock_chapter: 0,
    gacha_crazy_ten_max_count: 999,
    monthly_bonus_payment_total_requirement: 0,
    crazygacha_ten_times_character_ticket_id: 0,
    reward_multiplier_by_newbie: 1.0,
    newbie_rank: 50,
    newbie_days: 7,
}

/**
 * Gets the config values (stamina recovery, vmoney limits, etc.).
 * Returns fallback defaults if config.json fails to load.
 */
export function getConfigSync(): ConfigValues {
    if (!configData) {
        console.error('[CONFIG] config.json not loaded, using fallback defaults')
        return FALLBACK_CONFIG
    }
    // Merge loaded data with fallback to fill any missing fields
    const merged = { ...FALLBACK_CONFIG, ...(configData as Partial<ConfigValues>) }
    return merged
}

/**
 * Gets a specific stamina config value with bounds checking.
 */
export function getStaminaRecoverySeconds(): number {
    const v = getConfigSync().stamina_recovery_seconds
    if (typeof v !== 'number' || v <= 0 || !isFinite(v)) {
        console.warn('[CONFIG] invalid stamina_recovery_seconds, fallback to 300')
        return 300
    }
    return v
}

// ─── Equipment dissolve data ────────────────────────────────────────────

/**
 * Gets equipment dissolve properties from CDN data.
 * Returns null if equipment not found in the dataset.
 */
export function getEquipmentDissolveSync(id: number | string): EquipmentDissolveEntry | null {
    const table = getRuntimeContentTableSync(
        "equipment_dissolve.json",
        equipmentDissolveData as Record<string, EquipmentDissolveEntry>,
    )
    const entry = table[String(id)]
    return entry ?? null
}

export function getEquipmentIdsSync(): readonly number[] {
    return getRuntimeContentTableSync(
        "equipment_ids.json",
        equipmentIdsData as number[],
    )
}

export interface EquipmentLookupEntry {
    readonly name: string
    readonly rarity: string
    readonly category: string
}

export function getEquipmentLookupSync(): Readonly<Record<string, EquipmentLookupEntry>> {
    return getRuntimeContentTableSync(
        "equipment_lookup.json",
        equipmentLookupData as Record<string, EquipmentLookupEntry>,
    )
}

export interface ItemEffectEntry {
    readonly effectKind: number
    readonly effectValue: number
}

export function getItemEffectSync(id: number | string): ItemEffectEntry | null {
    const table = getRuntimeContentTableSync(
        "item_data.json",
        itemData as Record<string, ItemEffectEntry>,
    )
    return table[String(id)] ?? null
}

export function getItemIdsSync(): readonly number[] {
    return getRuntimeContentTableSync(
        "item_ids.json",
        itemIdsData as number[],
    )
}

export function getItemLookupSync(): Readonly<Record<string, string>> {
    return getRuntimeContentTableSync(
        "item_lookup.json",
        itemLookupData as Record<string, string>,
    )
}

// ─── Item sale data ──────────────────────────────────────────────────────

/**
 * Gets item sale properties (price, sellable, category) from CDN data.
 * Returns null if item not found in the dataset.
 */
export function getItemSaleSync(id: number | string): ItemSaleEntry | null {
    const table = getRuntimeContentTableSync(
        "item_sale.json",
        itemSaleData as Record<string, ItemSaleEntry>,
    )
    const entry = table[String(id)]
    return entry ?? null
}

// ─── Equipment craft / dissolve cost data ────────────────────────────────

/**
 * Gets equipment craft-point costs and dissolve rates by rarity (1-5).
 * Returns null if rarity is invalid.
 */
export function getEquipmentCraftSync(rarity: number): EquipmentCraftEntry | null {
    const table = getRuntimeContentTableSync(
        "equipment_craft.json",
        equipmentCraftData as Record<string, EquipmentCraftEntry>,
    )
    const entry = table[String(Math.max(1, Math.min(5, rarity)))]
    return entry ?? null
}
