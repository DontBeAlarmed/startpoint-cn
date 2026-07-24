import { deepFreeze } from "../deep-freeze"
import type {
    ContentSourceReference,
    GachaOddsDynamicSourceReference,
    TableScope,
} from "./schema"

export interface TableSourceDefinition {
    readonly tableName: string
    readonly scope: TableScope
    readonly sourceOrderedMaps: readonly string[]
    readonly dynamicSources: readonly GachaOddsDynamicSourceReference[]
    readonly manifestSources: readonly ContentSourceReference[]
    readonly bundledPath: string
    readonly converterId: string
    readonly converterVersion: number
    readonly outputShapeVersion: number
}

type TableSourceInput = Omit<
    TableSourceDefinition,
    "bundledPath" | "dynamicSources" | "manifestSources"
> & {
    readonly dynamicSources?: readonly GachaOddsDynamicSourceReference[]
}

const GACHA_ODDS_DYNAMIC_SOURCE: GachaOddsDynamicSourceReference = {
    kind: "gacha-odds-references",
    sourceOrderedMap: "master/gacha/gacha.orderedmap",
    logicalPathTemplate: "master/gacha_odds/{oddsId}.orderedmap",
    rarityOddsColumn: 11,
    prizeKindColumn: 13,
    poolOddsColumns: [
        { prizeKind: "0", columns: [14, 15, 16] },
        { prizeKind: "1", columns: [22, 23, 24] },
    ],
    referenceNormalization: "trim",
    skipReferences: ["", "(None)"],
    order: "lexicographic",
    missingReference: "error",
}

const BUNDLED_TABLE_NAMES = [
    "advent_event_quest.json",
    "boss_battle_quest.json",
    "box_gacha.json",
    "box_gacha_box_settings.json",
    "box_reward.json",
    "carnival_event_quest.json",
    "carnival_event_total_score_reward.json",
    "cdndata/player_rank.json",
    "cdndata/player_rank_full.json",
    "challenge_dungeon_event_quest.json",
    "character_quest.json",
    "character_quest_lookup.json",
    "clear_reward.json",
    "daily_challenge_point_lookup.json",
    "daily_exp_mana_event_quest.json",
    "daily_week_event_quest.json",
    "encyclopedia.json",
    "equipment_craft.json",
    "equipment_dissolve.json",
    "equipment_gacha_movie_probability.json",
    "equipment_ids.json",
    "equipment_lookup.json",
    "event_challenge_point_map.json",
    "ex_ability.json",
    "ex_boost.json",
    "ex_quest.json",
    "ex_status.json",
    "expert_single_event_quest.json",
    "hard_multi_event_quest.json",
    "item_data.json",
    "item_ids.json",
    "item_lookup.json",
    "item_sale.json",
    "main_quest.json",
    "mana_board.json",
    "mana_node.json",
    "mana_node_awake.json",
    "mission_active_reward.json",
    "mission_char_awake.json",
    "mission_char_awake_reward.json",
    "mission_collect_item.json",
    "mission_collect_item_reward.json",
    "mission_daily.json",
    "mission_daily_reward.json",
    "mission_degree.json",
    "mission_degree_reward.json",
    "mission_event.json",
    "mission_event_battle_rules.json",
    "mission_event_quest_map.json",
    "mission_event_reward.json",
    "mission_pass_daily.json",
    "mission_pass_daily_reward.json",
    "mission_pass_event.json",
    "mission_pass_event_reward.json",
    "mission_pass_week.json",
    "mission_pass_week_reward.json",
    "mission_regular.json",
    "mission_regular_reward.json",
    "mission_weekly_def.json",
    "mission_weekly_reward.json",
    "pass_card_event.json",
    "pass_card_reward.json",
    "practice_quest.json",
    "quest_entry_costs.json",
    "quest_lookup.json",
    "quest_unlock_costs.json",
    "raid_event_quest.json",
    "ranking_event_single_quest.json",
    "rare_score_reward.json",
    "reward_element_map.json",
    "rush_event_quest.json",
    "rush_event_quest_folder.json",
    "rush_event_ranking_reward.json",
    "score_attack_border_reward.json",
    "score_attack_event_quest.json",
    "score_reward.json",
    "solo_time_attack_event_quest.json",
    "stamina_campaign.json",
    "star_crumb_exchange.json",
    "star_crumb_exchange_cost.json",
    "story_event_single_quest.json",
    "tower_dungeon_event_quest.json",
    "world_story_event_boss_battle_quest.json",
    "world_story_event_quest.json",
] as const

const SERVER_TABLE_NAMES = [
    "cdn_general_shop_whitelist.json",
    "config.json",
    "news.json",
    "payment_products.json",
] as const

