const assert = require("assert")
const fs = require("fs")

const app = fs.readFileSync("admin/src/App.tsx", "utf8")
const accounts = fs.readFileSync("admin/src/pages/Accounts.tsx", "utf8")
const playerDetail = fs.readFileSync("admin/src/pages/PlayerDetail.tsx", "utf8")
const serverApi = fs.readFileSync("src/routes/web_api/server.ts", "utf8")

assert.match(app, /label: "账号 \/ 存档"/)
assert.doesNotMatch(app, /label: "存档管理"/)
assert.doesNotMatch(app, /path="\/saves"/)

assert.match(accounts, /title="账号管理"/)
assert.doesNotMatch(accounts, /全部玩家/)
assert.match(accounts, /title="账号 \/ 存档"/)
assert.match(accounts, /devices: DeviceBinding\[\]/)
assert.match(accounts, /\/api\/server\/device\/rename/)
assert.match(accounts, /绑定设备/)

const accountMutationCount = (accounts.match(/= useMutation\(\{/g) || []).length
const accountMutationErrorCount = (accounts.match(/onError:/g) || []).length
assert.equal(accountMutationErrorCount, accountMutationCount, "账号页所有写操作都必须显示失败信息")

assert.doesNotMatch(playerDetail, /玩家摘要/)
assert.doesNotMatch(playerDetail, /时间设置/)
assert.doesNotMatch(playerDetail, /添加角色/)
assert.doesNotMatch(playerDetail, /timeOffset/)
assert.match(playerDetail, /clearedCharacters/)

const playerMutationCount = (playerDetail.match(/= useMutation\(\{/g) || []).length
const playerMutationErrorCount = (playerDetail.match(/onError:/g) || []).length
assert.equal(playerMutationErrorCount, playerMutationCount, "玩家页所有写操作都必须显示失败信息")

assert.match(serverApi, /playerIds\.includes\(savedDefaultPid\)/)
assert.match(serverApi, /saveAccountDefaultPlayer\(accountId, remainingPlayerIds\[0\]\)/)
assert.doesNotMatch(serverApi, /selectAccount/)

console.log("admin-account-save-ui tests passed")
