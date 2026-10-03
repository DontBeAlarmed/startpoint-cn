"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const appPath = path.join(projectRoot, "admin/src/App.tsx")
const pagePath = path.join(projectRoot, "admin/src/pages/Gifts.tsx")
const typesPath = path.join(projectRoot, "admin/src/features/gifts/types.ts")
const editorPath = path.join(projectRoot, "admin/src/features/gifts/GiftEditor.tsx")
const redemptionsPath = path.join(projectRoot, "admin/src/features/gifts/GiftRedemptions.tsx")
const cardViewPath = path.join(projectRoot, "admin/src/features/gifts/GiftsCardView.tsx")

test("admin gift UI keeps exact codes, state actions, and read-only redemptions", () => {
    for (const filePath of [pagePath, typesPath, editorPath, redemptionsPath, cardViewPath]) {
        assert.equal(fs.existsSync(filePath), true, `缺少礼包后台文件：${filePath}`)
    }

    const app = fs.readFileSync(appPath, "utf8")
    const page = fs.readFileSync(pagePath, "utf8")
    const types = fs.readFileSync(typesPath, "utf8")
    const editor = fs.readFileSync(editorPath, "utf8")
    const redemptions = fs.readFileSync(redemptionsPath, "utf8")
    const cardView = fs.readFileSync(cardViewPath, "utf8")

    assert.match(app, /key: "\/gifts"/)
    assert.match(app, /label: "礼包"/)
    assert.match(app, /<Route path="\/gifts" element=\{<Gifts \/>\} \/>/)

    assert.match(page, /apiGet<GiftPage>\(`\/api\/gifts\?page=\$\{page\}&pageSize=\$\{pageSize\}`\)/)
    assert.match(page, /apiPost<AdminGiftRow>\(`\/api\/gifts\/\$\{row\.id\}\/start`/)
    assert.match(page, /apiPost<AdminGiftRow>\(`\/api\/gifts\/\$\{row\.id\}\/stop`/)
    assert.match(page, /apiDelete<\{ ok: boolean \}>\(`\/api\/gifts\/\$\{row\.id\}\?revision=\$\{row\.revision\}`\)/)
    assert.match(page, /清除全部领取记录，同 code 重建后可重新领取/)

    // 2026-10-04 卡片化 + 二次调整: 操作语义位于 GiftsCardView —— 状态钮恒位重标记;
    // 编辑/删除常驻(布局不变), 生效中置灰锁定并提示需先停用, 删除为垃圾桶 icon-only
    assert.match(cardView, /\{active \? "生效中" : "已停用"\}/)
    assert.match(cardView, /需停用后编辑礼包/, "生效中点编辑应有提醒")
    assert.match(cardView, /需停用后删除礼包/, "生效中点删除应有提醒")
    assert.match(cardView, /disabled=\{active\}/, "生效中删除 Popconfirm 应禁用(走提醒)")
    assert.doesNotMatch(cardView, /\{!active && \(/, "编辑/删除不再按状态隐藏")

    assert.match(redemptions, /apiGet<GiftRedemptionPage>\(`\/api\/gifts\/\$\{gift\.id\}\/redemptions\?page=\$\{page\}&pageSize=\$\{pageSize\}&q=\$\{encodeURIComponent\(search\)\}`\)/)
    for (const field of [
        "playerId",
        "accountId",
        "playerName",
        "redeemedAt",
        "rewardRevision",
        "rewardSnapshot",
        "inherited",
        "sourcePlayerId",
    ]) {
        assert.match(redemptions, new RegExp(field))
    }
    assert.doesNotMatch(redemptions, /强制领取|重新领取|重置|删除/)

    assert.match(editor, /<Form[\s\S]*disabled=\{isActive\}[\s\S]*>/)
    assert.match(editor, /<Form\.List name="rewards"/)
    assert.match(editor, /至少需要 1 条奖励/)
    assert.match(editor, /最多只能添加 20 条奖励/)
    assert.match(editor, /<Input maxLength=\{20\} value=\{code\}/)
    assert.doesNotMatch(editor, /code\s*[?!]?\.?(trim|normalize|toLowerCase|toLocaleUpperCase)\(/)
    assert.match(editor, /code: values\.code/)
    assert.match(editor, /apiPost<AdminGiftRow>\("\/api\/gifts", payload\)/)
    assert.match(editor, /apiPatch<AdminGiftRow>\(`\/api\/gifts\/\$\{gift\.id\}`, payload\)/)
    assert.match(editor, /apiGet<Record<string, string>>\("\/api\/lookup\/items"\)/)
    assert.match(editor, /apiGet<CharacterLookup>\("\/api\/lookup\/characters"\)/)
    assert.match(editor, /apiGet<EquipmentLookup>\("\/api\/lookup\/equipment"\)/)
    assert.match(editor, /type === 1 \|\| type === 5 \|\| type === 6/)

    for (const rewardType of [
        "value: 1, label: \"道具\"",
        "value: 4, label: \"免费星导石\"",
        "value: 5, label: \"角色\"",
        "value: 6, label: \"装备\"",
        "value: 8, label: \"免费玛纳\"",
        "value: 9, label: \"经验值\"",
    ]) {
        assert.match(types, new RegExp(rewardType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    }
    for (const field of [
        "export interface AdminGiftRow",
        "rewardRevision: number",
        "revision: number",
        "redemptionCount: number",
        "export interface GiftRedemptionRow",
    ]) {
        assert.match(types, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    }
})
