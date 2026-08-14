export type LogSink = (message: string) => void

interface SampledLoggerOptions {
    sink?: LogSink
    interval?: number
}

export function createSampledLogger(
    options: SampledLoggerOptions = {},
): (key: string, messageFactory: () => string) => void {
    const interval = options.interval ?? 100
    if (!Number.isSafeInteger(interval) || interval <= 0) {
        throw new RangeError("sampled log interval must be a positive safe integer")
    }

    const sink = options.sink ?? ((message: string) => console.log(message))
    const counts = new Map<string, number>()

    return (key, messageFactory) => {
        const count = (counts.get(key) ?? 0) + 1
        counts.set(key, count)
        if (count !== 1 && count % interval !== 0) return
        try {
            sink(messageFactory())
        } catch {
            // Logging is best-effort and must not affect business behavior.
        }
    }
}

export const sampledLog = createSampledLogger()
