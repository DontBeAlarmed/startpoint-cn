import { buildGachaCatalog } from "./gacha-catalog/catalog"
import type { ReadonlyContentRepository } from "../content/runtime/content-snapshot"

export class ContentSmokeValidationError extends Error {
    readonly validator: string

    constructor(validator: string, message: string) {
        super(message)
        this.name = "ContentSmokeValidationError"
        this.validator = validator
    }
}

type SmokeValidator = {
    readonly name: string
    run: (repository: ReadonlyContentRepository) => void
}

// 已知故障面驱动：gacha 142（period reversed）/ gacha 1518（rarity mismatch）
// 均为 buildGachaCatalog 的惰性校验抛错——在 apply 生效前跑一次即可拦截。
const SMOKE_VALIDATORS: readonly SmokeValidator[] = [
    {
        name: "gacha-catalog",
        run: repository => {
            buildGachaCatalog(repository)
        },
    },
]

/**
 * R-04 目录级冒烟预检：在候选快照对外生效前运行惰性目录校验器，把
 * 「坏内容打挂业务端点（exec/load/存档）」提前为「apply 被拒绝」。
 * 校验器列表按已知故障面扩展。
 */
export function runContentSmokeValidators(repository: ReadonlyContentRepository): void {
    for (const validator of SMOKE_VALIDATORS) {
        try {
            validator.run(repository)
        } catch (error) {
            throw new ContentSmokeValidationError(
                validator.name,
                error instanceof Error ? error.message : String(error),
            )
        }
    }
}
