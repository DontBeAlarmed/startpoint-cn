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

test("admin gift UI keeps exact codes, state actions, and read-only redemptions", () => {
    for (const filePath of [pagePath, typesPath, editorPath, redemptionsPath]) {
        assert.equal(fs.existsSync(filePath), true, `缺少礼包后台文件：${filePath}`)
    }

    const app = fs.readFileSync(appPath, "utf8")
    const page = fs.readFileSync(pagePath, "utf8")
    const types = fs.readFileSync(typesPath, "utf8")
    const editor = fs.readFileSync(editorPath, "utf8")
    const redemptions = fs.readFileSync(redemptionsPath, "utf8")

    assert.match(app, /key: "\/gifts"/)
    assert.match(app, /label: "礼包"/)
    assert.match(app, /<Route path="\/gifts" element=\{<Gifts \/>\} \/>/)

    assert.match(page, /apiGet<GiftPage>\(`\/api\/gifts\?page=\$\{page\}&pageSize=\$\{pageSize\}`\)/)
    assert.match(page, /apiPost<AdminGiftRow>\(`\/api\/gifts\/\$\{row\.id\}\/start`/)
    assert.match(page, /apiPost<AdminGiftRow>\(`\/api\/gifts\/\$\{row\.id\}\/stop`/)
    assert.match(page, /apiDelete<\{ ok: boolean \}>\(`\/api\/gifts\/\$\{row\.id\}\?revision=\$\{row\.revision\}`\)/)
    assert.match(page, /row\.status === "active" \? "停止" : "启动"/)
    assert.match(page, /清除全部领取记录，同 code 重建后可重新领取/)

    const actionSource = page.match(/title: "操作"[\s\S]+/)?.[0] ?? ""
    const activeAction = actionSource.match(/row\.status === "active"[\s\S]*?<\/Space>/)?.[0] ?? ""
    assert.equal(activeAction.includes("编辑"), false, "active 礼包不能提供编辑")
    assert.equal(activeAction.includes("删除"), false, "active 礼包不能提供删除")
    const stoppedAction = actionSource.match(/row\.status === "stopped"[\s\S]*?<\/Space>/)?.[0] ?? ""
    assert.match(stoppedAction, /编辑/)
    assert.match(stoppedAction, /删除/)

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
