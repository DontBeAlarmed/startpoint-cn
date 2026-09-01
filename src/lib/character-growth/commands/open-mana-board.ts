import { getDb } from "../../../data/db"
import {
    getPlayerCharacterWithStoredGrowthSync,
    insertPlayerCharacterBondTokenSync,
    updatePlayerCharacterSync,
} from "../../../data/domains/character"
import { getCharacterGrowthContentFactsSync } from "../content-facts"
import { growthError } from "../errors"
import { findMissingBondTokenBoards, getBondTokenStatus, isNormalBoardComplete } from "../invariants"
import { createCharacterGrowthRequestContext } from "../request-context"
import type { CharacterGrowthCoreFact } from "../model"
import type { CharacterGrowthCommandResult, CharacterGrowthObservedState } from "../result"
import { settleMissionCategories } from "../../mission/settlement"
import type { MissionSettlementResult } from "../../mission/settlement"
import { characterExpCaps } from "../../character"
import { isCharacterSecondManaBoardAvailable } from "../../mana-board-availability"
import { buildCharacterListEntryFromGrowth } from "../../character-helpers"

export interface OpenManaBoardCommand {
    readonly playerId: number
    readonly characterId: number
    readonly targetBoardIndex: number
    readonly evaluationTime: Date
}

export interface OpenManaBoardResult extends CharacterGrowthCommandResult {
    readonly replayed: boolean
    readonly missionSettlement: MissionSettlementResult | null
    readonly characterList: readonly Record<string, unknown>[]
}

const REQUIRED_UNCAPS: Readonly<Record<number, number>> = {
    1: 10,
    2: 8,
    3: 6,
    4: 4,
    5: 2,
}

const REQUIRED_EXP: Readonly<Record<number, number>> = {
    3: characterExpCaps[3][0],
    4: characterExpCaps[4][0],
    5: characterExpCaps[5][0],
}

function observed(
    character: CharacterGrowthCoreFact,
    bondTokens: ReadonlyMap<number, 0 | 1 | 2>,
): CharacterGrowthObservedState {
    return {
        ...character,
        bondTokens,
    }
}

function validateCommand(command: OpenManaBoardCommand): void {
    if (!Number.isSafeInteger(command.playerId) || command.playerId <= 0) {
        throw growthError("INVALID_GROWTH_STATE", "playerId must be a positive safe integer.")
    }
    if (!Number.isSafeInteger(command.characterId) || command.characterId <= 0) {
        throw growthError("INVALID_GROWTH_STATE", "characterId must be a positive safe integer.")
    }
    if (!Number.isSafeInteger(command.targetBoardIndex) || command.targetBoardIndex <= 0) {
        throw growthError("INVALID_GROWTH_STATE", "targetBoardIndex must be a positive safe integer.")
    }
    if (!(command.evaluationTime instanceof Date) || !Number.isFinite(command.evaluationTime.getTime())) {
        throw growthError("INVALID_GROWTH_STATE", "evaluationTime must be a valid Date.")
    }
}

function assertTargetBoard(command: OpenManaBoardCommand, character: CharacterGrowthCoreFact, boardCount: number): void {
    if (command.targetBoardIndex > boardCount) {
        throw growthError("BOARD_NOT_AVAILABLE", `board ${command.targetBoardIndex} is not available.`)
    }
    if (command.targetBoardIndex < character.manaBoardIndex) {
        throw growthError("INVALID_GROWTH_STATE", "mana board cannot be downgraded.")
    }
    if (command.targetBoardIndex < 2) {
        throw growthError("BOARD_NOT_AVAILABLE", `board ${command.targetBoardIndex} is not available.`)
    }
    if (command.targetBoardIndex > character.manaBoardIndex + 1) {
        throw growthError("PREVIOUS_BOARD_INCOMPLETE", "previous mana board is not open.")
    }
}

function assertOpenRequirements(
    command: OpenManaBoardCommand,
    character: CharacterGrowthCoreFact,
    content: ReturnType<typeof getCharacterGrowthContentFactsSync>,
    tokens: ReadonlyMap<number, 0 | 1 | 2>,
    learnedNodeIds: ReadonlyMap<number, number>,
): void {
    if (command.targetBoardIndex === 2
        && (!content.secondBoardAvailable
            || !isCharacterSecondManaBoardAvailable(command.characterId, command.evaluationTime))) {
        throw growthError("BOARD_NOT_AVAILABLE", "second mana board is not available.")
    }
    const requiredExp = REQUIRED_EXP[character.rarity]
    if (requiredExp !== undefined && character.exp < requiredExp) {
        throw growthError("LEVEL_REQUIRED", "character level is too low to unlock mana board.")
    }
    const requiredOverLimitStep = REQUIRED_UNCAPS[character.rarity]
    if (requiredOverLimitStep === undefined || character.overLimitStep < requiredOverLimitStep) {
        throw growthError("OVER_LIMIT_REQUIRED", "character is not uncapped enough to unlock mana board.")
    }
    const previousBoard = content.boardNodeIds.get(command.targetBoardIndex - 1)
    if (previousBoard === undefined) {
        throw growthError("CONTENT_INVALID", "previous mana board content is unavailable.")
    }
    if (command.targetBoardIndex === 2) {
        if (!isNormalBoardComplete(new Set(learnedNodeIds.keys()), previousBoard)) {
            throw growthError("PREVIOUS_BOARD_INCOMPLETE", "previous mana board nodes are incomplete.")
        }
        return
    }
    const previousToken = getBondTokenStatus(tokens, command.targetBoardIndex - 1)
    if (previousToken === null || previousToken < 1) {
        throw growthError("BOND_TOKEN_NOT_EARNED", "previous mana board bond token is not earned.")
    }
}

