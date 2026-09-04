import {
    insertPlayerCharacterBondTokenSync,
    updatePlayerCharacterBondTokenSync,
} from "../../data/domains/character"
import { characterExpCaps } from "./exp-caps"
import { growthError } from "./errors"
import {
    assertMonotonicBondTokenTransition,
    getBondTokenStatus,
} from "./invariants"
import type { BondTokenStatus } from "./model"

/**
 * Bond token qualification derivation.
 *
 * Client reference: DummyPlayerLogic.updateBondTokenList (CN 1.8.1) — board 1
 * requires the base level cap (`isBaseLevelCap`, i.e. exp >= the over-limit
 * step 0 cap for the rarity) plus every board-1 node learned; board 2 requires
 * every board-2 node learned and has no level condition. Status 1/2 is sticky;
 * only 0→1 convergence is ever derived here (1→2 stays with
 * commands/receive-bond-token.ts).
 */
export interface BondTokenBoardQualificationFacts {
    readonly boardIndex: number
    readonly rarity: number
    readonly exp: number
    readonly requiredNodeIds: readonly number[]
    readonly learnedNodeIds: ReadonlySet<number>
}

export interface BondTokenConvergence {
    readonly boardIndex: number
    readonly before: BondTokenStatus | null
    readonly after: BondTokenStatus
    readonly granted: boolean
}

export function isBondTokenBoardQualified(
    facts: BondTokenBoardQualificationFacts,
): boolean {
    if (facts.boardIndex === 1) {
        const baseExpCap = characterExpCaps[facts.rarity]?.[0]
        if (baseExpCap === undefined || facts.exp < baseExpCap) return false
    }
    return facts.requiredNodeIds.every(nodeId => facts.learnedNodeIds.has(nodeId))
}

export function deriveBondTokenConvergence(
    facts: BondTokenBoardQualificationFacts,
    currentStatus: BondTokenStatus | null,
): BondTokenConvergence {
    if (currentStatus !== null && currentStatus !== 0) {
        return { boardIndex: facts.boardIndex, before: currentStatus, after: currentStatus, granted: false }
    }
    const after: BondTokenStatus = isBondTokenBoardQualified(facts) ? 1 : 0
    return {
        boardIndex: facts.boardIndex,
        before: currentStatus,
        after,
        granted: after === 1,
    }
}

export interface StrictBondTokenConvergenceResult {
    readonly bondTokenGranted: boolean
}

/**
 * Learn-path convergence: the token row must already exist (fail-closed,
 * carried over from the pre-D23 helper) and the board being learned is the
 * only board whose qualification inputs changed.
 */
export function convergeBondTokenForLearnedBoardWithinTransaction(
    playerId: number,
    characterId: number,
    tokens: ReadonlyMap<number, BondTokenStatus>,
    facts: BondTokenBoardQualificationFacts,
): StrictBondTokenConvergenceResult {
    const currentStatus = getBondTokenStatus(tokens, facts.boardIndex)
    if (currentStatus === null) {
        throw growthError(
            "INVALID_GROWTH_STATE",
            `completed mana board ${facts.boardIndex} is missing its bond token row.`,
        )
    }
    const convergence = deriveBondTokenConvergence(facts, currentStatus)
    if (convergence.granted) {
        writeBondTokenConvergenceSync(playerId, characterId, convergence)
    }
    return { bondTokenGranted: convergence.granted }
}

/**
 * EXP-path convergence: only board 1 can newly qualify (board 2 has no level
 * condition and EXP commands never change learned nodes). A missing row is
 * treated as status 0 per the client's getStatus default, but only when this
 * transaction newly crosses the base cap — a character already at/above the
 * cap with no token row is an ambiguous corrupted state (never granted vs
 * deleted-after-receive) and must fail closed per gate §8.2 instead of being
 * granted again. Board facts load lazily — only after the cheap status-0 and
 * base-cap gates pass, so ordinary grants never pay for content/node reads.
 */
export interface BondTokenExpBoardFacts {
    readonly requiredNodeIds: readonly number[]
    readonly learnedNodeIds: ReadonlySet<number>
}

export function convergeBondTokenForExpWithinTransaction(
    playerId: number,
    characterId: number,
    tokens: ReadonlyMap<number, BondTokenStatus>,
    facts: {
        readonly rarity: number
        readonly beforeExp: number
        readonly exp: number
        readonly loadBoardFacts: () => BondTokenExpBoardFacts
    },
): BondTokenConvergence {
    const currentStatus = getBondTokenStatus(tokens, 1)
    const sticky: BondTokenConvergence = {
        boardIndex: 1,
        before: currentStatus,
        after: currentStatus ?? 0,
        granted: false,
    }
    if (currentStatus !== null && currentStatus !== 0) return sticky
    const baseExpCap = characterExpCaps[facts.rarity]?.[0]
    if (baseExpCap === undefined || facts.exp < baseExpCap) return sticky
    if (currentStatus === null && facts.beforeExp >= baseExpCap) {
        throw growthError(
            "INVALID_GROWTH_STATE",
            `character ${characterId} reached the base level cap without a board-1 bond token row.`,
        )
    }
    const boardFacts = facts.loadBoardFacts()
    const convergence = deriveBondTokenConvergence(
        { boardIndex: 1, rarity: facts.rarity, exp: facts.exp, ...boardFacts },
        currentStatus,
    )
    if (convergence.granted) {
        writeBondTokenConvergenceSync(playerId, characterId, convergence)
    }
    return convergence
}

function writeBondTokenConvergenceSync(
    playerId: number,
    characterId: number,
    convergence: BondTokenConvergence,
): void {
    assertMonotonicBondTokenTransition(convergence.before ?? 0, convergence.after)
    if (convergence.before === null) {
        insertPlayerCharacterBondTokenSync(playerId, characterId, {
            manaBoardIndex: convergence.boardIndex,
            status: convergence.after,
        })
        return
    }
    updatePlayerCharacterBondTokenSync(playerId, characterId, {
        manaBoardIndex: convergence.boardIndex,
        status: convergence.after,
    })
}
