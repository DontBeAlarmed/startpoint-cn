const assert = require("assert")
const fs = require("fs")
const path = require("path")

const app = fs.readFileSync("admin/src/App.tsx", "utf8")
const accounts = fs.readFileSync("admin/src/pages/Accounts.tsx", "utf8")
const playerDetail = fs.readFileSync("admin/src/pages/PlayerDetail.tsx", "utf8")
const serverApi = fs.readFileSync("src/routes/web_api/server.ts", "utf8")
const adminPlayerDomain = fs.readFileSync("src/data/domains/admin-player.ts", "utf8")
const accountTypes = fs.readFileSync("admin/src/pages/accounts/types.ts", "utf8")
const profileFavorite = fs.readFileSync("src/lib/profileFavorite.ts", "utf8")
const favoriteAvatarPath = path.join("admin/src/pages/accounts/FavoriteAvatar.tsx")
assert.equal(fs.existsSync(favoriteAvatarPath), true, "存档子卡喜爱角色头像应为共享组件")
const favoriteAvatar = fs.readFileSync(favoriteAvatarPath, "utf8")
const mobileViewPath = path.join("admin/src/pages/accounts/AccountsMobileView.tsx")
assert.equal(fs.existsSync(mobileViewPath), true, "移动端账号页应拆分为独立纵向列表组件")
const mobileView = fs.readFileSync(mobileViewPath, "utf8")

assert.match(app, /label: "账号 \/ 存档"/)
assert.doesNotMatch(app, /label: "存档管理"/)
assert.doesNotMatch(app, /path="\/saves"/)

assert.match(accounts, /title="账号管理"/)
assert.doesNotMatch(accounts, /全部玩家/)
assert.match(accounts, /title="账号 \/ 存档"/)
assert.match(accountTypes, /devices: DeviceBinding\[\]/)
// 绑定设备为 mono 只读设备码（mockup 规格: 不可修改, 与账号备注是两个概念）, 设备改名 UI 已移除
assert.doesNotMatch(accounts, /device\/rename/)
assert.doesNotMatch(accounts, /renameDevice/)
assert.doesNotMatch(mobileView, /onRenameDevice/)
assert.match(accounts, /acc-dev-code/)
assert.match(mobileView, /acc-dev-code/)
assert.match(accounts, /绑定设备/)
assert.match(accounts, /Grid/)
assert.match(accounts, /useBreakpoint/)
assert.match(accounts, /isMobile/)
assert.match(accounts, /AccountsMobileView/)
assert.match(accounts, /className="admin-edit-compact"[\s\S]*?onClick=\{event => event\.stopPropagation\(\)\}[\s\S]*?onKeyDown=\{event => event\.stopPropagation\(\)\}/)
assert.doesNotMatch(accounts, /role: "button"/)
assert.match(mobileView, /admin-account-mobile-list/)
assert.doesNotMatch(mobileView, /返回账号列表/)
// 卡头展开按钮文案统一为「存档数 N」（维护者指定, 原「存档列表 · N」像模块标识）
assert.match(mobileView, /存档数 \{account\.players\.length\}/)
assert.match(mobileView, /编辑存档/)
assert.match(mobileView, /player\.rank/)
// 账号备注行内编辑（卡头灰字点击修改, 复用 updateNote → accountCleanup 备注位）;
// 编辑态为紧凑输入+确定/取消, 两端同构
assert.match(accounts, /acc-note acc-note-edit/)
assert.match(accounts, /accountCleanup\/account/)
assert.doesNotMatch(accounts, /void updateNote/)
assert.match(mobileView, /acc-note acc-note-edit/)
// 账号删除收进「…」更多操作菜单（mockup 规格: 删除收进菜单, 点选仍弹原样确认）
assert.match(accounts, /admin-more-btn/)
assert.match(accounts, /删除账号 \$\{accountId\} 及所有存档？/)
assert.match(mobileView, /admin-more-btn/)
assert.match(mobileView, /删除账号 \$\{accountId\} 及所有存档？/)
assert.doesNotMatch(mobileView, /删除<\/Button>\s*<\/Popconfirm>[\s\S]{0,80}账号/)
assert.doesNotMatch(accounts, /row\.degreeId \|\| 1/)

