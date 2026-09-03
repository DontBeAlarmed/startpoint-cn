export class ShopPurchasePlanError extends Error {}
export class InvalidShopPurchaseCommandError extends ShopPurchasePlanError {}
export class ShopPurchaseLimitPlanError extends ShopPurchasePlanError {}
export class ShopPurchaseBalancePlanError extends ShopPurchasePlanError {}
export class ShopPurchaseArithmeticError extends ShopPurchasePlanError {}

export function requirePositiveSafeInteger(value: unknown, subject: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new InvalidShopPurchaseCommandError(`${subject} must be a positive safe integer.`)
    }
    return value as number
}

export function requireNonNegativeSafeInteger(value: unknown, subject: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new ShopPurchaseArithmeticError(`${subject} must be a non-negative safe integer.`)
    }
    return value as number
}

export function checkedAdd(left: number, right: number, subject: string): number {
    const result = left + right
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new ShopPurchaseArithmeticError(`${subject} overflowed the safe integer range.`)
    }
    return result
}

export function checkedMultiply(left: number, right: number, subject: string): number {
    const result = left * right
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new ShopPurchaseArithmeticError(`${subject} overflowed the safe integer range.`)
    }
    return result
}
