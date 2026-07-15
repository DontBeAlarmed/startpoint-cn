import { readdir, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const assetsDirectory = fileURLToPath(new URL("../../web/dist/assets/", import.meta.url))
const routeLimit = 350 * 1024
const antdLimit = 900 * 1024
const vendorLimit = 600 * 1024

const entries = await readdir(assetsDirectory, { withFileTypes: true })
const chunks = []
for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue
    const details = await stat(new URL(`../../web/dist/assets/${entry.name}`, import.meta.url))
    chunks.push({ name: entry.name, bytes: details.size })
}

if (chunks.length === 0) {
    throw new Error(`No JavaScript chunks found in ${assetsDirectory}`)
}

chunks.sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))
const violations = []
for (const chunk of chunks) {
    const isVendor = chunk.name.startsWith("vendor-")
    const limit = chunk.name.startsWith("vendor-antd-") ? antdLimit : isVendor ? vendorLimit : routeLimit
    const category = chunk.name.startsWith("vendor-antd-") ? "Ant Design vendor" : isVendor ? "vendor" : "route/shared"
    console.log(`${chunk.name}\t${chunk.bytes} bytes\t${category} limit ${limit}`)
    if (chunk.bytes > limit) {
        violations.push(`${chunk.name}: ${chunk.bytes} bytes exceeds ${limit}`)
    }
}

if (violations.length > 0) {
    throw new Error(`Bundle budget exceeded:\n${violations.join("\n")}`)
}
