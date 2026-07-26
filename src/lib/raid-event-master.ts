import bundledRaidEvents from "../../assets/raid_event.json"
import {
    ContentSnapshotError,
    getContentSnapshot,
} from "../content/runtime/content-snapshot"

type RaidEventTable = Record<string, { readonly requiredKillCount: number }>

export function getRaidEventRequiredKillCount(eventId: number): number | undefined {
    let table: RaidEventTable
    try {
        table = getContentSnapshot().repository.table<RaidEventTable>("raid_event.json")
    } catch (error) {
        if (!(error instanceof ContentSnapshotError)
            || error.code !== "CONTENT_SNAPSHOT_NOT_INITIALIZED") throw error
        table = bundledRaidEvents
    }
    const value = Number(table[String(eventId)]?.requiredKillCount)
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
}
