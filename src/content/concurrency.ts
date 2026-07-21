export async function mapWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
        throw new TypeError("concurrency must be a positive safe integer")
    }

    const results = new Array<R>(values.length)
    let nextIndex = 0
    let stopped = false
    const failures: unknown[] = []
    const workerCount = Math.min(concurrency, values.length)
    const workers = Array.from({ length: workerCount }, async () => {
        while (!stopped) {
            const index = nextIndex++
            if (index >= values.length) return
            try {
                results[index] = await mapper(values[index], index)
            } catch (reason) {
                if (failures.length === 0) failures.push(reason)
                stopped = true
            }
        }
    })

    await Promise.all(workers)
    if (failures.length > 0) throw failures[0]
    return results
}
