import { getDb } from "../db";
import { randomBytes } from "crypto";
import { RawSession, Session, SessionType } from "../types";
import { generateViewerId } from "../../utils";

/**
 * Converts a RawSession into a Session.
 * 
 * @param rawSession The RawSession to convert.
 * @returns The converted Session.
 */
function buildSession(
    rawSession: RawSession
): Session {
    return {
        token: rawSession.token,
        accountId: rawSession.account_id,
        expires: new Date(rawSession.expires),
        type: rawSession.type
    }
}

/**
 * Synchronously retrieves a session based on its token.
 * 
 * @param token The token of the session to retrieve.
 * @returns The session that was found or null
 */
export function getSessionSync(
    token: string
): Session | null {

    const raw = getDb().prepare(`
    SELECT token, account_id, expires, type
    FROM sessions
    WHERE token = ?
    `).get(token) as RawSession | undefined

    if (raw === undefined) return null

    const session = buildSession(raw)

    // viewer tokens don't expire.
    if (session.type !== SessionType.VIEWER && new Date() >= session.expires) {
        console.log(`[SESSION] expired type=${session.type} accountId=${session.accountId} expires=${session.expires.toISOString()}`)
        deleteSessionSync(session.token)
        return null
    }

    return session
}

/**
 * Retrieves a session based on its token.
 * 
 * @param token The token of the session to retrieve.
 * @returns A promise that resolves with the session that was found or null
 */
export function getSession(
    token: string
): Promise<Session | null> {
    return new Promise<Session | null>((resolve, reject) => {
        try {
            resolve(getSessionSync(token))
        } catch (error) {
            reject(error)
        }
    })
}

/**
 * Gets the viewer_id (session token) for an account.
 * Returns 0 if no viewer session exists.
 */
export function getViewerIdSync(accountId: number): number {
    const row = getDb().prepare(`
        SELECT token FROM sessions WHERE account_id = ? AND type = 2 LIMIT 1
    `).get(accountId) as { token: number } | undefined
    return row?.token ?? 0
}

/**
 * Device binding: maps device_id → account_id
 */
export function getDeviceBindingSync(deviceId: number): { device_id: number, account_id: number, name: string | null } | null {
    const row = getDb().prepare(`SELECT device_id, account_id, name FROM device_bindings WHERE device_id = ?`).get(deviceId) as any
    return row ?? null
}

export function insertDeviceBindingSync(deviceId: number, accountId: number, name?: string): void {
    getDb().prepare(`INSERT OR REPLACE INTO device_bindings (device_id, account_id, last_seen, name) VALUES (?, ?, ?, ?)`)
        .run(deviceId, accountId, new Date().toISOString(), name ?? null)
}

export function deleteDeviceBindingSync(deviceId: number): void {
    getDb().prepare(`DELETE FROM device_bindings WHERE device_id = ?`).run(deviceId)
}

/** Get all device bindings for admin panel */
export function getAllDeviceBindingsSync(): { device_id: number, account_id: number, name: string | null }[] {
    return getDb().prepare(`SELECT device_id, account_id, name FROM device_bindings`).all() as any[]
}

export function updateDeviceBindingNameSync(deviceId: number, name: string | null): boolean {
    return getDb().prepare(`UPDATE device_bindings SET name = ? WHERE device_id = ?`).run(name, deviceId).changes === 1
}

/**
 * Synchronously gets a session by account_id and type (for viewer_id reuse).
 */
export function getSessionByAccountIdSync(accountId: number, type: SessionType): Session | null {
    const raw = getDb().prepare(`
    SELECT token, account_id, expires, type FROM sessions WHERE account_id = ? AND type = ?
    `).get(accountId, type) as RawSession | undefined
    return raw ? buildSession(raw) : null
}

/**
 * Synchronously returns all of the sessions of a particular type belonging to an account.
 * 
 * @param accountId The ID of the account to get the sessions of.
 * @param type The type of session to get.
 * @returns An array of sessions.
 */
export function getAccountSessionsOfTypeSync(
    accountId: number,
    type: SessionType
): Session[] {
    const rawResult = getDb().prepare(`
    SELECT token, account_id, expires, type
    FROM sessions
    WHERE account_id = ? AND type = ?    
    `).all(accountId, type) as RawSession[]

    return rawResult.map(raw => buildSession(raw))
}

/**
 * Returns all of the sessions of a particular type belonging to an account.
 * 
 * @param accountId The ID of the account to get the sessions of.
 * @param type The type of session to get.
 * @returns A promise that resolves with an array of sessions.
 */
