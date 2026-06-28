import { PlayerBoxGachaDrawnReward, UserRushEventPlayedParty } from "../data/types"

// ─── Branded types ──────────────────────────────────────────────────────
// Compile-time tags to distinguish accountId vs playerId in function signatures.
// Zero runtime cost — erased to plain `number` in emitted JavaScript.

declare const AccountIdBrand: unique symbol
declare const PlayerIdBrand: unique symbol
export type AccountId = number & { [AccountIdBrand]: never }
export type PlayerId = number & { [PlayerIdBrand]: never }

export function asAccountId(id: number): AccountId { return id as AccountId }
export function asPlayerId(id: number): PlayerId { return id as PlayerId }

// enums
export enum RewardType {
    ITEM,
    EQUIPMENT,
    CHARACTER,
    BEADS,
    MANA,
    EXP,
    ELEMENT,
    AETHER
}

export enum BoxGachaRewardType {
    ITEM,
    EQUIPMENT,
    EMPTY,
    MANA,
    EXP,
    CHARACTER
}

export enum QuestCategory {
    EMPTY,
    MAIN, //
    BOSS_BATTLE, //
    CHARACTER, //
    EX, //
    EMPTY2,
    DAILY_WEEK_EVENT, //
    ADVENT_EVENT_SINGLE, //
    ADVENT_EVENT_MULTI, //
    TUTORIAL,
    STORY_EVENT_SINGLE, //?
    RANKING_EVENT_SINGLE, //?
    EMPTY3,
    CHALLENGE_DUNGEON_EVENT, //?
    DAILY_EXP_MANA_EVENT, //
    PRACTICE,
    SKILL_PREVIEW,
    EMPTY4,
    WORLD_STORY_EVENT, //
    WORLD_STORY_EVENT_BOSS_BATTLE, //
    TOWER_DUNGEON_EVENT, //?
    EXPERT_SINGLE_EVENT, //?
    CARNIVAL_EVENT, //?
    RAID_EVENT, //?
    RUSH_EVENT, //?
    SOLO_TIME_ATTACK_EVENT, //?
    HARD_MULTI_EVENT,
    SCORE_ATTACK_EVENT //?
}

export enum Element {
    FIRE,
    WATER,
    LIGHTNING,
    WIND,
    LIGHT,
    DARK
}

export enum ScoreRewardType {
    ITEM,
    RARE_POOL
}

export enum ShopItemRewardType {
    ITEM,
    EXP,
    MANA,
    CHARACTER,
    EQUIPMENT
}

export enum ShopItemUserCostType {
    BEADS,
    MANA,
    AMITY_SCROLL,
}

export enum ShopType {
    U0,
    U1,
    TREASURE,
    SPECIAL_PACK,
    EVENT_ITEM,
    U5,
    U6,
    BOSS_COIN,
    GENERAL,
    STAR_GRAIN,
    TREASURE_EQUIPMENT = 10  // CN: 追忆装备强化 / 特殊装备强化
}

export enum RushEventFolder {
    NONE,
    INTERMEDIATE,
    ADVANCED,
    GODLY,
    ENDLESS
}

// clear rewards
export interface Reward {
    name?: string,
    type: RewardType,
    id?: number,
}

export interface EquipmentItemReward extends Reward {
    id: number,
    count: number
}

export interface CharacterReward extends Reward {
    id: number
}

export interface CurrencyReward extends Reward {
    count: number
}

export interface RareScoreReward extends Reward {
    rarity: number
}

export type ClearRewards = Record<string, Reward>

// score rewards
export interface ScoreReward {
    name: string,
    type: ScoreRewardType,
    position?: number, // orderedmap position (preserved from CDN), used as drop_score_reward_ids index
}

export interface CommonScoreReward extends ScoreReward {
    reward_type: RewardType
}

export interface CurrencyScoreReward extends CommonScoreReward {
    count: number
    field5: number
}

