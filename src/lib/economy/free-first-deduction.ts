export interface FreeFirstDeduction {
    readonly freeBalance: number
    readonly paidBalance: number
    readonly freeSpent: number
    readonly paidSpent: number
}

function isValidAmount(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0
}

export function planFreeFirstDeduction(
    freeBalance: number,
    paidBalance: number,
    cost: number,
): FreeFirstDeduction | null {
    const totalBalance = freeBalance + paidBalance
    if (!isValidAmount(freeBalance)
        || !isValidAmount(paidBalance)
        || !isValidAmount(cost)
        || !Number.isSafeInteger(totalBalance)
        || totalBalance < cost) return null

    const freeSpent = Math.min(freeBalance, cost)
    const paidSpent = cost - freeSpent
    return Object.freeze({
        freeBalance: freeBalance - freeSpent,
        paidBalance: paidBalance - paidSpent,
        freeSpent,
        paidSpent,
    })
}
