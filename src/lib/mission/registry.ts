// Mission computer dispatch registry

import { MissionComputer, ComputerRegistry } from "./types"
import { RegularComputer } from "./computer-regular"
import { DegreeComputer } from "./computer-degree"
import { AwakeComputer } from "./computer-awake"
import { CollectComputer } from "./collect-progress"
import { PassComputer } from "./pass"
import { EventSafeComputer } from "./computer-event-safe"

const REGISTRY: ComputerRegistry = new Map([
    [1, RegularComputer],
    [2, RegularComputer],
    [10, RegularComputer],
    [3, EventSafeComputer],
    [4, CollectComputer],
    [5, DegreeComputer],
    [6, PassComputer],
    [7, PassComputer],
    [8, PassComputer],
    [9, AwakeComputer],
])

export function getComputer(category: number): MissionComputer {
    const computer = REGISTRY.get(category)
    if (computer === undefined) {
        throw new TypeError(`No mission computer registered for category ${category}`)
    }
    return computer
}