export interface ItemScoreReward extends CommonScoreReward {
    id: number,
    count: number,
    field5: number
}

export interface RareScoreRewardGroup extends ScoreReward {
    id: number,
    rarity: number
}

export type ScoreRewardGroups = Record<string, ScoreReward[]>

export type RareScoreRewardGroups = Record<string, Reward[]>

// shop rewards
export interface ShopItemReward {
    type: ShopItemRewardType,
}

export interface EquipmentItemShopItemReward extends ShopItemReward {
    id: number,
    count: number
}

export interface CharacterShopItemReward extends ShopItemReward {
    id: number
}

export interface CurrencyShopItemReward extends ShopItemReward {
    count: number
}

export interface RawQuest {
    name: string,
    clearRewardId?: number,
    sPlusRewardId?: number,
    scoreRewardGroupId?: number,
    eventId?: number,
    folderId?: number,
    bRankTime?: number,
    aRankTime?: number,
    sRankTime?: number,
    sPlusRankTime?: number,
    rankPointReward?: number,
    characterExpReward?: number,
    manaReward?: number,
    poolExpReward?: number,
    fixedParty?: number,
    rushEventId?: number
    rushEventFolderId?: number
    rushEventRound?: number
    element?: number
}

export interface StoryQuest {
    name: string,
    clearReward?: Reward
}

export interface BattleQuest {
    name: string,
    clearReward?: Reward,
    sPlusReward?: Reward,
    scoreRewardGroupId?: number,
    scoreRewardGroup?: ScoreReward[],
    eventId?: number,
    folderId?: number,
    bRankTime: number,
    aRankTime: number,
    sRankTime: number,
    sPlusRankTime: number,
    rankPointReward: number,
    characterExpReward: number,
    manaReward: number,
    poolExpReward: number,
    fixedParty?: number,
    rushEventId?: number
    rushEventFolderId?: RushEventFolder
    rushEventRound?: number
    element?: number
}

export type RawQuests = Record<string, RawQuest>

export interface AssetCharacter {
    name: string
    rarity: number,
    element: Element,
    skill_count: number
}

export type RawAssetCharacters = Record<string, AssetCharacter>

export interface AddExpListItem {
    character_id: number,
    add_exp: number,
    after_exp: number,
    add_exp_pool: number
}

export type AddExpList = AddExpListItem[]

export interface ClientReturnCharacter {
    character_id: number
    exp: number
    create_time: string
    update_time: string
    join_time: string
    exp_total: number
}

export interface ClientReturnBondTokenStatus {
    mana_board_index: number,
    status: number
}

export interface ClientReturnBondTokenStatusListItem {
    before: ClientReturnBondTokenStatus[]
    after: ClientReturnBondTokenStatus[]
}

export type ClientReturnBondTokenStatusList = Record<string, ClientReturnBondTokenStatusListItem>

export interface RewardPlayerCharacterExpResult {
    add_exp_list: AddExpList
    character_list: ClientReturnCharacter[]
    bond_token_status_list: ClientReturnBondTokenStatusList
    exp_pool: number
}

// quest types
export interface GivePlayerCharacterResult {
    character: Object,
    item?: {
        id: number,
        count: number
    }
}

export interface PlayerRewardResult {
    user_info: {
        free_mana: number
        free_vmoney: number
        exp_pool: number
    },
    character_list: Object[]
    joined_character_id_list: number[]
    equipment_list: Object[]
    items: Record<string, number>
}

export interface DropScoreRewardId {
    group_id: number,
    index: number,
    number: number
}

export interface GivePlayerScoreRewardsResult extends PlayerRewardResult {
    drop_score_reward_ids: DropScoreRewardId[]
    drop_rare_reward_ids: DropScoreRewardId[]
}

// mana nodes
export interface ManaNode {
    items: Record<string, number>,
    manaCost: number,
    field1: string,
    field5: string,
    field6: string
}

export type ManaNodes = Record<string, Record<string, Record<string, ManaNode>>>

