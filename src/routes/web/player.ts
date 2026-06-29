import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFileSync } from "fs";
import path from "path";
import { staticPagesDir } from ".";
import { getAllPlayersSync, getPlayerSync, getPlayerCharactersSync, getPlayerItemsSync, getPlayerEquipmentListSync, getAllAccountsSync, getAccountPlayersSync, getPlayerQuestProgressSync, getPlayerDrawnQuestsSync, getAllDeviceBindingsSync } from "../../data/wdfpData";
import { getActivePlayerId, getSelectedAccountId, getAccountDefaultPlayer } from "../../data/activeAccount";
import characterTable from "../../../docs/generated/character_table.json";
import itemLookup from "../../../assets/item_lookup.json";
import equipmentLookup from "../../../assets/equipment_lookup.json";
import questLookup from "../../../assets/quest_lookup.json";

interface CharInfo { name: string; title: string; rarity: string; element: string }
const charLookup: Record<number, CharInfo> = {}
for (const c of (characterTable as { id: number; name: string; title: string; rarity: string; element: string }[])) {
    charLookup[c.id] = { name: c.name, title: c.title, rarity: c.rarity, element: c.element }
}

function formatTime(offset: number | null): string {
    if (offset === null || offset === undefined) return "系统时间"
    const d = new Date(Date.now() + offset)
    return d.toISOString().replace("T", " ").substring(0, 19)
}

function htmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
           .replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
        let html = readFileSync(path.join(__dirname, staticPagesDir, "players.html")).toString("utf-8")

        const activePid = getActivePlayerId()
        const selectedAccountId = getSelectedAccountId()

        let listContent = ''

        // Device binding table (replaces account management)
        const deviceBindings = getAllDeviceBindingsSync()
        let deviceRows = ''
        for (const dev of deviceBindings) {
            const pids = getAccountPlayersSync(dev.account_id)
            const saveCount = pids.length
            const defaultPid = getAccountDefaultPlayer(dev.account_id)
            const activeName = defaultPid ? (htmlEscape(getPlayerSync(defaultPid)?.name || '-')) : '-'
            const devName = htmlEscape(dev.name || '')
            deviceRows += `<tr>
                <td class="text-xs text-on-surface-variant">${dev.device_id}</td>
                <td>
                    <input value="${devName}" placeholder="名称"
                           class="edit-field text-xs border border-outline-variant rounded px-1 py-0.5 w-24 bg-background text-on-background"
                           data-device="${dev.device_id}" data-field="name">
                </td>
                <td>${saveCount}</td>
                <td>${activeName}</td>
                <td>
                    <form method="post" action="/api/server/selectAccount?accountId=${dev.account_id}" style="display:inline">
                        <button type="submit" class="text-xs bg-primary text-on-primary px-2 py-1 rounded-full">查看存档</button>
                    </form>
                    <form method="post" action="/api/server/newSave?accountId=${dev.account_id}" style="display:inline">
                        <button type="submit" class="text-xs bg-primary text-on-primary px-2 py-1 rounded-full">新建存档</button>
                    </form>
                    <form method="post" action="/api/server/deleteAccount?id=${dev.account_id}" style="display:inline" onsubmit="return confirm('删除账号及所有存档？')">
                        <button type="submit" class="text-xs text-error px-2 py-1 rounded-full border border-error">删除</button>
                    </form>
                </td>
            </tr>`
        }
        listContent += `<section class="flex flex-col p-5 border border-outline-variant rounded-3xl w-full gap-3">
            <h3 class="text-xl text-on-background font-semibold">设备绑定 / 账号管理</h3>
            <table class="w-full text-sm"><thead><tr class="text-left border-b border-outline-variant">
                <th class="p-1">设备 ID</th><th class="p-1">名称</th><th class="p-1">存档数</th><th class="p-1">生效存档</th><th class="p-1">操作</th>
            </tr></thead><tbody>${deviceRows || '<tr><td colspan="5" class="text-on-surface-variant p-2">暂无设备绑定</td></tr>'}</tbody></table>
        </section>`

        // Save management table (for selected account)
        if (selectedAccountId !== null) {
            const pids = getAccountPlayersSync(selectedAccountId)
            let saveRows = ''
            for (const pid of pids) {
                const player = getPlayerSync(pid)
                if (!player) continue
                const name = htmlEscape(player.name || `Player${pid}`)
                const level = player.degreeId || 1
                const charCount = Object.keys(getPlayerCharactersSync(pid)).length
                const isActive = activePid === pid
                saveRows += `<tr class="${isActive ? 'bg-primary/10' : ''}">
                    <td>${pid}</td>
                    <td><a href="/player/${pid}" class="text-primary underline">${name}</a></td>
                    <td>Lv.${level}</td>
                    <td>${charCount}</td>
                    <td>${formatTime(player.timeOffset ?? null)}</td>
                    <td>
                        <form method="post" action="/api/server/activateSave?playerId=${pid}" style="display:inline">
                            <button type="submit" class="text-xs bg-primary text-on-primary px-2 py-1 rounded-full">${isActive ? '当前' : '切换'}</button>
                        </form>
                        <form method="post" action="/api/server/renameSave" style="display:inline">
                            <input type="hidden" name="playerId" value="${pid}">
                            <input type="text" name="name" placeholder="${htmlEscape(player.name || '')}" class="text-xs w-20 px-1 py-0.5 rounded border border-outline-variant">
                            <button type="submit" class="text-xs border border-outline-variant px-2 py-1 rounded-full">改名</button>
                        </form>
                        <form method="post" action="/api/server/cloneSave?playerId=${pid}&accountId=${selectedAccountId}" style="display:inline">
                            <button type="submit" class="text-xs border border-outline-variant px-2 py-1 rounded-full">复制</button>
                        </form>
                        <form method="post" action="/api/server/deleteSave?playerId=${pid}" style="display:inline" onsubmit="return confirm('删除存档 ${pid}？')">
                            <button type="submit" class="text-xs text-error px-2 py-1 rounded-full border border-error">删除</button>
                        </form>
                    </td>
                </tr>`
            }
            listContent += `<section class="flex flex-col p-5 border border-outline-variant rounded-3xl w-full gap-3">
                <h3 class="text-xl text-on-background font-semibold">account ${selectedAccountId} 的存档</h3>
                <table class="w-full text-sm"><thead><tr class="text-left border-b border-outline-variant">
                    <th class="p-1">ID</th><th class="p-1">名字</th><th class="p-1">等级</th><th class="p-1">角色数</th><th class="p-1">存档时间</th><th class="p-1">操作</th>
                </tr></thead><tbody>${saveRows || '<tr><td colspan="6" class="text-on-surface-variant p-2">暂无存档</td></tr>'}</tbody></table>
            </section>`
        }

        // Player list
        const players = getAllPlayersSync()
        if (players.length === 0) {
            listContent += `<h4 class="text-xl w-full text-center font-bold">暂无玩家</h4>`
        } else {
            let playerList = ''
            for (const player of players) {
                playerList += `<li class="w-full">
                    <a href="/player/${player.id}" class="p-5 h-full text-on-surface hover:text-primary items-center flex gap-3 border-outline-variant transition-colors border rounded-3xl hover:bg-surface-container-low">
                        <section class="flex flex-col gap-2 flex-1">
                            <h4 class="text-xl font-bold">${htmlEscape(player.name)}</h4>
                            <h4 class="text-base font-bold text-on-surface-variant">Last Login: ${player.lastLoginTime.toDateString()}</h4>
                        </section>
                        <section class="flex gap-3 items-center">
                            <p class="text-xl text-on-surface-variant">Player Id</p>
                            <h4 class="text-xl font-bold">${player.id}</h4>
                        </section>
                    </a>
                </li>`
            }
            listContent += `<section class="flex flex-col p-5 border border-outline-variant rounded-3xl w-full gap-3">
                <h3 class="text-xl text-on-background font-semibold">玩家列表</h3>
                <ul class="flex flex-col gap-3">${playerList}</ul>
            </section>`
        }

        html = html.replace("{{listContent}}", listContent)
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })

    fastify.get("/:playerId", async (request: FastifyRequest, reply: FastifyReply) => {
        const { playerId } = request.params as { playerId: string }
        const { error } = request.query as { error?: string }
        const parsedPlayerId = Number(playerId)
        if (isNaN(parsedPlayerId)) return reply.redirect("/player");

        const player = getPlayerSync(parsedPlayerId)
        if (player === null) return reply.redirect("/player");

        let html = readFileSync(path.join(__dirname, staticPagesDir, "player.html")).toString("utf-8")

        // Basic info
        html = html.replace(/{{playerName}}/g, htmlEscape(player.name))
            .replace(/{{playerComment}}/g, htmlEscape(player.comment))
            .replace(/{{playerId}}/g, String(parsedPlayerId))
            .replace("{{uploadError}}", error === undefined ? '' : `<h3 class="text-xl text-error font-semibold mt-2">${htmlEscape(error)}</h3>`);

        // Resource fields
        const resourceFields = [
            { key: 'expPool', label: '经验池', value: player.expPool },
            { key: 'freeVmoney', label: '星导石(免费)', value: player.freeVmoney },
            { key: 'vmoney', label: '星导石(付费)', value: player.vmoney },
            { key: 'freeMana', label: 'Mana(免费)', value: player.freeMana },
            { key: 'paidMana', label: 'Mana(付费)', value: player.paidMana },
            { key: 'stamina', label: '体力', value: player.stamina },
            { key: 'rankPoint', label: 'Rank', value: player.rankPoint },
            { key: 'starCrumb', label: '星屑', value: player.starCrumb },
            { key: 'bondToken', label: '羁绊证', value: player.bondToken },
            { key: 'bossBoostPoint', label: 'Boss Boost', value: player.bossBoostPoint },
            { key: 'boostPoint', label: 'Boost', value: player.boostPoint },
        ];
        let resourcesHtml = '';
        for (const f of resourceFields) {
            resourcesHtml += `<div><label class="text-xs text-on-surface-variant">${f.label}</label>
                <input class="edit-field bg-surface-container rounded border border-outline-variant p-1 w-full text-sm" value="${f.value}" data-field="${f.key}"></div>`;
        }
        html = html.replace("{{resources}}", resourcesHtml);
        html = html.replace("{{resourceCols}}", "grid-cols-4");

        // Character list — sorted by joinTime DESC
        const characters = getPlayerCharactersSync(parsedPlayerId);
        const charList = Object.entries(characters).sort((a, b) => b[1].joinTime.getTime() - a[1].joinTime.getTime());
        let charsHtml = '';
        for (const [code, char] of charList) {
            const info = charLookup[Number(code)];
            const name = info ? htmlEscape(info.name) : '?';
            const title = info ? htmlEscape(info.title) : '-';
            const rarity = info ? info.rarity : '-';
            const element = info ? info.element : '-';
            const joinStr = char.joinTime.toISOString().replace('T', ' ').substring(0, 19);
            const delBtn = Number(code) === 1
                ? '<span class="text-xs text-on-surface-variant">Alk</span>'
                : `<button class="js-action text-xs text-error border border-error rounded-full px-2" data-action="delChar" data-code="${code}">✕</button>`;
            charsHtml += `<tr>
                <td class="p-1">${name}</td>
                <td class="p-1 text-xs text-on-surface-variant">${title}</td>
                <td class="p-1 text-xs text-on-surface-variant">${code}</td>
                <td class="p-1 text-xs">${rarity} ${element}</td>
                <td class="p-1 text-xs text-on-surface-variant">${joinStr}</td>
                <td class="p-1">${delBtn}</td>
            </tr>`;
        }
        html = html.replace("{{characterRows}}", charsHtml || '<tr><td colspan="6" class="text-on-surface-variant p-2">暂无角色</td></tr>');
        html = html.replace("{{characterCount}}", String(charList.length));

        // Items
        const items = getPlayerItemsSync(parsedPlayerId);
        let itemsHtml = '';
        for (const [itemId, count] of Object.entries(items)) {
            const itemName = (itemLookup as Record<string, string>)[itemId] || '-';
            itemsHtml += `<tr>
                <td class="p-1">${htmlEscape(itemName)}</td>
                <td class="p-1 text-xs text-on-surface-variant">${itemId}</td>
                <td class="p-1">${count}</td>
                <td class="p-1"><button class="js-action text-xs text-error border border-error rounded-full px-2" data-action="delItem" data-item-id="${itemId}">✕</button></td>
            </tr>`;
        }
        html = html.replace("{{itemRows}}", itemsHtml || '<tr><td colspan="4" class="text-on-surface-variant p-2">暂无道具</td></tr>');

        // Equipment
        const equipment = getPlayerEquipmentListSync(parsedPlayerId);
        let equipHtml = '';
        for (const [eqId, eq] of Object.entries(equipment)) {
            const info = (equipmentLookup as Record<string, { name: string; rarity: string; category: string }>)[eqId];
            const name = info ? htmlEscape(info.name) : '-';
            const rarity = info ? info.rarity : '-';
            const cat = info ? info.category : '-';
            equipHtml += `<tr>
                <td class="p-1">${name}</td>
                <td class="p-1 text-xs text-on-surface-variant">${eqId}</td>
                <td class="p-1 text-xs text-on-surface-variant">${rarity}★</td>
                <td class="p-1 text-xs text-on-surface-variant">${cat}</td>
                <td class="p-1">${eq.level}</td>
                <td class="p-1">${eq.enhancementLevel}</td>
            </tr>`;
        }
        html = html.replace("{{equipRows}}", equipHtml || '<tr><td colspan="6" class="text-on-surface-variant p-2">暂无装备</td></tr>');

        // Quest Progress
        const questProgress = getPlayerQuestProgressSync(parsedPlayerId)
        let qpHtml = ''
        let qpCount = 0
        for (const [section, quests] of Object.entries(questProgress)) {
            for (const qp of quests) {
                qpCount++
                const qkey = `${section}_${qp.questId}`
                const qname = (questLookup as Record<string, string>)[qkey] || '-'
                qpHtml += `<tr>
                    <td class="p-1">${htmlEscape(qname)}</td>
                    <td class="p-1 text-xs text-on-surface-variant">${section}</td>
                    <td class="p-1 text-xs text-on-surface-variant">${qp.questId}</td>
                    <td class="p-1">${qp.finished ? '✅' : '—'}</td>
                    <td class="p-1">${qp.highScore ?? '—'}</td>
                    <td class="p-1">${qp.clearRank ?? '—'}</td>
                    <td class="p-1">${qp.bestElapsedTimeMs ?? '—'}</td>
                    <td class="p-1"><button class="js-action text-xs text-error border border-error rounded-full px-2" data-action="delQuestProgress" data-section="${section}" data-quest-id="${qp.questId}">✕</button></td>
                </tr>`
            }
        }
        html = html.replace("{{questProgressRows}}", qpHtml || '<tr><td colspan="8" class="text-on-surface-variant p-2">暂无关卡记录</td></tr>')
        html = html.replace("{{questProgressCount}}", String(qpCount))

        // Drawn Quests
        const drawnQuests = getPlayerDrawnQuestsSync(parsedPlayerId)
        let dqHtml = ''
        for (const dq of drawnQuests) {
            const qkey = `${dq.categoryId}_${dq.questId}`
            const qname = (questLookup as Record<string, string>)[qkey] || '-'
            dqHtml += `<tr>
                <td class="p-1">${htmlEscape(qname)}</td>
                <td class="p-1 text-xs text-on-surface-variant">${dq.categoryId}</td>
                <td class="p-1 text-xs text-on-surface-variant">${dq.questId}</td>
                <td class="p-1 text-xs text-on-surface-variant">${dq.oddsId}</td>
                <td class="p-1"><button class="js-action text-xs text-error border border-error rounded-full px-2" data-action="delDrawnQuest" data-category="${dq.categoryId}" data-quest-id="${dq.questId}">✕</button></td>
            </tr>`
        }
        html = html.replace("{{drawnQuestRows}}", dqHtml || '<tr><td colspan="5" class="text-on-surface-variant p-2">暂无抽选记录</td></tr>')
        html = html.replace("{{drawnQuestCount}}", String(drawnQuests.length))

        // Account settings
        html = html.replace("{{tutorialStep}}", String(player.tutorialStep ?? ''));
        html = html.replace("{{auto3x}}", player.enableAuto3x ? 'checked' : '');
        html = html.replace("{{birth}}", String(player.birth));
        html = html.replace("{{degreeId}}", String(player.degreeId));
        html = html.replace("{{leaderCharacterId}}", String(player.leaderCharacterId));

        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })
}

export default routes;
