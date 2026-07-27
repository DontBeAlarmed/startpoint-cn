function parseArguments(argv) {
    const values = {}
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index]
        if (!key.startsWith("--")) throw new Error(`unexpected argument ${key}`)
        const value = argv[index + 1]
        if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${key}`)
        values[key.slice(2)] = value
        index += 1
    }
    return values
}

function integerArgument(values, key, fallback) {
    if (values[key] === undefined) return fallback
    const value = Number(values[key])
    if (!Number.isSafeInteger(value)) throw new Error(`--${key} must be a safe integer`)
    return value
}

module.exports = { integerArgument, parseArguments }
