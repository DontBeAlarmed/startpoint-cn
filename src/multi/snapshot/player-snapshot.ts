import {
    getPlayerCharactersByIdsSync,
    getPlayerCharactersManaNodeAwakeLevelsByIdsSync,
    getPlayerCharacterManaNodeAwakeLevelsSync,
    getPlayerCharacterSync,
} from "../../data/domains/character"
import {
    getPlayerEquipmentsByIdsSync,
    getPlayerEquipmentSync,
} from "../../data/domains/equipment"
import {
    getPlayerPartyGroupListsSync,
    getPlayerPartyGroupListSync,
} from "../../data/domains/party"
import {
    PartyCategory,
    type PlayerCharacter,
    type PlayerEquipment,
    type PlayerParty,
    type PlayerPartyGroup,
} from "../../data/types"
import {
    getPlayerRankLevel,
    resolveMultiPlayerContext,
    type MultiPlayerContext,
} from "../player-context"
import {
    createLegacySnapshotReaderDependencies,
    readMultiplayerSnapshot,
    type MultiplayerSnapshotRead,
} from "./player-snapshot-reader"

export type MultiOption<T> = readonly [0, T] | readonly [1]

export interface PlayerCharacterSnapshot {
    readonly id: number
    readonly evolution_level: number
    readonly exp: number
    readonly over_limit_step: number
    readonly mana_node_ids: Readonly<Record<string, number>>
    readonly ex_boost: MultiOption<{
        readonly ability_id_list: readonly number[]
        readonly status_id: number
    }>
    readonly illustration_settings: MultiOption<readonly number[]>
}

export interface PlayerEquipmentSnapshot {
    readonly equipmentId: number
    readonly level: number
    readonly enhancementLevel: number
}

export interface PlayerPartySnapshot {
    readonly characters: readonly MultiOption<PlayerCharacterSnapshot>[]
    readonly unison_characters: readonly MultiOption<PlayerCharacterSnapshot>[]
    readonly equipments: readonly MultiOption<PlayerEquipmentSnapshot>[]
    readonly abilitySoulIds: readonly MultiOption<number>[]
}

export interface PlayerSnapshot {
    readonly viewerId: number
    readonly name: string
    readonly rank: number
    readonly degreeId: number
    readonly mainCharacterId: number
    readonly playerRoleKind: number
    readonly isNewbie: boolean
    readonly currentPartyId: number
    readonly party: PlayerPartySnapshot
    readonly npcParties: readonly PlayerPartySnapshot[]
}

export interface PlayerSnapshotDependencies {
    resolvePlayerContext(viewerId: number): Promise<MultiPlayerContext | null>
    getPartyGroups(playerId: number, category: PartyCategory): Record<string, PlayerPartyGroup>
    getCharacter(playerId: number, characterId: number): PlayerCharacter | null
    getManaNodeAwakeLevels(playerId: number, characterId: number): Record<number, number>
    getEquipment(playerId: number, equipmentId: number): PlayerEquipment | null
    getRankLevel(rankPoint: number): number
    getCharactersByIds?(
        playerId: number,
        characterIds: readonly number[],
    ): Record<string, PlayerCharacter>
    getManaNodeAwakeLevelsByIds?(
        playerId: number,
        characterIds: readonly number[],
    ): Record<string, Record<number, number>>
    getEquipmentsByIds?(
        playerId: number,
        equipmentIds: readonly number[],
    ): Record<string, PlayerEquipment>
    getPartyGroupLists?(
        playerId: number,
        categories: readonly PartyCategory[],
    ): Partial<Record<PartyCategory, Record<string, PlayerPartyGroup>>>
}

const defaultDependencies: PlayerSnapshotDependencies = {
    resolvePlayerContext: resolveMultiPlayerContext,
    getPartyGroups: getPlayerPartyGroupListSync,
    getCharacter: getPlayerCharacterSync,
    getManaNodeAwakeLevels: getPlayerCharacterManaNodeAwakeLevelsSync,
    getEquipment: getPlayerEquipmentSync,
    getRankLevel: getPlayerRankLevel,
    getCharactersByIds: getPlayerCharactersByIdsSync,
    getManaNodeAwakeLevelsByIds: getPlayerCharactersManaNodeAwakeLevelsByIdsSync,
    getEquipmentsByIds: getPlayerEquipmentsByIdsSync,
    getPartyGroupLists: getPlayerPartyGroupListsSync,
}