function assertCompletedBoardsHaveTokenRows(
    targetBoardIndex: number,
    content: ReturnType<typeof getCharacterGrowthContentFactsSync>,
    tokens: ReadonlyMap<number, 0 | 1 | 2>,
    learnedNodeIds: ReadonlyMap<number, number>,
): void {
    const learned = new Set(learnedNodeIds.keys())
    for (let boardIndex = 1; boardIndex < targetBoardIndex; boardIndex++) {
        if (tokens.has(boardIndex)) continue
        const nodeIds = content.boardNodeIds.get(boardIndex)
        if (nodeIds !== undefined && isNormalBoardComplete(learned, nodeIds)) {
            throw growthError(
                "INVALID_GROWTH_STATE",
                `completed mana board ${boardIndex} is missing its bond token row.`,
            )
        }
    }
}

export function openManaBoard(command: OpenManaBoardCommand): OpenManaBoardResult {
    validateCommand(command)
    const db = getDb()
    return db.transaction(() => {
        const storedCharacter = getPlayerCharacterWithStoredGrowthSync(
            command.playerId,
            command.characterId,
        )
        if (storedCharacter === null) {
            throw growthError(
                "CHARACTER_NOT_OWNED",
                `character ${command.characterId} is not owned by player ${command.playerId}.`,
            )
        }
        const { character: characterData, storedGrowth } = storedCharacter
        if (storedGrowth.protection !== 0 && storedGrowth.protection !== 1) {
            throw growthError("INVALID_GROWTH_STATE", "character.protection must be 0 or 1.")
        }
        const context = createCharacterGrowthRequestContext({
            playerId: command.playerId,
            characterId: command.characterId,
            contentFactsLoader: getCharacterGrowthContentFactsSync,
            storedCharacterSnapshot: {
                characterId: storedGrowth.id,
                exp: storedGrowth.exp,
                stack: storedGrowth.stack,
                protection: storedGrowth.protection === 1,
                overLimitStep: storedGrowth.over_limit_step,
                evolutionLevel: storedGrowth.evolution_level,
                manaBoardIndex: storedGrowth.mana_board_index,
            },
            bondTokenSnapshot: new Map(characterData.bondTokenList.map(token => [
                token.manaBoardIndex,
                token.status as 0 | 1 | 2,
            ])),
        })
        const character = context.character()
        const content = context.contentFacts()
        const tokens = context.bondTokens()
        assertTargetBoard(command, character, content.boardCount)
        const isReplay = command.targetBoardIndex === character.manaBoardIndex
        if (isReplay) {
            for (let boardIndex = 1; boardIndex <= character.manaBoardIndex; boardIndex++) {
                if (!tokens.has(boardIndex)) {
                    throw growthError(
                        "INVALID_GROWTH_STATE",
                        `completed mana board ${boardIndex} is missing its bond token row.`,
                    )
                }
            }
            const after = observed(character, tokens)
            return {
                command: "open_mana_board",
                before: after,
                after,
                changedNodeIds: [],
                replayed: true,
                missionSettlement: null,
                characterList: [buildCharacterListEntryFromGrowth(
                    command.characterId,
                    characterData,
                    after,
                    { mana_board_index: after.manaBoardIndex },
                )],
            }
        }

        const learnedNodeIds = context.normalManaNodes()
        assertCompletedBoardsHaveTokenRows(
            command.targetBoardIndex,
            content,
            tokens,
            learnedNodeIds,
        )
        assertOpenRequirements(
            command,
            character,
            content,
            tokens,
            learnedNodeIds,
        )
        const missingBoards = findMissingBondTokenBoards(tokens, content.boardCount)
        for (const boardIndex of missingBoards) {
            insertPlayerCharacterBondTokenSync(command.playerId, command.characterId, {
                manaBoardIndex: boardIndex,
                status: 0,
            })
        }
        const characterUpdate: { manaBoardIndex: number; updateTime?: Date } = {
            manaBoardIndex: command.targetBoardIndex,
        }
        updatePlayerCharacterSync(command.playerId, command.characterId, characterUpdate)
        const updateTime = characterUpdate.updateTime
        if (updateTime === undefined) {
            throw growthError("INVALID_GROWTH_STATE", "character update time was not recorded.")
        }

        const missionSettlement = settleMissionCategories(
            command.playerId,
            [1],
            command.evaluationTime,
        )
        const afterTokens = new Map(tokens)
        for (const boardIndex of missingBoards) afterTokens.set(boardIndex, 0)
        const after = observed({
            ...character,
            manaBoardIndex: command.targetBoardIndex,
        }, afterTokens)
        return {
            command: "open_mana_board",
            before: observed(character, tokens),
            after,
            changedNodeIds: [],
            replayed: false,
            missionSettlement,
            characterList: [buildCharacterListEntryFromGrowth(
                command.characterId,
                { ...characterData, updateTime },
                after,
                { mana_board_index: after.manaBoardIndex },
            )],
        }
    })()
}

export const executeOpenManaBoard = openManaBoard