// ex ability
export type ExAbilities = Record<string, string[][]>

export type ExStatus = Record<string, number[]>

export interface ExBoostItem {
    tier: number,
    count: number,
    element?: Element
}

export type ExBoostItems = Record<string, ExBoostItem>;

// box gachas
export enum BoxGachaRewardTier {
    COMMON,
    RARE,
    FEATURED
}

export interface BoxGachaReward {
    type: BoxGachaRewardType,
    count: number,
    available: number,
    tier: BoxGachaRewardTier,
}

export interface BoxGachaIdReward extends BoxGachaReward {
    id: number
}

export type BoxGachaBox = Record<string, BoxGachaReward>
export type BoxGachaBoxes = Record<string, BoxGachaBox>

export interface RawBoxGacha {
    itemId: number,
    count: number,
    availableCounts: Record<string, number>
}

export type RawBoxGachas = Record<string, RawBoxGacha>

export type RawBoxRewards = Record<string, BoxGachaBoxes>

export interface BoxGacha {
    redeemItemId: number,
    redeemItemCount: number,
    boxes: Record<string, BoxGachaBox>
    availableCounts: Record<string, number>
}

export interface BoxGachaDrawResult {
    rewards: PlayerBoxGachaDrawnReward[]
    mana: number
    exp: number
    characters: Map<number, number>
    equipment: Map<number, number>
    items: Map<number, number>
}

// gacha
export enum GachaType {
    CHARACTER,
    WEAPON
}

export enum GachaMovieType {
    NORMAL,
    GUARANTEE
}

export interface GachaPoolItem {
    id: number,
    rank: number,
    odds: number,
    isRateUp: boolean,
    rarity: number
}

export interface Gacha {
    type: GachaType,
    paymentType: number,
    singleCost: number,
    multiCost: number,
    discountCost: number,
    startDate: string,
    endDate: string,
    pool: Record<string, GachaPoolItem[]>
}

export interface CharacterGacha extends Gacha {
    movieName: string,
    guaranteeMovieName: string
}

export type Gachas = Record<string, Gacha>

export type GachaDrawResult = number[]

export interface RewardPlayerGachaDrawResult {
    draw: GachaDraws,
    characters: Object[],
    equipment: Object[],
    items: Record<number, number>
}

export interface GachaCharacterDraw {
    character_id: number,
    movie_id: string,
    seed: number,
    entry_count: number,
    ex_boost_item?: {
        id: number,
        count: number
    } | []
}

export interface GachaEquipmentDraw {
    equipment_id: number,
    treasure_up_type: number
}

export type GachaDraws = (GachaCharacterDraw | GachaEquipmentDraw)[]

export type GachaMovieSeeds = Record<string, Record<string, number[]>>

// shops
export interface ShopItemCost {
    id: number,
    amount: number
}

export interface ShopItemUserCost {
    type: ShopItemUserCostType
    amount: number
}

export interface ShopItem {
    costs: ShopItemCost[] | never[],
    rewards: ShopItemReward[] | never[],
    availableFrom: string,
    availableUntil: string | null,
    stock: number
    userCost?: ShopItemUserCost
    shopCategoryId?: number
    groupId?: number
    stage?: number
    equipmentId?: number
    enhancementMaxLevel?: number
    requireAwakeningLevel?: number
    maxFrequency?: number
    dailyStock?: number
    monthlyStock?: number
}

export interface EventItemShopIdMapItem {
    eventType: number
    eventId: number
}

export type ShopItems = Record<string, ShopItem>
export type BossCoinShopItems = Record<string, ShopItems>
export type EventShopItems = Record<string, BossCoinShopItems>

// rush event
export type RushEventFolders = Record<string, Record<string, Reward[]>>
export type SerializedPlayerRushEventPlayedPartyList = Record<number, UserRushEventPlayedParty>
export interface SerializedPlayerRushEventPlayedParties {
    folderParties: SerializedPlayerRushEventPlayedPartyList
    endlessParties: SerializedPlayerRushEventPlayedPartyList
}