const LEGACY_ASSET_DEPENDENCIES = Object.freeze([
    "getPartyGroups",
    "getCharacter",
    "getManaNodeAwakeLevels",
    "getEquipment",
] as const)

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    return Object.freeze(value)
}

function cloneSnapshotValue<T>(value: T): T {
    if (Array.isArray(value)) return value.map(cloneSnapshotValue) as T
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .map(([key, child]) => [key, cloneSnapshotValue(child)])) as T
    }
    return value
}

export function normalizePlayerSnapshot(snapshot: PlayerSnapshot): PlayerSnapshot {
    return deepFreeze(cloneSnapshotValue(snapshot))
}

export function updatePlayerSnapshotParty(
    snapshot: PlayerSnapshot,
    party: PlayerPartySnapshot,
    currentPartyId: number,
): PlayerSnapshot {
    return normalizePlayerSnapshot({
        ...snapshot,
        party,
        currentPartyId,
    })
}

function none<T>(): MultiOption<T> {
    return [1]
}

function buildCharacter(
    playerId: number,
    characterId: number | null,
    dependencies: PlayerSnapshotDependencies,
): MultiOption<PlayerCharacterSnapshot> {
    if (!characterId) return none()
    const character = dependencies.getCharacter(playerId, characterId)
    if (!character) return none()

    const manaNodeIds = Object.fromEntries(Object.entries(
        dependencies.getManaNodeAwakeLevels(playerId, characterId),
    ).map(([nodeId, awakeLevel]) => [String(nodeId), awakeLevel]))
    const exBoost = character.exBoost?.abilityIdList.length
        ? [0, {
            ability_id_list: [...character.exBoost.abilityIdList],
            status_id: character.exBoost.statusId,
        }] as const
        : none<{ readonly ability_id_list: readonly number[], readonly status_id: number }>()

    return [0, {
        id: characterId,
        evolution_level: character.evolutionLevel,
        exp: character.exp,
        over_limit_step: character.overLimitStep,
        mana_node_ids: manaNodeIds,
        ex_boost: exBoost,
        illustration_settings: none(),
    }]
}

function buildReadCharacter(
    characterId: number | null,
    read: MultiplayerSnapshotRead,
): MultiOption<PlayerCharacterSnapshot> {
    if (!characterId) return none()
    const character = read.characters[String(characterId)]
    if (!character) return none()
    const manaNodeIds = Object.fromEntries(Object.entries(
        read.manaNodeAwakeLevels[String(characterId)] ?? {},
    ).map(([nodeId, awakeLevel]) => [String(nodeId), awakeLevel]))
    const exBoost = character.exBoost?.abilityIdList.length
        ? [0, {
            ability_id_list: [...character.exBoost.abilityIdList],
            status_id: character.exBoost.statusId,
        }] as const
        : none<{ readonly ability_id_list: readonly number[], readonly status_id: number }>()
    return [0, {
        id: characterId,
        evolution_level: character.evolutionLevel,
        exp: character.exp,
        over_limit_step: character.overLimitStep,
        mana_node_ids: manaNodeIds,
        ex_boost: exBoost,
        illustration_settings: none(),
    }]
}

function buildReadPartySnapshot(
    party: PlayerParty | null | undefined,
    read: MultiplayerSnapshotRead,
): PlayerPartySnapshot {
    const characters: MultiOption<PlayerCharacterSnapshot>[] = []
    const unisonCharacters: MultiOption<PlayerCharacterSnapshot>[] = []
    const equipments: MultiOption<PlayerEquipmentSnapshot>[] = []
    const abilitySoulIds: MultiOption<number>[] = []
    for (let index = 0; index < 3; index++) {
        characters.push(buildReadCharacter(party?.characterIds[index] ?? null, read))
        unisonCharacters.push(buildReadCharacter(party?.unisonCharacterIds[index] ?? null, read))
        const equipmentId = party?.equipmentIds[index] ?? null
        const equipment = equipmentId ? read.equipments[String(equipmentId)] : undefined
        equipments.push(equipmentId && equipment
            ? [0, {
                equipmentId,
                level: equipment.level,
                enhancementLevel: equipment.enhancementLevel,
            }]
            : none())
        const soulId = party?.abilitySoulIds[index] ?? null
        abilitySoulIds.push(soulId ? [0, soulId] : none())
    }
    return deepFreeze({
        characters,
        unison_characters: unisonCharacters,
        equipments,
        abilitySoulIds,
    })
}

