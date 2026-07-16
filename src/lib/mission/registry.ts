// Mission computer dispatch registry

import { MissionComputer, ComputerRegistry } from "./types"
import { RegularComputer } from "./computer-regular"
import { DegreeComputer } from "./computer-degree"
import { AwakeComputer } from "./computer-awake"
import { EventComputer } from "./computer-event"
import { FallbackComputer } from "./computer-fallback"

const REGISTRY: ComputerRegistry = new Map([
    [1, RegularComputer],
    [2, RegularComputer],
    [10, RegularComputer],
    [3, EventComputer],
    [5, DegreeComputer],
    [9, AwakeComputer],
    // Categories 4,6,7,8 → Fallback (DB-stored progress)
])

export function getComputer(category: number): MissionComputer {
    return REGISTRY.get(category) ?? FallbackComputer
}
