import type { FactKey } from "./facts/fact-key"
import type { EventCurrentStateFact } from "./event-current-state-rules"

/**
 * Collect-event current-state shapes: progress derives from the player's
 * current state as a safe lower bound (the same semantics the audited
 * category 3 current-state rules use), merged with persisted progress.
 */
export interface CollectCurrentStateShape {
    readonly fact: Exclude<EventCurrentStateFact, "maxCharacterLevel" | "mainChapterClear">
    readonly facts: readonly FactKey[]
}

const SHAPES: Readonly<Record<number, CollectCurrentStateShape>> = Object.freeze({
    7: {
        fact: "manaBoardNodeCount",
        facts: Object.freeze([
            { kind: "characters" } as FactKey,
            { kind: "characterManaNodes" } as FactKey,
        ]),
    },
    9: {
        fact: "overLimitCount",
        facts: Object.freeze([{ kind: "characters" } as FactKey]),
    },
    21: {
        fact: "characterEpisodeClearCount",
        facts: Object.freeze([
            { kind: "characters" } as FactKey,
            { kind: "questProgress", sections: [3] } as FactKey,
        ]),
    },
    34: {
        fact: "equipmentAwakeningCount",
        facts: Object.freeze([{ kind: "equipment" } as FactKey]),
    },
    35: {
        fact: "hasEquippedAbilitySoul",
        facts: Object.freeze([
            { kind: "items" } as FactKey,
            { kind: "partyGroups", category: 1 } as FactKey,
        ]),
    },
})

export function getCollectCurrentStateShape(
    conditionType: number,
): CollectCurrentStateShape | undefined {
    return SHAPES[conditionType]
}
