// Mission computer dispatch registry

import type { MissionComputer, ComputerRegistry } from "./types"

// 计算器映射必须**首次调用时**构建，不得用顶层静态 import 构建：本模块处于
// 一条真实存在的加载环中（computer-regular → regular-quest-facts →
// mission-catalog → config-content → … → character →
// gacha-acquisition-mission-settlement → settlement → registry →
// computer-regular）。CJS 循环引用下，若 registry 先于 computer-regular
// 完成加载，顶层 import 绑定读到的是半成品导出（undefined），静态 Map 会把
// undefined 永久固化——此后 getComputer(1) 对任何加载序都抛 "No mission
// computer registered"（2026-10-10 溯源：de47c90b 接通该环，测试引导路径
// 可达）。惰性构建保证建表时全部计算器模块已加载完成。
let registry: ComputerRegistry | null = null

function getRegistry(): ComputerRegistry {
    if (registry === null) {
        const { RegularComputer } = require("./computer-regular") as typeof import("./computer-regular")
        const { DegreeComputer } = require("./computer-degree") as typeof import("./computer-degree")
        const { AwakeComputer } = require("./computer-awake") as typeof import("./computer-awake")
        const { CollectComputer } = require("./collect-progress") as typeof import("./collect-progress")
        const { PassComputer } = require("./pass") as typeof import("./pass")
        const { EventSafeComputer } = require("./computer-event-safe") as typeof import("./computer-event-safe")
        registry = new Map([
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
    }
    return registry
}

export function getComputer(category: number): MissionComputer {
    const computer = getRegistry().get(category)
    if (computer === undefined) {
        throw new TypeError(`No mission computer registered for category ${category}`)
    }
    return computer
}