export function getAccountSessionsOfType(
    accountId: number,
    type: SessionType
): Promise<Session[]> {
    return new Promise<Session[]>((resolve, reject) => {
        try {
            resolve(getAccountSessionsOfTypeSync(accountId, type))
        } catch (error) {
            reject(error)
        }
    })
}

/**
 * Synchronously inserts a session into the database that already has a token.
 * 
 * @param session The session to insert.
 */
function insertSessionWithTokenSync(
    session: Session
): Session {
    getDb().prepare(`
    INSERT INTO sessions (token, account_id, expires, type)
    VALUES (?, ?, ?, ?)    
    `).run(
        session.token,
        session.accountId,
        session.expires.toISOString(),
        session.type
    )

    return session
}

/**
 * Synchronously inserts a session into the database that already has a token.
 * 
 * @param session The session to insert.
 * @returns A promise that resolves with the session that was inserted.
 */
export function insertSessionWithToken(
    session: Session
): Promise<Session> {
    return new Promise<Session>((resolve, reject) => {
        try {
            resolve(insertSessionWithTokenSync(session))
        } catch (error) {
            reject(error)
        }
    })
}

/**
 * Synchronously inserts a session into the database.
 * 
 * @param session The session to insert into the database without its token.
 * @returns The session that was inserted into the database.
 */
function insertSessionSync(
    session: Omit<Session, "token">
): Session {
    const token = randomBytes(54).toString('base64')

    const completeSession = session as Session
    completeSession.token = token
    return insertSessionWithTokenSync(completeSession)
}

/**
 * Inserts a session into the database.
 * 
 * @param session The session to insert into the database without its token.
 * @returns A promise that resolves with the session that was inserted into the database.
 */
export function insertSession(
    session: Omit<Session, "token">
): Promise<Session> {
    return new Promise<Session>((resolve, reject) => {
        try {
            resolve(insertSessionSync(session))
        } catch (error) {
            reject(error)
        }
    })
}

/**
 * Synchronously deletes a session from the database based on its token.
 * 
 * @param token The token of the session to delete.
 */
export function deleteSessionSync(
    token: string
) {
    getDb().prepare(`DELETE FROM sessions WHERE token = ?`).run(token)
}

/**
 * Deletes a session from the database based on its token.
 * 
 * @param token The token of the session to delete.
 * @returns A promise that resolves when the session is deleted.
 */
export function deleteSession(
    token: string
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        try {
            resolve(deleteSessionSync(token))
        } catch (error) {
            reject(error)
        }
    })
}

/**
 * Synchronously deletes all of the sessions assigned to a particular player.
 * 
 * @param playerId The id of the player to delete all the sessions of.
 */
function deleteAccountSessionsSync(
    playerId: number
) {
    getDb().prepare(`DELETE FROM sessions WHERE account_id = ?`).run(playerId)
}

/**
 * Deletes all of the sessions assigned to a particular player.
 * 
 * @param playerId The id of the player to delete all the sessions of.
 * @returns A promise that resolves when the sessions have been deleted.
 */
export function deleteAccountSessions(
    playerId: number
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        try {
            resolve(deleteAccountSessionsSync(playerId))
        } catch (error) {
            reject(error)
        }
    })
}

/**
 * Synchronously deletes all of an account's sessions of a particular type.
 * 
 * @param accountId The ID of the account to delete the sessions of.
 * @param type The type of session to delete.
 */
export function deleteAccountSessionsOfTypeSync(
    accountId: number,
    type: SessionType
) {
    getDb().prepare(`
    DELETE FROM sessions
    WHERE account_id = ? AND type = ?
    `).run(accountId, type)
}

/**
 * Deletes all of an account's sessions of a particular type.
 * 
 * @param accountId The ID of the account to delete the sessions of.
 * @param type The type of session to delete.
 * @returns A promise that resolves when the sessions are deleted.
 */
export function deleteAccountSessionsOfType(
    accountId: number,
    type: SessionType
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        try {
            resolve(deleteAccountSessionsOfTypeSync(accountId, type))
        } catch (error) {
            reject(error)
        }
    })
}

export function generateViewerIdSession(
    accountId: number
): Promise<Session> {
    return new Promise<Session>((resolve, reject) => {
        try {
            // delete any existing viewer ID sessions
            deleteAccountSessionsOfTypeSync(accountId, SessionType.VIEWER)

            // insert new session
            resolve(insertSessionWithTokenSync({
                token: generateViewerId().toString(),
                expires: new Date(new Date().getTime()),
                accountId: accountId,
                type: SessionType.VIEWER
            }))
        } catch (error) {
            reject(error)
        }
    })
}

// player
