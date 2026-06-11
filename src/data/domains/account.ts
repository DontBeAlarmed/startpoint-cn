import { getDb } from "../db";
import { Account, RawAccount } from "../types";

// Account

/**
 * Converts a RawAccount into a Account
 * 
 * @param rawAccount The RawAccount to convert.
 * @returns The converted Account
 */
function buildAccount(
    rawAccount: RawAccount
): Account {
    return {
        id: rawAccount.id,
        appId: rawAccount.app_id,
        firstLoginTime: new Date(rawAccount.first_login_time),
        idpAlias: rawAccount.idp_alias,
        idpCode: rawAccount.idp_code,
        idpId: rawAccount.idp_id,
        regTime: new Date(rawAccount.reg_time),
        lastLoginTime: new Date(rawAccount.last_login_time),
        status: rawAccount.status
    }
}

/**
 * Asynchronously gets an Account from their id.
 * 
 * @param accountId The ID of the Account to get.
 * @returns The Account that was found or null.
 */
export function getAccountSync(
    accountId: number
): Account | null {
    const db = getDb();
    const raw = db.prepare(`
    SELECT id, app_id, first_login_time, idp_alias, idp_code, idp_id, reg_time, last_login_time, status
    FROM accounts
    WHERE id = ?
    `).get(accountId) as RawAccount | undefined

    if (raw === undefined) return null

    return buildAccount(raw)
}

/**
 * Gets an account from their IdpId.
 * 
 * @param idpId The IdpId of the account.
 * @returns An account or null.
 */
export function getAccountFromIdpIdSync(
    idpId: string
): Account | null {
    const db = getDb();
    const raw = db.prepare(`
    SELECT id, app_id, first_login_time, idp_alias, idp_code, idp_id, reg_time, last_login_time, status
    FROM accounts
    WHERE idp_id = ?
    `).get(idpId) as RawAccount | undefined

    if (raw === undefined) return null

    return buildAccount(raw)
}

/**
 * Gets an Account from their id.
 * 
 * @param accountId The ID of the Account to get.
 * @returns A promise that resolves with the Account that was found or null.
 */
export function getAccount(
    accountId: number
): Promise<Account | null> {
    return new Promise<Account | null>((resolve, reject) => {
        try {
            resolve(getAccountSync(accountId))
        } catch (error) {
            reject(error)
        }
    })
}

/**
 * Gets all accounts from the database.
 */
export function getAllAccountsSync(): Account[] {
    const db = getDb();
    const raw = db.prepare(`
    SELECT id, app_id, first_login_time, idp_alias, idp_code, idp_id, reg_time, last_login_time, status
    FROM accounts
    ORDER BY id DESC
    `).all() as RawAccount[]

    return raw.map(buildAccount)
}

/**
 * Deletes an account by ID.
 */
export function deleteAccountSync(accountId: number): void {
    const db = getDb();
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId)
}

/**
 * Synchronously gets all of the players that are bound to an account.
 * 
 * @param accountId The account's id.
 * @returns A list of player ids.
 */
export function getAccountPlayersSync(
    accountId: number
): number[] {
    const db = getDb();
    const raw = db.prepare(`
    SELECT id
    FROM players
    WHERE account_id = ?
    `).all(accountId) as { id: number }[]

    return raw.map(player => player.id)
}

/**
 * Gets all of the players that are bound to an account.
 * 
 * @param accountId The account's id.
 * @returns A promise that resolves with a list of player ids.
 */
export function getAccountPlayers(
    accountId: number
): Promise<number[]> {
    return new Promise<number[]>((resolve, reject) => {
        try {
            resolve(getAccountPlayersSync(accountId))
        } catch (error) {
            reject(error)
        }
    })
}

/**
 * Synchronously inserts an Account into the database.
 * 
 * @param account An Account object that doesn't include its id, firstLoginTime, lastLoginTime, nor regTime.
 * @returns The Account that was inserted into the database.
 */
function insertAccountSync(
    account: Omit<Account, "id" | "firstLoginTime" | "regTime" | "lastLoginTime">
): Account {
    const db = getDb();
    const dateNow = new Date()
    const dateNowISO = dateNow.toISOString()

    const result = db.prepare(`
    INSERT INTO accounts (app_id, first_login_time, idp_alias, idp_code, idp_id, reg_time, last_login_time, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        account.appId,
        dateNowISO,
        account.idpAlias,
        account.idpCode,
        account.idpId,
        dateNowISO,
        dateNowISO,
        account.status
    )

    const id = result.lastInsertRowid

    // return the complete player
    const finalAccount = account as Account
    finalAccount.id = Number(id)
    finalAccount.firstLoginTime = dateNow
    finalAccount.regTime = dateNow

    return finalAccount
}

/**
 * Inserts an Account into the database.
 * 
 * @param account An Account object that doesn't include its id, firstLoginTime, nor regTime.
 * @returns A promise that resolves with the Account that was inserted into the database.
 */
export function insertAccount(
    account: Omit<Account, "id" | "firstLoginTime" | "regTime" | "lastLoginTime">
): Promise<Account> {
    return new Promise<Account>((resolve, reject) => {
        try {
            resolve(insertAccountSync(account))
        } catch (error) {
            reject(error)
        }
    })
}

/**
 * Synchronously updates an Account within the database.
 * 
 * @param account The values of the Account to update.
 * @returns The updated Account.
 */
export function updateAccountSync(
    account: Partial<Account> & Pick<Account, "id">
): Account {
    const id = account.id
    const db = getDb();

    const fieldMap: Record<string, string> = {
        'appId': 'app_id',
        'firstLoginTime': 'first_login_time',
        'idpAlias': 'idp_alias',
        'idpCode': 'idp_code',
        'idpId': 'idp_id',
        'regTime': 'reg_time',
        'lastLoginTime': 'last_login_time',
        'status': 'status'
    }

    const sets: string[] = []
    const values: any[] = []
    for (const key in account) {
        const value = account[key as keyof typeof account]
        const mapped = fieldMap[key]
        if (mapped && value !== undefined) {
            sets.push(`${mapped} = ?`)
            if (value instanceof Date) {
                values.push(value.toISOString())
            } else {
                values.push(value)
            }
        }
    }

    if (sets.length > 0) db.prepare(`
        UPDATE accounts
        SET ${sets.join(', ')}
        WHERE id = ?
        `).run([...values, id]);

    return getAccountSync(id) as Account
}

/**
 * Updates an Account within the database.
 * 
 * @param account The values of the Account to update.
 * @returns A promise that resolves with the updated Account.
 */
export function updateAccount(
    account: Partial<Account> & Pick<Account, "id">
): Promise<Account> {
    return new Promise<Account>((resolve, reject) => {
        try {
            resolve(updateAccountSync(account))
        } catch (error) {
            reject(error)
        }
    })
}
