const fs = require("node:fs")
const path = require("node:path")

const EXPECTED_ROOT_KEYS = ["names", "schemaVersion"]
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

function fail(message) {
    throw new Error(`Invalid NPC contributor names: ${message}`)
}

function validateNpcContributorNames(value, maxLength) {
    if (!Number.isInteger(maxLength) || maxLength < 1) {
        fail("maxLength must be a positive integer")
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail("root must be an object")
    }

    const rootKeys = Object.keys(value).sort()
    if (
        rootKeys.length !== EXPECTED_ROOT_KEYS.length
        || rootKeys.some((key, index) => key !== EXPECTED_ROOT_KEYS[index])
    ) {
        fail(`root must contain exactly ${EXPECTED_ROOT_KEYS.join(", ")}`)
    }
    if (value.schemaVersion !== 1) {
        fail("schemaVersion must be 1")
    }
    if (!Array.isArray(value.names) || value.names.length === 0) {
        fail("names must be a non-empty array")
    }

    const seen = new Set()
    for (const [index, name] of value.names.entries()) {
        if (typeof name !== "string") {
            fail(`names[${index}] must be a string`)
        }
        if (name.length < 1 || name.length > maxLength) {
            fail(`names[${index}] length must be between 1 and ${maxLength}`)
        }
        if (name.trim() !== name) {
            fail(`names[${index}] must not have surrounding whitespace`)
        }
        if (CONTROL_CHARACTER_PATTERN.test(name)) {
            fail(`names[${index}] must not contain C0 or DEL control characters`)
        }
        if (seen.has(name)) {
            fail(`names[${index}] duplicates an earlier nickname`)
        }
        seen.add(name)
    }
}

function runCli() {
    const projectRoot = path.resolve(__dirname, "..")
    const configPath = path.join(projectRoot, "assets", "config.json")
    const namesPath = path.join(projectRoot, "assets", "server", "npc_contributor_names.json")
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
    const names = JSON.parse(fs.readFileSync(namesPath, "utf8"))

    validateNpcContributorNames(names, config.max_player_name_length)
    console.log(`Validated ${names.names.length} contributor NPC nicknames.`)
}

if (require.main === module) {
    try {
        runCli()
    } catch (error) {
        console.error(error instanceof Error ? error.message : error)
        process.exitCode = 1
    }
}

module.exports = {
    validateNpcContributorNames,
}
