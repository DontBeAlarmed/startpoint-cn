import { deepFreeze } from "../content/deep-freeze"
import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../content/runtime/content-snapshot"

type RawConfig = Readonly<Record<string, unknown>>

export interface CurrencyCapacityPolicy {
    readonly maxVmoney: number
    readonly maxMana: number
    readonly maxStarCrumb: number
}

export interface StaminaContentPolicy {
    readonly recoveryVmoneyCost: number
    readonly recoverySeconds: number
    readonly recoveryValue: number
    readonly maxOverflow: number
}

export interface EquipmentCurrencyPolicy {
    readonly craftPointItemId: number
    readonly starGrainItemId: number
}

export interface SingleContinuePolicy {
    readonly vmoneyCost: number
}

export interface MultiRewardPolicy {
    readonly commonRewardMultiplier: number
}

export interface CrazyGachaPolicy {
    readonly tenDrawMaxCount: number
}

const rawByRepository = new WeakMap<ReadonlyContentRepository, RawConfig>()
const currencyByRepository = new WeakMap<ReadonlyContentRepository, CurrencyCapacityPolicy>()
const staminaByRepository = new WeakMap<ReadonlyContentRepository, StaminaContentPolicy>()
const equipmentCurrencyByRepository = new WeakMap<ReadonlyContentRepository, EquipmentCurrencyPolicy>()
const singleContinueByRepository = new WeakMap<ReadonlyContentRepository, SingleContinuePolicy>()
const multiRewardByRepository = new WeakMap<ReadonlyContentRepository, MultiRewardPolicy>()
const crazyGachaByRepository = new WeakMap<ReadonlyContentRepository, CrazyGachaPolicy>()

function invalid(field: string): never {
    throw new TypeError(`invalid config content field: ${field}`)
}

function nonNegativeSafeInteger(raw: RawConfig, field: string): number {
    const value = raw[field]
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(field)
    return value
}

function positiveFiniteNumber(raw: RawConfig, field: string): number {
    const value = raw[field]
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) invalid(field)
    return value
}

function nonNegativeFiniteNumber(raw: RawConfig, field: string): number {
    const value = raw[field]
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(field)
    return value
}

function rawConfig(repository: ReadonlyContentRepository): RawConfig {
    const cached = rawByRepository.get(repository)
    if (cached !== undefined) return cached
    const raw = repository.table<unknown>("config.json")
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("root")
    const config = raw as RawConfig
    rawByRepository.set(repository, config)
    return config
}

function selectedRepository(repository?: ReadonlyContentRepository): ReadonlyContentRepository {
    return repository ?? getContentSnapshot().repository
}

export function getCurrencyCapacityPolicySync(
    repository?: ReadonlyContentRepository,
): CurrencyCapacityPolicy {
    const selected = selectedRepository(repository)
    const cached = currencyByRepository.get(selected)
    if (cached !== undefined) return cached
    const raw = rawConfig(selected)
    const policy = deepFreeze({
        maxVmoney: nonNegativeSafeInteger(raw, "max_virtual_money"),
        maxMana: nonNegativeSafeInteger(raw, "max_mana"),
        maxStarCrumb: nonNegativeSafeInteger(raw, "max_star_crumb"),
    })
    currencyByRepository.set(selected, policy)
    return policy
}

export function getStaminaPolicySync(
    repository?: ReadonlyContentRepository,
): StaminaContentPolicy {
    const selected = selectedRepository(repository)
    const cached = staminaByRepository.get(selected)
    if (cached !== undefined) return cached
    const raw = rawConfig(selected)
    const policy = deepFreeze({
        recoveryVmoneyCost: nonNegativeSafeInteger(raw, "stamina_recovery_virtual_money"),
        recoverySeconds: positiveFiniteNumber(raw, "stamina_recovery_seconds"),
        recoveryValue: nonNegativeSafeInteger(raw, "stamina_recovery_value"),
        maxOverflow: nonNegativeSafeInteger(raw, "max_stamina_overflow"),
    })
    staminaByRepository.set(selected, policy)
    return policy
}

export function getEquipmentCurrencyPolicySync(
    repository?: ReadonlyContentRepository,
): EquipmentCurrencyPolicy {
    const selected = selectedRepository(repository)
    const cached = equipmentCurrencyByRepository.get(selected)
    if (cached !== undefined) return cached
    const raw = rawConfig(selected)
    const craftPointItemId = nonNegativeSafeInteger(raw, "craft_point_item_id")
    const starGrainItemId = nonNegativeSafeInteger(raw, "star_grain_item_id")
    const policy = deepFreeze({
        craftPointItemId: craftPointItemId || 100000,
        starGrainItemId: starGrainItemId || 990008,
    })
    equipmentCurrencyByRepository.set(selected, policy)
    return policy
}

export function getSingleContinuePolicySync(
    repository?: ReadonlyContentRepository,
): SingleContinuePolicy {
    const selected = selectedRepository(repository)
    const cached = singleContinueByRepository.get(selected)
    if (cached !== undefined) return cached
    const policy = deepFreeze({
        vmoneyCost: nonNegativeSafeInteger(rawConfig(selected), "continue_virtual_money"),
    })
    singleContinueByRepository.set(selected, policy)
    return policy
}

export function getMultiRewardPolicySync(
    repository?: ReadonlyContentRepository,
): MultiRewardPolicy {
    const selected = selectedRepository(repository)
    const cached = multiRewardByRepository.get(selected)
    if (cached !== undefined) return cached
    const policy = deepFreeze({
        commonRewardMultiplier: nonNegativeFiniteNumber(
            rawConfig(selected),
            "common_reward_multiplier_by_multi_play_mode",
        ),
    })
    multiRewardByRepository.set(selected, policy)
    return policy
}

export function getCrazyGachaPolicySync(
    repository?: ReadonlyContentRepository,
): CrazyGachaPolicy {
    const selected = selectedRepository(repository)
    const cached = crazyGachaByRepository.get(selected)
    if (cached !== undefined) return cached
    const policy = deepFreeze({
        tenDrawMaxCount: nonNegativeSafeInteger(rawConfig(selected), "gacha_crazy_ten_max_count"),
    })
    crazyGachaByRepository.set(selected, policy)
    return policy
}