// 存档数 is no longer an inline panel below a table: task-38 (mockup accounts-nested-saves)
// turns each account into an acc-card and the save list expands INSIDE it as save-sub cards
assert.match(accounts, /存档数 \{account\.players\.length\}/)
assert.doesNotMatch(accounts, /管理存档/)
assert.doesNotMatch(accounts, /返回账号列表/)
assert.doesNotMatch(accounts, /<Table/, "桌面账号管理应废弃 Table 改为账号卡列表")
assert.doesNotMatch(accounts, /admin-accounts-table/)
assert.doesNotMatch(mobileView, /admin-mobile-save-panel/, "移动端独立存档面板应废弃, 存档子卡嵌在账号卡内部")
assert.match(accounts, /className="acc-card"/)
assert.match(accounts, /className="save-sub"/)
assert.match(mobileView, /className="save-sub admin-mobile-list-item-clickable"/)
assert.match(accounts, /aria-expanded=\{expanded\}/)
assert.match(mobileView, /aria-expanded=\{expanded\}/)
// 点开存档列表不做自动滚动（维护者指定移除 scrollIntoView）
assert.doesNotMatch(accounts, /scrollIntoView/)
assert.doesNotMatch(mobileView, /scrollIntoView/)
assert.doesNotMatch(accounts, /useRef/)
assert.doesNotMatch(mobileView, /useRef/)
assert.match(accounts, /toggleSavePanel/)

