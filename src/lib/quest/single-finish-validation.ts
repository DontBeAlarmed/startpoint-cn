const STATISTIC_SAFE_INTEGER_FIELDS = [
    "max_combo_count", "max_power", "max_skill_chain_count", "overflow_damge_count",
] as const

const ZONE_SAFE_INTEGER_FIELDS = [
    "use_power_flip_count", "use_dash_count", "use_skill_count", "send_emotion_count",
    "fever_count", "fever_ms", "use_debuff_to_enemy_count", "clear_buff_of_enemy_count",
    "clear_debuff_of_self_count", "use_buff_to_all_party_members", "use_emotion_count",
    "enemy_kill_count", "weak_point_attack_count", "use_power_flip_lv3_count",
    "coffin_count_reduced_count", "max_coffin_count_by_revival", "encoffinment_count",
] as const

const ZONE_FINITE_NUMBER_FIELDS = [
    "use_heal_to_all_party_members", "damage_deal_max", "damage_deal_total",
] as const

const INT32_MAX = 2_147_483_647
const HISTORY_CATEGORIES = new Set([15, 27])

type StatisticSafeIntegerField = typeof STATISTIC_SAFE_INTEGER_FIELDS[number]
type ZoneSafeIntegerField = typeof ZONE_SAFE_INTEGER_FIELDS[number]
type ZoneFiniteNumberField = typeof ZONE_FINITE_NUMBER_FIELDS[number]

export interface SingleFinishPartyMember {
    id: number | null
    [key: string]: unknown
}

export interface SingleFinishPartyStatistics {
    characters: (SingleFinishPartyMember | null)[]
    unison_characters: (SingleFinishPartyMember | null)[]
    equipments: (SingleFinishPartyMember | null)[]
    ability_soul_ids: (number | null)[]
    [key: string]: unknown
}

export interface SingleFinishBattleMember {
    debuff_r?: number
    origin_damage?: number
    [key: string]: unknown
}

export type SingleFinishZoneStatistics =
    Partial<Record<ZoneSafeIntegerField | ZoneFiniteNumberField, number>> & {
        members?: (SingleFinishBattleMember | null)[]
        [key: string]: unknown
    }

export type SingleFinishStatistics = Partial<Record<StatisticSafeIntegerField, number>> & {
    clear_phase: number
    party: SingleFinishPartyStatistics
    zones: SingleFinishZoneStatistics[]
    [key: string]: unknown
}

export interface ValidatedSingleFinishBody {
    play_id: string
    is_restored: boolean
    continue_count: number
    elapsed_time_ms: number
    quest_id: number
    category: number
    score: number
    viewer_id: number
    add_mana: number
    is_accomplished: boolean
    statistics: SingleFinishStatistics
    equipment_element?: number[]
    [key: string]: unknown
}

export type SingleFinishValidationResult =
    | { ok: true, body: ValidatedSingleFinishBody }
    | { ok: false, message: string }

const INVALID_REQUEST_BODY = "Invalid request body."

function invalid(): SingleFinishValidationResult {
    return { ok: false, message: INVALID_REQUEST_BODY }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function isPositiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0
}
function isNonNegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0
}
function isNonNegativeInt32(value: unknown): value is number {
    return isNonNegativeSafeInteger(value) && value <= INT32_MAX
}
function isNonNegativeFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isPartyMember(value: unknown): value is SingleFinishPartyMember | null {
    return value === null
        || (isPlainObject(value) && (value.id === null || isPositiveSafeInteger(value.id)))
}

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key)
}

function hasValidOptionalFields(
    value: Record<string, unknown>,
    fields: readonly string[],
    predicate: (fieldValue: unknown) => boolean,
): boolean {
    return fields.every(field => !hasOwn(value, field) || predicate(value[field]))
}

function isBattleMember(value: unknown): value is SingleFinishBattleMember | null {
    return value === null || (isPlainObject(value)
        && hasValidOptionalFields(value, ["debuff_r"], isNonNegativeInt32)
        && hasValidOptionalFields(value, ["origin_damage"], isNonNegativeFiniteNumber))
}

