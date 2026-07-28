import { ADMIN_UPLOAD_FILE_SIZE_LIMIT } from "./upload-limits"

export class PlayerSaveDownloadTooLargeError extends Error {
    readonly byteLength: number
    readonly limit: number

    constructor(byteLength: number, limit: number) {
        super(`Player save is ${byteLength} bytes and exceeds the ${limit} byte upload limit`)
        this.name = "PlayerSaveDownloadTooLargeError"
        this.byteLength = byteLength
        this.limit = limit
    }
}

export function serializePlayerSaveDownload(
    snapshot: unknown,
    limit = ADMIN_UPLOAD_FILE_SIZE_LIMIT,
): string {
    const serialized = JSON.stringify(snapshot)
    const byteLength = Buffer.byteLength(serialized, "utf8")
    if (byteLength > limit) throw new PlayerSaveDownloadTooLargeError(byteLength, limit)
    return serialized
}