export function buildPartySnapshot(
    playerId: number,
    party: PlayerParty | null | undefined,
    dependencies: PlayerSnapshotDependencies = defaultDependencies,
): PlayerPartySnapshot {
    const characters: MultiOption<PlayerCharacterSnapshot>[] = []
    const unisonCharacters: MultiOption<PlayerCharacterSnapshot>[] = []
    const equipments: MultiOption<PlayerEquipmentSnapshot>[] = []
    const abilitySoulIds: MultiOption<number>[] = []

    for (let index = 0; index < 3; index++) {
        characters.push(buildCharacter(
            playerId,
            party?.characterIds[index] ?? null,
            dependencies,
        ))
        unisonCharacters.push(buildCharacter(
            playerId,
            party?.unisonCharacterIds[index] ?? null,
            dependencies,
        ))

        const equipmentId = party?.equipmentIds[index] ?? null
        const equipment = equipmentId
            ? dependencies.getEquipment(playerId, equipmentId)
            : null
        equipments.push(equipmentId && equipment
            ? [0, {
                equipmentId,
                level: equipment.level,
                enhancementLevel: equipment.enhancementLevel,
            }]
            : none())

        const soulId = party?.abilitySoulIds[index] ?? null
        abilitySoulIds.push(soulId ? [0, soulId] : none())
    }

    return deepFreeze({
        characters,
        unison_characters: unisonCharacters,
        equipments,
        abilitySoulIds,
    })
}

export async function buildPlayerSnapshot(
    viewerId: number,
    currentPartyId?: number,
    dependencyOverrides: Partial<PlayerSnapshotDependencies> = {},
): Promise<PlayerSnapshot | null> {
    if (!Number.isSafeInteger(viewerId) || viewerId <= 0) {
        throw new TypeError("viewerId must be a positive safe integer")
    }
    const dependencies = { ...defaultDependencies, ...dependencyOverrides }
    const useLegacyAssets = LEGACY_ASSET_DEPENDENCIES.some(name => (
        Object.prototype.hasOwnProperty.call(dependencyOverrides, name)
    ))
    const readerDependencies = useLegacyAssets
        ? createLegacySnapshotReaderDependencies(dependencies)
        : {
            resolvePlayerContext: dependencies.resolvePlayerContext,
            getPartyGroups: (playerId: number) => {
                const groups = dependencies.getPartyGroupLists!(playerId, [
                    PartyCategory.NORMAL,
                    PartyCategory.EVENT,
                ])
                return {
                    event: groups[PartyCategory.EVENT] ?? {},
                    normal: groups[PartyCategory.NORMAL] ?? {},
                }
            },
            getCharacters: dependencies.getCharactersByIds!,
            getManaNodeAwakeLevels: dependencies.getManaNodeAwakeLevelsByIds!,
            getEquipments: dependencies.getEquipmentsByIds!,
        }
    const read = await readMultiplayerSnapshot(
        viewerId,
        currentPartyId,
        readerDependencies,
    )
    if (!read) return null
    const { context } = read

    return normalizePlayerSnapshot({
        viewerId,
        name: context.player.name,
        rank: dependencies.getRankLevel(context.player.rankPoint || 0),
        degreeId: context.player.degreeId || 1,
        mainCharacterId: context.player.leaderCharacterId,
        playerRoleKind: context.player.role || 1,
        isNewbie: !!context.player.tutorialStep,
        currentPartyId: read.selectedPartyId,
        party: buildReadPartySnapshot(read.currentParty, read),
        npcParties: read.npcParties.map(party => buildReadPartySnapshot(party, read)),
    })
}

export function buildYourselfFromSnapshot(
    snapshot: PlayerSnapshot,
    connectionId: string,
    isHost: boolean,
): Record<string, unknown> {
    return {
        viewerId: snapshot.viewerId,
        name: snapshot.name,
        rank: snapshot.rank,
        degreeId: snapshot.degreeId,
        mainCharacterId: snapshot.mainCharacterId,
        party: snapshot.party,
        connectionId,
        playerRoleKind: snapshot.playerRoleKind,
        isNewbie: snapshot.isNewbie,
        isHost,
        entryTime: Date.now(),
        currentPartyId: snapshot.currentPartyId,
        autoplayMode: false,
        autoskillMode: 1,
        autoSpeedLevel: 1,
        autoStart: false,
        skillAbilityBehaviorMode: 1,
        dashBehaviorMode: 1,
        allowHealFromOtherPlayers: true,
        state: [0],
    }
}
