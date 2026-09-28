import { getRaidEventRequiredKillCountFromContent } from "./quest/finish/raid-overall-rewards"

export function getRaidEventRequiredKillCount(eventId: number): number | undefined {
    return getRaidEventRequiredKillCountFromContent(eventId)
}
