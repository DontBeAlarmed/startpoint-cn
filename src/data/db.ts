import getDatabase, { Database } from ".";

export function getDb() {
    return getDatabase(Database.WDFP_DATA);
}
