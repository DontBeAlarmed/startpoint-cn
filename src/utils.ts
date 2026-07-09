import { randomInt } from "crypto"
import { FastifyRequest } from "fastify"

// The server's current time offset (real time + offset = simulated time)
let timeOffset: number | null = null;  // milliseconds, null = use system time
console.log(`[TIME] startup offset=${timeOffset ?? 'null(system)'}`);

/**
 * Returns the current server time as a unix epoch.
 * Without argument: returns simulated current time.
 * With argument: converts the given Date to epoch (ignoring offset for serialization).
 * 
 * @param date An optional date to convert to epoch.
 * @returns The unix epoch.
 */
export function getServerTime(
    date?: Date
): number {
    if (date !== undefined) {
        return Math.floor(date.getTime() / 1000);
    }
    return Math.floor((Date.now() + (timeOffset ?? 0)) / 1000);
}

/**
 * Gets the current server time as a Date.
 * 
 * @returns The current server time as a date.
 */
export function getServerDate(): Date {
    return timeOffset !== null ? new Date(Date.now() + timeOffset) : new Date();
}

/** Convert a real Date (as stored in DB) to virtual epoch seconds for client. */
export function realToVirtual(date: Date): number {
    return Math.floor((date.getTime() + (timeOffset ?? 0)) / 1000);
}

/**
 * Sets a custom server time from an absolute date.
 * The offset (target - real time) is computed and stored.
 * Set to null to reset to system time.
 */
export function setServerTime(date: Date | null) {
    timeOffset = date ? date.getTime() - Date.now() : null;
    console.log(`[TIME] setServerTime → ${date?.toISOString() || 'null(system)'} offset=${timeOffset}`);
}

/**
 * Sets the time offset directly (used on startup restore).
 */
export function setServerTimeOffset(offset: number | null) {
    timeOffset = offset;
    console.log(`[TIME] startup restore offset=${offset ?? 'null(system)'}`);
}

/**
 * Returns the raw time offset (used for persistence).
 */
export function getTimeOffset(): number | null {
    return timeOffset;
}

/**
 * Returns server time for a specific player.
 * Uses player.time_offset if set, otherwise falls back to global server offset.
 */
export function getServerTimeForPlayer(playerId?: number): number {
    if (playerId) {
        try {
            const { getPlayerTimeOffsetSync } = require("./data/activeAccount");
            const offset = getPlayerTimeOffsetSync(playerId);
            if (offset !== null) return Math.floor((Date.now() + offset) / 1000);
        } catch {}
    }
    return getServerTime();
}

/**
 * Converts a server time value (unix epoch in seconds) into a Date.
 * 
 * @param serverTime The unix epoch value.
 * @returns The date.
 */
export function getDateFromServerTime(serverTime: number): Date {
    return new Date(serverTime * 1000)
}

/**
 * Generates an IdpAlias to identify a particular device.
 * 
 * @param appId 
 * @param idpId 
 * @param serialNo 
 * @returns The generated IdpAlias
 */
export function generateIdpAlias(
    appId: string,
    deviceId: string,
    serialNo: string
): string {
    return `${appId}:${deviceId}:${serialNo}`
}

/**
 * Generates a random viewer ID using the crypto library.
 * 
 * @returns A number between 100,000,000 and 999,999,999
 */
export function generateViewerId(): number {
    return randomInt(100000000, 999999999)
}

export interface DataHeaders {
    force_update?: boolean
    asset_update?: boolean
    short_udid?: number
    viewer_id?: number
    servertime?: number
    result_code?: number
    udid?: string
}

/**
 * Generates a default data headers object, which is used in communication with the client.
 * 
 * @param customValues A partial DataHeaders object with custom fields to replace the default ones.
 * @returns A DataHeaders object.
 */
export function generateDataHeaders(
    customValues: Partial<DataHeaders> = {},
    fields: (keyof DataHeaders)[] = ['force_update', 'asset_update', 'short_udid', 'viewer_id', 'servertime', 'result_code'],
): Record<string, any> {
    const defaultHeaders: DataHeaders = {
        force_update: false,
        asset_update: false,
        short_udid: 0,
        viewer_id: 0,
        servertime: 0,
        result_code: 1
    }
    const headers: Record<string, any> = {}

    for (const field of fields) {
        const customValue = customValues[field]
        let defaultValue = defaultHeaders[field]
        // servertime evaluated fresh each request (uses simulated time if set)
        if (field === 'servertime') {
            defaultValue = getServerTime();
        }
        headers[field] = customValue === undefined ? defaultValue : customValue
    }

    return headers
}

export enum Platform {
    ANDROID,
    IOS
}

export function getRequestPlatformSync(
    request: FastifyRequest
): Platform {
    // check user agent
    if ((request.headers["user-agent"] || '').includes('iOS;'))
        return Platform.IOS;

    // check requestedby header
    if ((request.headers["requestedby"] || '') === 'ios')
        return Platform.IOS;

    return Platform.ANDROID
}