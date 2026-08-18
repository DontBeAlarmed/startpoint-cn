"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const BetterSqlite3 = require("better-sqlite3")

const {
    installSqliteFaultInjection,
} = require("./sqlite_fault_injection.cjs")

test("fault injection observes an earlier transaction write before aborting it", t => {
    const db = new BetterSqlite3(":memory:")
    t.after(() => db.close())
    db.exec(`
        CREATE TABLE owner_state (owner_id INTEGER PRIMARY KEY, balance INTEGER NOT NULL);
        CREATE TABLE settlement_log (owner_id INTEGER NOT NULL);
        INSERT INTO owner_state (owner_id, balance) VALUES (7, 100);
    `)
    const fault = installSqliteFaultInjection(db, {
        name: "late_settlement_failure",
        table: "settlement_log",
        event: "BEFORE INSERT",
        when: "NEW.owner_id = 7",
        message: "injected late settlement failure",
        observations: [{
            name: "balanceAfterCharge",
            sql: "(SELECT balance FROM owner_state WHERE owner_id = 7)",
        }],
    })
    t.after(fault.uninstall)

    assert.throws(
        () => db.transaction(() => {
            db.prepare("UPDATE owner_state SET balance = 60 WHERE owner_id = 7").run()
            db.prepare("INSERT INTO settlement_log (owner_id) VALUES (7)").run()
        })(),
        /injected late settlement failure/,
    )

    assert.deepEqual(fault.hits, [{ balanceAfterCharge: 60 }])
    assert.deepEqual(db.prepare("SELECT * FROM owner_state").all(), [{ owner_id: 7, balance: 100 }])
    assert.deepEqual(db.prepare("SELECT * FROM settlement_log").all(), [])
})