function isZone(value: unknown): value is SingleFinishZoneStatistics {
    if (!isPlainObject(value)
        || !hasValidOptionalFields(value, ZONE_SAFE_INTEGER_FIELDS, isNonNegativeInt32)
        || !hasValidOptionalFields(value, ZONE_FINITE_NUMBER_FIELDS, isNonNegativeFiniteNumber)) {
        return false
    }
    return !hasOwn(value, "members")
        || (Array.isArray(value.members) && value.members.every(isBattleMember))
}

function hasValidInt32Aggregate(
    zones: SingleFinishZoneStatistics[],
    field: "use_power_flip_count" | "use_dash_count",
): boolean {
    let total = 0
    for (const zone of zones) {
        const value = zone[field] ?? 0
        if (value > INT32_MAX - total) return false
        total += value
    }
    return true
}

function hasValidHistoryAggregates(zones: SingleFinishZoneStatistics[]): boolean {
    if (zones.length === 0) return false
    let totalDamage = 0
    const memberDamage = [0, 0, 0]
    for (const zone of zones) {
        if (!hasOwn(zone, "damage_deal_total")) return false
        totalDamage += zone.damage_deal_total!
        if (!Number.isFinite(totalDamage)) return false
        for (let index = 0; index < memberDamage.length; index++) {
            const value = zone.members?.[index]?.origin_damage
            if (value === undefined) continue
            memberDamage[index] += value
            if (!Number.isFinite(memberDamage[index])) return false
        }
    }
    return true
}

export function validateSingleFinishRequest(
    body: unknown,
): SingleFinishValidationResult {
    if (!isPlainObject(body)
        || !isPositiveSafeInteger(body.viewer_id)
        || !isPositiveSafeInteger(body.quest_id)
        || !isPositiveSafeInteger(body.category)
        || typeof body.play_id !== "string"
        || body.play_id.length === 0
        || !isNonNegativeSafeInteger(body.continue_count)
        || !isNonNegativeSafeInteger(body.add_mana)
        || !isPositiveSafeInteger(body.elapsed_time_ms)
        || typeof body.score !== "number"
        || !Number.isFinite(body.score)
        || body.score < 0
        || typeof body.is_accomplished !== "boolean"
        || typeof body.is_restored !== "boolean") return invalid()

    const statistics = body.statistics
    if (!isPlainObject(statistics)
        || !isNonNegativeInt32(statistics.clear_phase)
        || !Array.isArray(statistics.zones)
        || !statistics.zones.every(isZone)
        || !hasValidOptionalFields(
            statistics,
            STATISTIC_SAFE_INTEGER_FIELDS,
            isNonNegativeInt32,
        )) return invalid()

    const zones = statistics.zones
    if (!hasValidInt32Aggregate(zones, "use_power_flip_count")
        || !hasValidInt32Aggregate(zones, "use_dash_count")
        || (HISTORY_CATEGORIES.has(body.category) && !hasValidHistoryAggregates(zones))) {
        return invalid()
    }

    const party = statistics.party
    if (!isPlainObject(party)
        || !Array.isArray(party.characters)
        || party.characters.length === 0
        || !party.characters.every(isPartyMember)
        || !party.characters.some(value => value !== null && isPositiveSafeInteger(value.id))
        || !Array.isArray(party.unison_characters)
        || !party.unison_characters.every(isPartyMember)
        || !Array.isArray(party.equipments)
        || !party.equipments.every(isPartyMember)
        || !Array.isArray(party.ability_soul_ids)
        || !party.ability_soul_ids.every(value => (
            value === null || isPositiveSafeInteger(value)
        ))) return invalid()

    if (hasOwn(body, "equipment_element") && (!Array.isArray(body.equipment_element)
        || !body.equipment_element.every(isNonNegativeSafeInteger))) return invalid()

    return { ok: true, body: body as unknown as ValidatedSingleFinishBody }
}
