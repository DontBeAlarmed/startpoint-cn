const assert = require("node:assert/strict")
require("./test-workflow/bootstrap.cjs").bootstrap()
const {
    AUTO_START_STOP_RESULT_CODE,
    shouldStopAutoStartForStamina,
} = require("../src/lib/quest/auto-start-stop")

assert.equal(AUTO_START_STOP_RESULT_CODE, 4050)
assert.equal(shouldStopAutoStartForStamina(true, true), true)
assert.equal(shouldStopAutoStartForStamina(true, false), false)
assert.equal(shouldStopAutoStartForStamina(false, true), false)
assert.equal(shouldStopAutoStartForStamina(false, false), false)

console.log("auto start stamina stop tests passed")