// 「存档数 N」切换钮挂在绑定设备行行尾（维护者指定, 避开卡头长备注折行）; 「N 个存档」徽标与
// 存档数表达重复已删; 新建存档垫在子卡列表末尾
{
    for (const src of [accounts, mobileView]) {
        // 存档数切换钮独立整行左右撑满（block 按钮, acc-save-row 跨 kv 两列）
        assert.match(src, /<Button block className="acc-save-toggle"/)
        assert.match(src, /className="acc-save-row"/)
        assert.doesNotMatch(src, /admin-badge-info">\{account\.players\.length\} 个存档</)
        const devicesIdx = src.indexOf("绑定设备")
        const toggleIdx = src.indexOf("存档数 {account.players.length}")
        const mapIdx = src.indexOf(".players.map(")
        const newIdx = src.indexOf("新建存档")
        assert.ok(devicesIdx !== -1 && toggleIdx > devicesIdx, "存档数切换钮应位于绑定设备行")
        assert.ok(mapIdx !== -1 && newIdx > mapIdx, "新建存档应位于存档子卡列表之后")
    }
    // 展开区独立面板底色与账号信息区分层（维护者指定）; 切换钮跨列规则存在;
    // 方案A: 面板子项去自动最小尺寸 + <375 操作行折行(≥375 恢复 nowrap)
    const accountsCss = fs.readFileSync("admin/src/styles/pages/accounts.css", "utf8")
    assert.match(accountsCss, /\.acc-save-list \{[^}]*background: var\(--hover\)/)
    assert.match(accountsCss, /\.acc-save-list > \* \{[^}]*min-width: 0/)
    assert.match(accountsCss, /\.acc-save-row \{[^}]*grid-column: 1 \/ -1/)
    assert.match(accountsCss, /@media \(min-width: 375px\) \{[\s\S]*?\.admin-mobile-actions \{[^}]*flex-wrap: nowrap/)
  }

// 卡片操作按钮与后台统一默认尺寸（维护者指定: 小尺寸 bordered 像 badge 标识风格）;
// 保留 small 的仅限: 行内编辑器紧凑输入组（备注/改名各 Input+确定+取消 = 6）
// + 存档名旁的重命名铅笔入口（icon 文字钮, 行内编辑入口而非卡片操作）= 桌面共 7;
// 移动仅备注编辑器一组 = 3
{
    const smallCount = (accounts.match(/size="small"/g) ?? []).length
    assert.equal(smallCount, 7, `桌面仅编辑器+改名铅笔保留 small, 实际 ${smallCount} 处`)
    const mobileSmall = (mobileView.match(/size="small"/g) ?? []).length
    assert.equal(mobileSmall, 3, `移动仅备注编辑器保留 small, 实际 ${mobileSmall} 处`)
}

// 备注铅笔提示 icon（维护者指定找回）
assert.match(accounts, /acc-note-pencil/)
assert.match(mobileView, /acc-note-pencil/)

// 账号卡卡头 = 头像(当前存档喜爱角色) + 存档名作卡名 + 备注(点击修改)（mockup 规格第 1 条）
assert.match(accounts, /acc-top[\s\S]*?FavoriteAvatar[\s\S]*?defaultPlayerAvatarId/)
assert.match(mobileView, /admin-mobile-heading-main[\s\S]*?FavoriteAvatar[\s\S]*?defaultPlayerAvatarId/)
assert.match(favoriteAvatar, /defaultPlayerAvatarId/)

// 「当前存档」徽标仅出现在存档子卡第一行（mockup 规格）; 账号 kv 行只留 名称, 不再重复徽标
{
    const badgeCount = (accounts.match(/admin-badge-ok">当前存档<\/span>/g) ?? []).length
    assert.equal(badgeCount, 1, `「当前存档」徽标应仅在存档子卡出现一次, 实际 ${badgeCount} 次`)
}
assert.doesNotMatch(mobileView, /admin-badge-ok">当前</)

// 存档子卡两行布局（mockup 规格 3/4 条）: 行1末尾仅「切换」; 行2 编辑·复制·导出·删除 左对齐
assert.match(accounts, /className="save-ops2"/)
{
    const head = accounts.match(/className="save-head"[\s\S]*?<\/div>\s*<div className="save-ops2"/)
    assert(head, "存档子卡应有 save-head + save-ops2 两行结构")
    assert.match(head[0], /切换\s*<\/Button>\s*<\/span>/, "子卡第一行末尾应仅是「切换」按钮")
}
assert.match(accounts, /复制\s*<\/Button>/, "桌面存档子卡第二行应有「复制」")
assert.match(accounts, /导出\s*<\/Button>/, "桌面存档子卡第二行应有「导出」")
assert.match(mobileView, /className="save-ops"/, "移动子卡第一行右端也应是「切换」")

// 账号卡/存档子卡删除 Popconfirm 文案原样锁（桌面 + 移动）
assert.match(accounts, /删除存档 \$\{player\.id\}？/)
assert.match(mobileView, /删除存档 \$\{player\.id\}？/)

// 喜爱角色头像: /api/server/accounts 只读投影 favoriteCharacterId ← 收藏编队读取器轻量 wrapper;
// 子卡头像走既有 character_avatar 端点, onError 回退首字占位
assert.match(accountTypes, /favoriteCharacterId: number \| null/)
assert.match(profileFavorite, /export function getFavoriteCharacterIdSync/)
assert.match(serverApi, /favoriteCharacterId: getFavoriteCharacterIdSync\(player\.id\)/)
assert.match(accounts, /FavoriteAvatar/)
assert.match(mobileView, /FavoriteAvatar/)
// 头像回退链（mockup 规格第 5 条）: 收藏编队角色 → 默认角色 alk(id 1) → onError 露首字
assert.match(favoriteAvatar, /DEFAULT_AVATAR_CHARACTER_ID = 1/)
assert.match(favoriteAvatar, /\/api\/content\/character_avatar\/\$\{characterId \?\? DEFAULT_AVATAR_CHARACTER_ID\}/)
assert.match(favoriteAvatar, /av-img-picture-broken/)

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
assert.match(adminPlayerDomain, /rank_point/)
assert.match(adminPlayerDomain, /rankPoint/)
assert.match(serverApi, /rank: getRankDegree\(player\.rankPoint\)/)

// A6: 存档导出必须是携带后台鉴权的 fetch/blob 下载，而不是裸直链
assert.doesNotMatch(playerDetail, /href=\{`\/api\/player\/save/)
assert.match(playerDetail, /apiDownloadFile\(`\/api\/player\/save\?id=\$\{pid\}`/)
assert.match(playerDetail, /导出存档/)
const apiClient = fs.readFileSync("admin/src/api/client.ts", "utf8")
assert.match(apiClient, /export async function apiDownloadFile/)
assert.match(apiClient, /Accept: "application\/json"/)
assert.match(apiClient, /content-disposition/)
assert.match(apiClient, /revokeObjectURL/)

console.log("admin-account-save-ui tests passed")
