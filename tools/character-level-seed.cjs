#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const crypto = require("node:crypto")

require("ts-node/register/transpile-only")

const {
    canonicalizeCharacterLevelBundledSeed,
} = require("../src/content/character-level-seed")
const { canonicalJsonBuffer } = require("../src/content/sync/canonical-json")

function usage() {
    return "usage: character-level-seed.cjs --input SEED_JSON [--source-blob BLOB] [--output JSON]"
}

function parseArguments(argv) {
    const values = {}
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index]
        const value = argv[index + 1]
        if (!["--input", "--source-blob", "--output"].includes(flag) || !value) {
            throw new Error(usage())
        }
        if (values[flag] !== undefined) throw new Error(`${flag} cannot be repeated`)
        values[flag] = value
    }
    if (!values["--input"]) throw new Error(usage())
    return values
}

function blobSha256(filePath) {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

function main(argv) {
    try {
        const args = parseArguments(argv)
        const input = JSON.parse(fs.readFileSync(args["--input"], "utf8"))
        const sourceBlobPath = args["--source-blob"]
        if (args["--output"] !== undefined && sourceBlobPath === undefined) {
            throw new Error("source blob is required when writing a canonical seed")
        }
        const sourceBlob = sourceBlobPath === undefined
            ? undefined
            : fs.readFileSync(sourceBlobPath)
        const sourceBlobSha256 = sourceBlob === undefined
            ? undefined
            : blobSha256(sourceBlobPath)
        const canonical = canonicalizeCharacterLevelBundledSeed(
            input,
            sourceBlobSha256,
            sourceBlob,
        )
        const bytes = canonicalJsonBuffer(canonical)
        if (args["--output"] === undefined) {
            process.stdout.write(bytes)
        } else {
            fs.writeFileSync(args["--output"], bytes)
            process.stdout.write("character level seed validated and canonicalized\n")
        }
        return 0
    } catch (error) {
        process.stderr.write(
            `BLOCKED [CHARACTER_LEVEL_SEED_INVALID]：${error instanceof Error ? error.message : String(error)}\n`,
        )
        return 1
    }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = { main, parseArguments }