// multi battle quest types
export interface MultiMatePartyCharacter {
    id: number
    evolution_level: number
    exp: number
    over_limit_step: number
    mana_node_ids: number[] | null
    ex_boost: {
        ability_id_list: number[]
        status_id: number
    } | null
}

export interface MultiMateEquipment {
    equipment_id: number
    level: number
    enhancement_level: number
}

export interface MultiMateParty {
    characters: (MultiMatePartyCharacter | null)[]
    unison_characters: (MultiMatePartyCharacter | null)[]
    equipments: (MultiMateEquipment | null)[]
    ability_soul_ids: (number | null)[]
}

export interface MultiMate {
    com_id: number
    degree_id: number
    rank: number
    party: MultiMateParty
}

export interface MultiRoom {
    room_number: string
    access_token: string
    category: QuestCategory
    quest_id: number
    host_viewer_id: number
    host_player_id: number
    host_party_id: number
    host_main_character_id: number
    accepted_type: number
    created_at: number
    raising_state: number
    room_sequence: number
    host_entry_time: number
    mates: Array<{ viewer_id: number | null, com_id: number, player_id?: number }>
    share_room_options: number
    is_npc_mode: boolean
    npc_count: number  // fixed NPC count per battle: 0=unrecruited, 1/2=fixed count
}

export interface NpcMateTemplate {
    com_id: 1 | 2
    characters: number[]
    unison_characters: number[]
    equipments: number[]
    ability_soul_ids: number[]
    rank: number
    degree_id: number
}

// config values (TODO: 待从CDN二进制提取真实数据)
export interface ConfigValues {
    continue_virtual_money: number
    stamina_recovery_virtual_money: number
    stamina_recovery_seconds: number
    stamina_recovery_value: number
    max_stamina_overflow: number
    max_virtual_money: number
    max_mana: number
    max_star_crumb: number
    pool_exp_gain_value: number
    pool_exp_gain_seconds: number
    max_pool_exp: number
    max_display_pool_exp: number
    max_follows_count: number
    max_followers_count: number
    max_display_followers_count: number
    max_player_name_length: number
    max_player_comment_length: number
    overflow_exp_to_mana_conversion_rate: number
    reward_multiplier_by_boost_point: number
    common_reward_multiplier_by_multi_play_mode: number
    limit_payment_under_16: number
    limit_payment_16_19: number
    alert_payment: number
    level_correction_value_by_recommended_element: number
    level_correction_value_for_moderate_level_comparison: number
    unknown_loc2: number
    max_bond_token: number
    treasure_shop_item_number: number
    special_pack_shop_days_as_new: number
    support_url: string
    max_boss_boost_point: number
    max_display_boss_boost_point: number
    max_boost_point: number
    max_display_boost_point: number
    craft_point_item_id: number
    wildcard_once_character_ticket_item_id: number
    wildcard_ten_times_character_ticket_item_id: number
    wildcard_once_rare4_character_ticket_item_id: number
    wildcard_once_equipment_ticket_item_id: number
    wildcard_ten_times_equipment_ticket_item_id: number
    encyclopedia_point_item_id: number
    star_grain_item_id: number
    gacha_one_max_count: number
    gacha_ten_max_count: number
    growth_fund_unlock_chapter: number
    gacha_crazy_ten_max_count: number
    monthly_bonus_payment_total_requirement: number
    crazygacha_ten_times_character_ticket_id: number
    reward_multiplier_by_newbie: number
    newbie_rank: number
    newbie_days: number
}

// ─── Equipment dissolve CDN data ───────────────────────────────────────

export interface EquipmentDissolveEntry {
    ability_soul_id: number
    obtain_source: number
    generate_ability_soul: boolean
}

// ─── Item sale CDN data ─────────────────────────────────────────────────

export interface ItemSaleEntry {
    category: number
    sale_price: number
    sellable: boolean
}