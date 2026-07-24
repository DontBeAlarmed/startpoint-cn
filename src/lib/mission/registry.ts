// Mission computer dispatch registry

import { MissionComputer, ComputerRegistry } from "./types"
import { RegularComputer } from "./computer-regular"
import { DegreeComputer } from "./computer-degree"
import { AwakeComputer } from "./computer-awake"
import { CollectComputer } from "./collect-progress"
import { FallbackComputer } from "./computer-fallback"
import { PassComputer } from "./pass"

const REGISTRY: ComputerRegistry = new Map([
    [1, RegularComputer],
    [2, RegularComputer],
    [10, RegularComputer],
    [4, CollectComputer],
    [5, DegreeComputer],
    [6, PassComputer],
    [7, PassComputer],
    [8, PassComputer],
    [9, AwakeComputer],
])

export function getComputer(category: number): MissionComputer {
    return REGISTRY.get(category) ?? FallbackComputer
}
