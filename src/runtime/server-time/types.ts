export type ServerTimeMode = "system" | "offset"

export interface ServerTimePackage {
    readonly mode: ServerTimeMode
    readonly offsetMs: number
    readonly generatedAt: string
}

export interface ServerTimeState extends ServerTimePackage {}

export interface ServerTimeSnapshot extends ServerTimeState {
    readonly serverTimeMs: number
}
