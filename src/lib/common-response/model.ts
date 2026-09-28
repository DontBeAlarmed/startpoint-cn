export type CommonResponseRecord = Readonly<Record<string, unknown>>
export type ItemListFragment = Readonly<Record<string, number>> | readonly never[]

export type CharacterFragment = Readonly<{
    readonly character_id: number
    readonly mana_board_awake?: Readonly<Record<string, unknown>>
    readonly [field: string]: unknown
}>

export type EquipmentFragment = Readonly<{
    readonly equipment_id: number
    readonly [field: string]: unknown
}>

export interface CommonResponseFragment {
    readonly user_info?: CommonResponseRecord | null
    readonly item_list?: ItemListFragment | null
    readonly character_list?: readonly CharacterFragment[] | null
    readonly equipment_list?: readonly EquipmentFragment[] | null
    readonly mission_info?: readonly CommonResponseRecord[] | null
    readonly over_max?: readonly CommonResponseRecord[] | null
    readonly active_mission_list?: readonly unknown[] | null
    readonly mail_arrived?: boolean | null
}

export type CommonResponseProjection = CommonResponseFragment
