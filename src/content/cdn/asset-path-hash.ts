import { createHash } from "node:crypto"

/**
 * CDN asset path addressing, replicating the client's
 * `pinball.asset.path.AssetPathTools.getHashedPath` (wf-1.8.1-cn-decompiled
 * scripts/pinball/asset/path/AssetPathTools.as:12-17):
 *
 *   1. collapse any run of `/` or `\` into a single `/`
 *   2. strip one leading `/`
 *   3. SHA1(<normalized logical path> + <salt>), lowercase hex
 *   4. first 2 hex chars become the shard directory, the remaining 38 the name
 *
 * The salt is the documented CDN constant (docs/cdn/overview.md 「关键常量」).
 */
const CDN_PATH_SALT = "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy"

export function hashedAssetPath(logicalPath: string): string {
    const normalized = logicalPath.replace(/[/\\]+/g, "/").replace(/^\//, "")
    const digest = createHash("sha1").update(normalized + CDN_PATH_SALT).digest("hex")
    return `${digest.substring(0, 2)}/${digest.substring(2)}`
}

/**
 * Character avatar logical path (medium/scaled asset bucket):
 * `character/<string_id>/ui/square_132_132_<evolve>.png`, evolve 0|1 —
 * 游戏自带的 132×132 方形头像(~20KB), 覆盖 489/505 角色;
 * full_shot 立绘(0.7–1.6MB)作为大图备用, 走 characterFullShotPath。
 * Note the client hashes the logical path *with* the ".png" suffix included.
 */
export function characterAvatarPath(stringId: string, evolve: 0 | 1): string {
    return `character/${stringId}/ui/square_132_132_${evolve}.png`
}

export function characterFullShotPath(stringId: string, evolve: 0 | 1): string {
    return `character/${stringId}/ui/full_shot_1440_1920_${evolve}.png`
}
