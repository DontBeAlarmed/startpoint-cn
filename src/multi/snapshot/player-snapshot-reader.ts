import type {
    PlayerCharacter,
    PlayerEquipment,
    PlayerParty,
    PlayerPartyGroup,
} from "../../data/types"
import { PartyCategory } from "../../data/types"
import { parseGlobalPartyId } from "../../lib/special-event-parties"
import type { MultiPlayerContext } from "../player-context"

export interface SnapshotPartyGroups {
    readonly event: Record<string, PlayerPartyGroup>
    readonly normal: Record<string, PlayerPartyGroup>
}

export interface MultiplayerSnapshotReaderDependencies {
    resolvePlayerContext(viewerId: number): Promise<MultiPlayerContext | null>
    getPartyGroups(playerId: number): SnapshotPartyGroups
    getCharacters(playerId: number, characterIds: readonly number[]): Record<string, PlayerCharacter>
    getManaNodeAwakeLevels(
        playerId: number,
        characterIds: readonly number[],
    ): Record<string, Record<number, number>>
    getEquipments(playerId: number, equipmentIds: readonly number[]): Record<string, PlayerEquipment>
}

export interface MultiplayerSnapshotRead {
    readonly characters: Readonly<Record<string, PlayerCharacter>>
    readonly context: MultiPlayerContext
    readonly currentParty: PlayerParty | null
    readonly equipments: Readonly<Record<string, PlayerEquipment>>
    readonly manaNodeAwakeLevels: Readonly<Record<string, Readonly<Record<number, number>>>>
    readonly npcParties: readonly PlayerParty[]
    readonly selectedPartyId: number
}

function findCurrentParty(
    groups: Record<string, PlayerPartyGroup>,
    currentPartyId: number,
): PlayerParty | null {
    const parsed = parseGlobalPartyId(currentPartyId)
    if (!parsed) return null
    return groups[String(parsed.groupId)]?.list[String(parsed.slot)] ?? null
}

function findNpcParties(groupsByCategory: readonly Record<string, PlayerPartyGroup>[]): PlayerParty[] {
    const parties: PlayerParty[] = []
    for (const groups of groupsByCategory) {
        for (const group of Object.values(groups)) {
            for (const party of Object.values(group.list)) {
                if (party.name.includes("NPC")) parties.push(party)
                if (parties.length === 2) return parties
            }
        }
    }
    return parties
}

function collectIds(parties: readonly (PlayerParty | null)[]) {
    const characterIds = new Set<number>()
    const equipmentIds = new Set<number>()
    for (const party of parties) {
        if (!party) continue
        for (const id of [...party.characterIds, ...party.unisonCharacterIds]) {
            if (id) characterIds.add(id)
        }
        for (const id of party.equipmentIds) {
            if (id) equipmentIds.add(id)
        }
    }
    return {
        characterIds: [...characterIds],
        equipmentIds: [...equipmentIds],
    }
}

export async function readMultiplayerSnapshot(
    viewerId: number,
    currentPartyId: number | undefined,
    dependencies: MultiplayerSnapshotReaderDependencies,
): Promise<MultiplayerSnapshotRead | null> {
    const context = await dependencies.resolvePlayerContext(viewerId)
    if (!context) return null

    const selectedPartyId = currentPartyId ?? context.player.partySlot
    const groups = dependencies.getPartyGroups(context.playerId)
    const currentParty = findCurrentParty(groups.normal, selectedPartyId)
    const npcParties = findNpcParties([groups.normal, groups.event])
    const ids = collectIds([currentParty, ...npcParties])
    const characters = dependencies.getCharacters(context.playerId, ids.characterIds)
    const availableCharacterIds = ids.characterIds.filter(id => characters[String(id)] !== undefined)

    return {
        characters,
        context,
        currentParty,
        equipments: dependencies.getEquipments(context.playerId, ids.equipmentIds),
        manaNodeAwakeLevels: dependencies.getManaNodeAwakeLevels(
            context.playerId,
            availableCharacterIds,
        ),
        npcParties,
        selectedPartyId,
    }
}

export function createLegacySnapshotReaderDependencies(input: {
    resolvePlayerContext(viewerId: number): Promise<MultiPlayerContext | null>
    getPartyGroups(playerId: number, category: PartyCategory): Record<string, PlayerPartyGroup>
    getCharacter(playerId: number, characterId: number): PlayerCharacter | null
    getManaNodeAwakeLevels(playerId: number, characterId: number): Record<number, number>
    getEquipment(playerId: number, equipmentId: number): PlayerEquipment | null
}): MultiplayerSnapshotReaderDependencies {
    return {
        resolvePlayerContext: input.resolvePlayerContext,
        getPartyGroups: playerId => ({
            event: input.getPartyGroups(playerId, PartyCategory.EVENT),
            normal: input.getPartyGroups(playerId, PartyCategory.NORMAL),
        }),
        getCharacters: (playerId, characterIds) => Object.fromEntries(characterIds.flatMap(id => {
            const character = input.getCharacter(playerId, id)
            return character ? [[String(id), character]] : []
        })),
        getManaNodeAwakeLevels: (playerId, characterIds) => Object.fromEntries(
            characterIds.map(id => [String(id), input.getManaNodeAwakeLevels(playerId, id)]),
        ),
        getEquipments: (playerId, equipmentIds) => Object.fromEntries(equipmentIds.flatMap(id => {
            const equipment = input.getEquipment(playerId, id)
            return equipment ? [[String(id), equipment]] : []
        })),
    }
}
