import { Element } from "./quest"

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


export interface GivePlayerCharacterResult {
    isNew: boolean,
    character: Object,
    item?: {
        id: number,
        count: number
    }
}


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
