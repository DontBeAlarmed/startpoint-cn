import type { PlayerCharacter } from "../../data/types"
import { kIdToBusinessCode } from "../../data/codeMap"
import { growthError } from "./errors"
import type { CharacterGrowthBatchContext } from "./batch-context"
import { validateBoardIndex } from "./invariants"
import { validateCharacterGrowthTerminalState } from "./validate-terminal-state"
import {
    LOAD_CHARACTER_GROWTH_FIELDS,
    projectCharacterGrowthEntry,
    type CharacterGrowthProjectionState,
} from "./response-projector"

export interface CharacterGrowthLoadProjectorInput {
    readonly batch: CharacterGrowthBatchContext
    readonly characters: Readonly<Record<string, PlayerCharacter>>
    readonly visibleManaBoardIndexes?: ReadonlyMap<number, number>
}

export interface CharacterGrowthLoadProjection {
    readonly userCharacterList: Readonly<Record<string, Record<string, unknown>>>
    readonly userCharacterManaNodeList: Readonly<
        Record<string, readonly { readonly multiplied_id: number; readonly awake_level: number }[]>
    >
}

function positiveCharacterId(raw: string): number {
    const characterId = Number(raw)
    if (!Number.isSafeInteger(characterId) || characterId <= 0 || String(characterId) !== raw) {
        throw growthError("INVALID_GROWTH_STATE", `invalid load character key ${raw}.`)
    }
    return characterId
}

export function projectCharacterGrowthLoad(
    input: CharacterGrowthLoadProjectorInput,
): CharacterGrowthLoadProjection {
    const coreByCharacter = input.batch.characters()
    const metadataIds = new Set(Object.keys(input.characters).map(positiveCharacterId))
    if (metadataIds.size !== coreByCharacter.size
        || [...coreByCharacter.keys()].some(characterId => !metadataIds.has(characterId))) {
        throw growthError("INVALID_GROWTH_STATE", "load character metadata and Growth batch do not match.")
    }

    const userCharacterList: Record<string, Record<string, unknown>> = {}
    const userCharacterManaNodeList: Record<
        string,
        readonly { readonly multiplied_id: number; readonly awake_level: number }[]
    > = {}
    const sortedCharacterIds = [...coreByCharacter.keys()].sort((left, right) => left - right)

    for (const characterId of sortedCharacterIds) {
        const character = input.characters[String(characterId)]
        if (character === undefined) {
            throw growthError("INVALID_GROWTH_STATE", `load character ${characterId} metadata is unavailable.`)
        }
        const normalManaNodes = input.batch.normalManaNodes(characterId)
        const awakeUnlocks = input.batch.awakeUnlocks(characterId)
        const core = coreByCharacter.get(characterId)!
        const state: CharacterGrowthProjectionState = {
            ...core,
            bondTokens: input.batch.bondTokens(characterId),
            normalManaNodes,
            awakeUnlocks,
        }
        const content = input.batch.contentFacts(characterId)
        const terminalIssues = validateCharacterGrowthTerminalState({
            characterId,
            entryCount: character.entryCount,
            rarity: core.rarity,
            exp: state.exp,
            overLimitStep: state.overLimitStep,
            manaBoardIndex: state.manaBoardIndex,
            bondTokens: state.bondTokens!,
            normalManaNodes,
            awakeUnlocks,
        }, content)
        if (terminalIssues.length > 0) {
            const issue = terminalIssues[0]
            throw growthError(
                "INVALID_GROWTH_STATE",
                `load character ${characterId} ${issue.section}.${issue.field}: ${issue.reason}.`,
            )
        }
        const businessCode = kIdToBusinessCode(characterId)
        const entry = projectCharacterGrowthEntry({
            characterId,
            character,
            state,
            fields: LOAD_CHARACTER_GROWTH_FIELDS,
            includeCharacterId: false,
            dateFormat: "epoch-seconds",
        })
        const visibleManaBoardIndex = input.visibleManaBoardIndexes?.get(characterId)
        if (visibleManaBoardIndex !== undefined) {
            entry.mana_board_index = validateBoardIndex(visibleManaBoardIndex)
        }
        userCharacterList[String(businessCode)] = entry

        const nodeEntries = [...normalManaNodes]
            .sort(([left], [right]) => left - right)
            .map(([multiplied_id, awake_level]) => ({ multiplied_id, awake_level }))
        if (nodeEntries.length > 0) {
            userCharacterManaNodeList[String(characterId)] = nodeEntries
        }
    }

    return { userCharacterList, userCharacterManaNodeList }
}
