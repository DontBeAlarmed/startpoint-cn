import type { MissionSettlementResult } from "./settlement"

type ResponseRecord = Record<string, any>

function mergeCharacterList(existing: ResponseRecord[], added: Object[]): ResponseRecord[] {
    const result = existing.map(character => ({ ...character }))
    const indexById = new Map<number, number>()
    for (let index = 0; index < result.length; index++) {
        const id = Number(result[index].character_id ?? result[index].id)
        if (Number.isFinite(id)) indexById.set(id, index)
    }

    for (const rawCharacter of added as ResponseRecord[]) {
        const character = { ...rawCharacter }
        const id = Number(character.character_id ?? character.id)
        const existingIndex = indexById.get(id)
        if (existingIndex === undefined || !Number.isFinite(id)) {
            result.push(character)
            if (Number.isFinite(id)) indexById.set(id, result.length - 1)
            continue
        }

        const previous = result[existingIndex]
        const previousAwake = previous.mana_board_awake
        const nextAwake = character.mana_board_awake
        result[existingIndex] = {
            ...previous,
            ...character,
            ...(previousAwake || nextAwake
                ? { mana_board_awake: { ...(previousAwake ?? {}), ...(nextAwake ?? {}) } }
                : {}),
        }
    }
    return result
}

function mergeEquipmentList(existing: ResponseRecord[], added: Object[]): ResponseRecord[] {
    const result = existing.map(equipment => ({ ...equipment }))
    const indexById = new Map<number, number>()
    for (let index = 0; index < result.length; index++) {
        const id = Number(result[index].equipment_id ?? result[index].id)
        if (Number.isFinite(id)) indexById.set(id, index)
    }
    for (const rawEquipment of added as ResponseRecord[]) {
        const equipment = { ...rawEquipment }
        const id = Number(equipment.equipment_id ?? equipment.id)
        const existingIndex = indexById.get(id)
        if (existingIndex === undefined || !Number.isFinite(id)) {
            result.push(equipment)
            if (Number.isFinite(id)) indexById.set(id, result.length - 1)
        } else {
            result[existingIndex] = { ...result[existingIndex], ...equipment }
        }
    }
    return result
}

export function mergeMissionSettlementResponse(
    data: ResponseRecord,
    settlement: MissionSettlementResult,
    viewerId: number,
): void {
    data.mission_info = [...(data.mission_info ?? []), ...settlement.missionInfo]
    data.item_list = { ...(data.item_list ?? {}), ...settlement.itemList }
    data.character_list = mergeCharacterList(data.character_list ?? [], settlement.characterList)
    data.equipment_list = mergeEquipmentList(data.equipment_list ?? [], settlement.equipmentList)
    if (settlement.userInfo) {
        data.user_info = { ...(data.user_info ?? {}), ...settlement.userInfo }
    }

    const degreeById = new Map<number, ResponseRecord>()
    for (const degree of data.degree_list ?? []) {
        const degreeId = Number(degree.degree_id)
        if (Number.isFinite(degreeId)) degreeById.set(degreeId, degree)
    }
    for (const degreeId of settlement.degreeIds) {
        degreeById.set(degreeId, { viewer_id: viewerId, degree_id: degreeId })
    }
    data.degree_list = [...degreeById.values()]
}
