import type { FactKey } from "./fact-key"

export interface MissionFactLoadPlan {
    readonly keys: readonly FactKey[]
    readonly keyIds: readonly string[]
}
