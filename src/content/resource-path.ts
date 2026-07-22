import { createHash } from "node:crypto"

export const CONTENT_RESOURCE_PATH_SALT = "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy"

export interface HashedContentResourcePath {
    readonly logicalPath: string
    readonly relativePath: string
}

export function hashContentResourcePath(
    resourcePath: string,
    salt = CONTENT_RESOURCE_PATH_SALT,
): HashedContentResourcePath {
    const logicalPath = resourcePath.replace(/[\/\\]+/g, "/").replace(/^\//, "")
    const digest = createHash("sha1").update(logicalPath + salt).digest("hex")
    return {
        logicalPath,
        relativePath: `${digest.slice(0, 2)}/${digest.slice(2)}`,
    }
}
