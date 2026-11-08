export const characterMaxOverLimits: Readonly<Record<number, number>> = Object.freeze({
    1: 12,
    2: 10,
    3: 8,
    4: 6,
    5: 4,
})

export const OVER_LIMIT_ITEM_BY_RARITY: Readonly<Record<number, number>> = Object.freeze({
    3: 10001,
    4: 10002,
    5: 10003,
})

export const CHARACTER_STACK_CONVERSION_EXP: Readonly<Record<number, number>> = Object.freeze({
    1: 500,
    2: 500,
    3: 500,
    4: 2000,
    5: 10000,
})

export const CHARACTER_STACK_CONVERSION_ITEM: Readonly<Record<number, number>> = Object.freeze({
    1: 2,
    2: 2,
    3: 2,
    4: 10,
    5: 30,
})

export const STACK_CONVERSION_REWARD_ITEM_ID = 990008

// 帮助 Character_Character L67「重复数的上限为 99。如果超过持有上限，
// 超出部分的角色会自动转换为经验值」——溢出重复按本文件转换表折算。
export const CHARACTER_STACK_MAX = 99
