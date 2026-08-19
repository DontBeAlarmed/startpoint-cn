export const ACTIVE_MISSION_FACT_KINDS = Object.freeze([
    "player",
    "questProgress",
    "activeProgress",
    "characters",
    "characterClear",
    "manaNodes",
    "equipment",
    "party",
    "shopPurchases",
    "counters",
    "battleCounters",
    "conditionalBattleFacts",
    "missionSpecificBattleFacts",
] as const)

export type ActiveMissionFactKind = typeof ACTIVE_MISSION_FACT_KINDS[number]
