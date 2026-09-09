import { mergeCommonResponseFragments } from "../common-response/merge"
import {
    projectCharacterPatch,
    projectEquipmentPatch,
} from "../common-response/entities"
import type {
    CommonResponseFragment,
    CommonResponseRecord,
} from "../common-response/model"
import { projectItemOverflowCommonResponse } from "../item-overflow/common-response"
import type { MissionSettlementResult } from "./settlement"

type ResponseTarget = Record<string, unknown>
type SettlementRecord = Record<string, unknown>

export interface MissionSettlementResponseFragment {
    readonly common: CommonResponseFragment
    readonly degreeIds: readonly number[]
}

function isRecord(value: unknown): value is SettlementRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasOwn(value: object, field: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, field)
}

function copyRecord(value: unknown, field: string): CommonResponseRecord {
    if (!isRecord(value)) throw new TypeError(`${field} entry must be an object`)
    return { ...value }
}

function copyRecordList(
    value: unknown,
    field: string,
): readonly CommonResponseRecord[] | null {
    if (value === null) return null
    if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
    return value.map(entry => copyRecord(entry, field))
}

function copyItemList(value: unknown): CommonResponseFragment["item_list"] {
    if (value === null) return null
    if (Array.isArray(value)) {
        if (value.length > 0) throw new TypeError("itemList legacy array must be empty")
        return []
    }
    if (!isRecord(value)) throw new TypeError("itemList must be an object")
    return { ...value } as Readonly<Record<string, number>>
}

function copyCharacterList(value: unknown): CommonResponseFragment["character_list"] {
    if (value === null) return null
    if (!Array.isArray(value)) throw new TypeError("characterList must be an array")
    return value.map(entry => projectCharacterPatch(entry))
}

function copyEquipmentList(value: unknown): CommonResponseFragment["equipment_list"] {
    if (value === null) return null
    if (!Array.isArray(value)) throw new TypeError("equipmentList must be an array")
    return value.map(entry => projectEquipmentPatch(entry))
}

export function projectMissionSettlementFragment(
    settlement: MissionSettlementResult,
): MissionSettlementResponseFragment {
    const common: {
        user_info?: CommonResponseFragment["user_info"]
        item_list?: CommonResponseFragment["item_list"]
        character_list?: CommonResponseFragment["character_list"]
        equipment_list?: CommonResponseFragment["equipment_list"]
        mission_info?: CommonResponseFragment["mission_info"]
        over_max?: CommonResponseFragment["over_max"]
    } = {}

    if (hasOwn(settlement, "missionInfo")) {
        common.mission_info = copyRecordList(settlement.missionInfo, "missionInfo")
    }
    if (hasOwn(settlement, "itemList")) {
        common.item_list = copyItemList(settlement.itemList)
    }
    if (hasOwn(settlement, "characterList")) {
        common.character_list = copyCharacterList(settlement.characterList)
    }
    if (hasOwn(settlement, "equipmentList")) {
        common.equipment_list = copyEquipmentList(settlement.equipmentList)
    }
    if (hasOwn(settlement, "userInfo")) {
        common.user_info = settlement.userInfo === null
            ? null
            : settlement.userInfo === undefined
                ? undefined
                : copyRecord(settlement.userInfo, "userInfo")
    }

    const dispositions = settlement.itemOverflowDispositions
    if (Array.isArray(dispositions) && dispositions.length > 0) {
        common.over_max = projectItemOverflowCommonResponse(dispositions)
    }

    return {
        common,
        degreeIds: Array.isArray(settlement.degreeIds) ? [...settlement.degreeIds] : [],
    }
}

const COMMON_FIELDS = [
    "user_info",
    "item_list",
    "character_list",
    "equipment_list",
    "mission_info",
    "over_max",
    "mail_arrived",
] as const

function readCommonResponse(data: ResponseTarget): CommonResponseFragment {
    const fragment: Record<string, unknown> = {}
    for (const field of COMMON_FIELDS) {
        if (hasOwn(data, field)) fragment[field] = data[field]
    }
    return fragment as CommonResponseFragment
}

export function mergeMissionDegreeList(
    data: ResponseTarget,
    degreeIds: readonly number[],
    viewerId: number,
): void {
    const degreeById = new Map<number, ResponseTarget>()
    const existing = data.degree_list
    if (Array.isArray(existing)) {
        for (const entry of existing) {
            if (!isRecord(entry)) continue
            const degreeId = Number(entry.degree_id)
            if (Number.isFinite(degreeId)) degreeById.set(degreeId, { ...entry })
        }
    }
    for (const degreeId of degreeIds) {
        degreeById.set(degreeId, { viewer_id: viewerId, degree_id: degreeId })
    }
    data.degree_list = [...degreeById.values()]
}

export function composeMissionSettlementResponse(
    data: ResponseTarget,
    fragment: MissionSettlementResponseFragment,
    viewerId: number,
): void {
    const common = mergeCommonResponseFragments([
        readCommonResponse(data),
        fragment.common,
    ])
    for (const field of COMMON_FIELDS) {
        if (hasOwn(common, field)) data[field] = common[field]
    }
    mergeMissionDegreeList(data, fragment.degreeIds, viewerId)
}
