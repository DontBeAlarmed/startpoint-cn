import type { EventSettlementDescriptor } from "./event-settlement-descriptor"

type Descriptor<Kind extends EventSettlementDescriptor["kind"]> = Extract<
    EventSettlementDescriptor,
    { readonly kind: Kind }
>

export interface BuiltInEventSettlementHooks<Rush, Raid, Carnival, ScoreAttack> {
    readonly rush: (descriptor: Descriptor<"rush">) => Rush
    readonly raid: (descriptor: Descriptor<"raid">) => Raid
    readonly carnival: (descriptor: Descriptor<"carnival">) => Carnival
    readonly scoreAttack: (descriptor: Descriptor<"scoreAttack">) => ScoreAttack
}

export type BuiltInEventSettlementHookResult<Rush, Raid, Carnival, ScoreAttack> =
    | Readonly<{ kind: "none" }>
    | Readonly<{ kind: "rush"; value: Rush }>
    | Readonly<{ kind: "raid"; value: Raid }>
    | Readonly<{ kind: "carnival"; value: Carnival }>
    | Readonly<{ kind: "scoreAttack"; value: ScoreAttack }>

const NO_BUILT_IN_EVENT = Object.freeze({ kind: "none" as const })

export type OperatorRushHookPhase = "beforeBuiltIn" | "afterBuiltIn"

/** Preserves the pre-D26 operator hook order for Rush and non-Rush finishes. */
export function getOperatorRushHookPhase(
    descriptor: EventSettlementDescriptor,
): OperatorRushHookPhase {
    return descriptor.kind === "rush" ? "afterBuiltIn" : "beforeBuiltIn"
}

/** Dispatches at most one built-in Event hook from one closed descriptor. */
export function dispatchBuiltInEventSettlement<Rush, Raid, Carnival, ScoreAttack>(
    descriptor: EventSettlementDescriptor,
    hooks: BuiltInEventSettlementHooks<Rush, Raid, Carnival, ScoreAttack>,
): BuiltInEventSettlementHookResult<Rush, Raid, Carnival, ScoreAttack> {
    if (descriptor.kind === "rush") {
        return Object.freeze({ kind: "rush", value: hooks.rush(descriptor) })
    }
    if (descriptor.kind === "raid") {
        return Object.freeze({ kind: "raid", value: hooks.raid(descriptor) })
    }
    if (descriptor.kind === "carnival") {
        return Object.freeze({ kind: "carnival", value: hooks.carnival(descriptor) })
    }
    if (descriptor.kind === "scoreAttack") {
        return Object.freeze({ kind: "scoreAttack", value: hooks.scoreAttack(descriptor) })
    }
    return NO_BUILT_IN_EVENT
}