function bundledDefinition(tableName: string): TableSourceInput {
    return {
        tableName,
        scope: "bundled",
        sourceOrderedMaps: [`assets/${tableName}`],
        converterId: "bundled-json",
        converterVersion: 1,
        outputShapeVersion: 1,
    }
}

function serverDefinition(tableName: string): TableSourceInput {
    return {
        tableName,
        scope: "server",
        sourceOrderedMaps: [`assets/${tableName}`],
        converterId: "server-json",
        converterVersion: 1,
        outputShapeVersion: 1,
    }
}

const definitionInputs: TableSourceInput[] = [
    {
        tableName: "character.json",
        scope: "cdn",
        sourceOrderedMaps: ["master/character/character.orderedmap"],
        converterId: "character",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "cdndata/character.json",
        scope: "cdn",
        sourceOrderedMaps: ["master/character/character.orderedmap"],
        converterId: "character",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "cdndata/character_text.json",
        scope: "cdn",
        sourceOrderedMaps: ["master/character/character_text.orderedmap"],
        converterId: "character",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "gacha.json",
        scope: "cdn",
        sourceOrderedMaps: ["master/gacha/gacha.orderedmap"],
        dynamicSources: [GACHA_ODDS_DYNAMIC_SOURCE],
        converterId: "gacha",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "gacha_campaign.json",
        scope: "cdn",
        sourceOrderedMaps: ["master/gacha/gacha_campaign.orderedmap"],
        converterId: "gacha",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "cdndata/gacha.json",
        scope: "cdn",
        sourceOrderedMaps: ["master/gacha/gacha.orderedmap"],
        converterId: "gacha",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "cdndata/gacha_feature_content.json",
        scope: "cdn",
        sourceOrderedMaps: ["master/gacha/gacha_feature_content.orderedmap"],
        converterId: "gacha",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "general_shop.json",
        scope: "cdn",
        sourceOrderedMaps: ["master/shop/general_shop.orderedmap"],
        converterId: "shop",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "event_item_shop.json",
        scope: "cdn",
        sourceOrderedMaps: ["master/shop/event_item_shop.orderedmap"],
        converterId: "shop",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "event_item_shop_id_map.json",
        scope: "cdn",
        sourceOrderedMaps: ["master/shop/event_item_shop.orderedmap"],
        converterId: "shop",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "boss_coin_shop.json",
        scope: "cdn",
        sourceOrderedMaps: [
            "master/shop/boss_coin_shop.orderedmap",
            "master/shop/boss_coin_shop_category.orderedmap",
        ],
        converterId: "shop",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "boss_coin_shop_item_category_map.json",
        scope: "cdn",
        sourceOrderedMaps: [
            "master/shop/boss_coin_shop.orderedmap",
            "master/shop/boss_coin_shop_category.orderedmap",
        ],
        converterId: "shop",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "star_grain_shop.json",
        scope: "cdn",
        sourceOrderedMaps: ["master/shop/star_grain_shop.orderedmap"],
        converterId: "shop",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "treasure_shop.json",
        scope: "cdn",
        sourceOrderedMaps: ["master/shop/treasure_shop.orderedmap"],
        converterId: "shop",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    {
        tableName: "equipment_enhancement_shop.json",
        scope: "cdn",
        sourceOrderedMaps: [
            "master/equipment_enhancement/equipment_enhancement_shop.orderedmap",
            "master/equipment_enhancement/equipment_enhancement_shop_category.orderedmap",
        ],
        converterId: "shop",
        converterVersion: 1,
        outputShapeVersion: 1,
    },
    ...BUNDLED_TABLE_NAMES.map(bundledDefinition),
    ...SERVER_TABLE_NAMES.map(serverDefinition),
]

const definitions: TableSourceDefinition[] = definitionInputs.map(definition => {
    const dynamicSources = definition.dynamicSources ?? []
    return {
        ...definition,
        dynamicSources,
        manifestSources: [...definition.sourceOrderedMaps, ...dynamicSources],
        bundledPath: `assets/${definition.tableName}`,
    }
})

definitions.sort((left, right) => (
    left.tableName < right.tableName ? -1 : left.tableName > right.tableName ? 1 : 0
))

export const TABLE_SOURCES: readonly TableSourceDefinition[] = deepFreeze(definitions)

const definitionsByName = new Map(TABLE_SOURCES.map(definition => [definition.tableName, definition]))

export function findTableSource(tableName: string): TableSourceDefinition {
    const definition = definitionsByName.get(tableName)
    if (!definition) throw new Error(`content table is not registered: ${tableName}`)
    return definition
}
