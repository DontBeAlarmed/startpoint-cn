import { getContentSnapshot } from "../content/runtime/content-snapshot"

type RaidEventTable = Record<string, { readonly requiredKillCount: number }>

export function getRaidEventRequiredKillCount(eventId: number): number | undefined {
    const table = getContentSnapshot().repository.table<RaidEventTable>("raid_event.json")
    const value = Number(table[String(eventId)]?.requiredKillCount)
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
}
