// Multi battle TCP session server
// Protocol: JSON messages delimited by null byte (\0)
// Post-handshake messages use typepacker format with useEnumIndex=true:
//   [index, param1, param2, ...]
//
// Enum indices:
//   MeetingServer2Client: Message=1, Messages=2, Error=0
//   MeetingServerMessage: Welcome=0, Mates=1, StateChanged=2, Start=5, AckHeartbeat=10
//   MeetingNotifyMessage: Enter=0, Bye=1, ChangeParty=2, Ready=3, Heartbeat=4,
//                          Suspend=5, StartBattle=6, ChangeAutoplayMode=7, ChangeAutoStart=8,
//                          Log=9, EnterComs=10
//   Client2Server: Notify=0, Broadcast=1, Send=2
//   ReadyState: Preparation=0, Ready=1
//   HandshakeResult: Accept=0, Denied=1, Reconnect=2, Exception=3, Complete=4
//   BattleServer2Client: Message=1
//   BattleNotifyMessage: SceneReady=0, Finalize=1, Measurement=2, LineSpeedWarning=3, Heartbeat=4
//   BattleServerMessage: Leave=0, BattleStart=1, Finalized=2, Measurement=3, LineSpeedWarning=4
//   BattleSocketCommand: User=0, Speed=1, Heartbeat=2 (via Broadcast/Send, echoed as Measurement)

import * as net from "net";
import { disbandRoom, getRoom, updateRoomState } from "./multiRoom";
import { getSession, getAccountPlayers, getPlayerSync, getPlayerPartyGroupListSync, getPlayerCharacterSync, getPlayerCharacterManaNodesSync, getPlayerEquipmentSync, updatePlayerSync } from "./wdfpData";
import { PartyCategory, PlayerParty } from "./types";
import playerRankTable from "../../assets/cdndata/player_rank.json";

interface SessionClient {
    socket: net.Socket;
    viewerId: number;
    roomNumber: string;
    connectionId: string;
    isReady: boolean;
    buffer: string;
    mates: any[];
    enterData: any;
    playerId: number | null;
    isBattle: boolean;
    yourself?: any;
}

const clients = new Map<string, SessionClient>();
const roomClients = new Map<string, Set<string>>();
const battleClients = new Map<string, Set<string>>();
const cidToBattleClient = new Map<string, SessionClient>();
const sceneReadyClients = new Map<string, Set<string>>();
const battleExpectedCount = new Map<string, number>();

let server: net.Server | null = null;
const SESSION_PORT = parseInt(process.env.SESSION_PORT || "8003");
const SESSION_HOST = process.env.SESSION_HOST || "0.0.0.0";

const NPC_JOIN_DELAY_MS = parseInt(process.env.NPC_JOIN_DELAY_MS || "2000");
const NPC_READY_DELAY_MS = parseInt(process.env.NPC_READY_DELAY_MS || "500");
const NPC_HOST_READY_COUNTDOWN_MS = parseInt(process.env.NPC_HOST_READY_COUNTDOWN_MS || "3000");
const QUEST_RESULT_DISBAND_DELAY_MS = parseInt(process.env.QUEST_RESULT_DISBAND_DELAY_MS || "60000");
const roomDisbandTimers = new Map<string, NodeJS.Timeout>();

export function hasRoomClients(roomNumber: string): boolean {
    const set = roomClients.get(roomNumber)
    return !!set && set.size > 0
}

function getRankLevel(rankPoint: number): number {
    let level = 1
    for (const [lvl, data] of Object.entries(playerRankTable as Record<string, any>)) {
        const threshold = parseInt(data[0][1])
        if (rankPoint >= threshold) level = parseInt(lvl)
    }
    return level
}

function getAddress(client: SessionClient): string {
    return `${client.viewerId}@${client.roomNumber}`;
}

function addClient(client: SessionClient) {
    const addr = getAddress(client);
    clients.set(addr, client);
    let set = roomClients.get(client.roomNumber);
    if (!set) { set = new Set(); roomClients.set(client.roomNumber, set); }
    set.add(addr);
}

function removeClient(client: SessionClient) {
    const addr = getAddress(client);
    clients.delete(addr);
    if (client.isBattle) {
        battleClients.get(client.roomNumber)?.delete(client.connectionId)
        cidToBattleClient.delete(client.connectionId)
        sceneReadyClients.get(client.roomNumber)?.delete(client.connectionId)
    }
    const set = roomClients.get(client.roomNumber);
    if (set) {
        set.delete(addr);
        const remaining = set.size
        if (remaining === 0) {
            roomClients.delete(client.roomNumber);
            const room = getRoom(client.roomNumber)
            if (client.isBattle) {
                if (room?.raising_state === 1) {
                    console.log(`[SESSION] battle disconnect after finish, room ${client.roomNumber} kept for ${QUEST_RESULT_DISBAND_DELAY_MS / 1000}s return window`)
                    const timer = setTimeout(() => {
                        roomDisbandTimers.delete(client.roomNumber)
                        if (getRoom(client.roomNumber)) {
                            disbandRoom(client.roomNumber)
                            console.log(`[SESSION] room ${client.roomNumber} disbanded (return window expired)`)
                        }
                    }, QUEST_RESULT_DISBAND_DELAY_MS)
                    roomDisbandTimers.set(client.roomNumber, timer)
                } else {
                    console.log(`[SESSION] battle disconnected from room ${client.roomNumber} (room kept, state=${room?.raising_state})`)
                }
            } else {
                disbandRoom(client.roomNumber);
                console.log(`[SESSION] room ${client.roomNumber} disbanded (all clients disconnected)`);
            }
        } else {
            console.log(`[SESSION] client removed: viewer=${client.viewerId} room=${client.roomNumber} remaining=${remaining}`);
            if (!client.isBattle) checkHostAutoReady(client.roomNumber)
        }
    }
}

function sendJson(socket: net.Socket, obj: any) {
    const json = JSON.stringify(obj);
    socket.write(json + "\0");
    const isStart = Array.isArray(obj) && obj[1] && obj[1][0] === 5
    if (isStart) console.log(`[SESSION] START full: ${json}`)
}

function broadcastToRoom(roomNumber: string, obj: any, exceptViewerId?: number) {
    const set = roomClients.get(roomNumber)
    if (!set) return
    for (const addr of set) {
        const c = clients.get(addr)
        if (c && c.viewerId !== exceptViewerId) sendJson(c.socket, obj)
    }
}

function relayToBattleRoom(roomNumber: string, fromViewerId: number, obj: any) {
    const set = battleClients.get(roomNumber)
    if (!set) return
    for (const cid of set) {
        const c = cidToBattleClient.get(cid)
        if (c && c.viewerId !== fromViewerId && c.isBattle) sendJson(c.socket, obj)
    }
}

function getHostClient(roomNumber: string): SessionClient | null {
    const room = getRoom(roomNumber)
    if (!room) return null
    const set = roomClients.get(roomNumber)
    if (!set) return null
    for (const addr of set) {
        const c = clients.get(addr)
        if (c && c.viewerId === room.host_viewer_id && !c.isBattle) return c
    }
    return null
}

function checkHostAutoReady(roomNumber: string) {
    const room = getRoom(roomNumber)
    if (!room || room.is_npc_mode) return
    const hostClient = getHostClient(roomNumber)
    if (!hostClient) return
    const hostMate = hostClient.mates.find(m => m.viewerId === hostClient.viewerId)
    if (!hostMate) return
    const nonHostReady = hostClient.mates.every(m =>
        m.viewerId === hostClient.viewerId || m.state?.[0] === 1
    )
    if (nonHostReady && hostClient.mates.length > 1) {
        if (hostMate.state?.[0] !== 1) {
            hostMate.state = [1]
            broadcastToRoom(roomNumber, [1, [2, hostMate.connectionId, [1]]])
            console.log(`[SESSION] host auto-ready: room=${roomNumber}`)
        }
    } else {
        if (hostMate.state?.[0] === 1) {
            hostMate.state = [0]
            broadcastToRoom(roomNumber, [1, [2, hostMate.connectionId, [0]]])
            console.log(`[SESSION] host auto-ready cancelled: room=${roomNumber}`)
        }
    }
}

function handleMessage(client: SessionClient, data: string) {
    try {
        const msg = JSON.parse(data);
        if (Array.isArray(msg)) { handleClient2Server(client, msg); return; }
        console.log(`[SESSION] unknown message:`, data.substring(0, 100));
    } catch (e) {
        console.log(`[SESSION] parse error:`, (e as Error).message, data.substring(0, 100));
    }
}

function handleClient2Server(client: SessionClient, msg: any[]) {
    const tag = msg[0];
    switch (tag) {
        case 0: // Notify
            if (msg.length > 1 && Array.isArray(msg[1])) {
                if (client.isBattle) handleBattleNotify(client, msg[1]);
                else handleNotify(client, msg[1]);
            }
            break;
        case 1: // Broadcast
            if (client.isBattle) {
                relayToBattleRoom(client.roomNumber, client.viewerId, [2, [String(client.viewerId), msg[1]]])
                sendJson(client.socket, [1, [3, 0, 0, Date.now()]]);
            }
            break;
        case 2: // Send
            if (client.isBattle) {
                const subTag = msg[1]?.[0]
                if (subTag !== 2) relayToBattleRoom(client.roomNumber, client.viewerId, [3, [String(client.viewerId), msg[1]]])
                sendJson(client.socket, [1, [3, 0, 0, Date.now()]]);
            }
            break;
        default:
            console.log(`[SESSION] unhandled Client2Server: ${tag}`);
    }
}

function handleNotify(client: SessionClient, msg: any[]) {
    const tag = msg[0];
    switch (tag) {
        case 0: { // Enter
            client.enterData = msg[1];
            console.log(`[SESSION] client ${client.viewerId} entered room ${client.roomNumber}`);
            if (client.mates[0] && client.yourself && msg[1]?.party) {
                const yours = client.yourself;
                const ed = msg[1];
                yours.party = ed.party;
                if (ed.autoplayMode !== undefined) yours.autoplayMode = ed.autoplayMode;
                if (ed.autoskillMode !== undefined) yours.autoskillMode = ed.autoskillMode;
                if (ed.autoSpeedLevel !== undefined) yours.autoSpeedLevel = ed.autoSpeedLevel;
                if (ed.autoStart !== undefined) yours.autoStart = ed.autoStart;
                if (ed.skillAbilityBehaviorMode !== undefined) yours.skillAbilityBehaviorMode = ed.skillAbilityBehaviorMode;
                if (ed.dashBehaviorMode !== undefined) yours.dashBehaviorMode = ed.dashBehaviorMode;
                if (ed.allowHealFromOtherPlayers !== undefined) yours.allowHealFromOtherPlayers = ed.allowHealFromOtherPlayers;
                const room = getRoom(client.roomNumber)
                const isHost = client.viewerId === room?.host_viewer_id
                if (room && !isHost) {
                    const hostClient = getHostClient(client.roomNumber)
                    if (hostClient && hostClient.mates[0]) {
                        const hostMate = hostClient.mates[0]
                        client.mates = [hostMate, yours]
                        sendJson(client.socket, [1, [0, yours, [yours]]])
                        setTimeout(() => sendJson(client.socket, [1, [1, client.mates]]), 100)
                        hostClient.mates = [hostMate, yours]
                        broadcastToRoom(client.roomNumber, [1, [1, hostClient.mates]], client.viewerId)
                        room.is_npc_mode = false
                        console.log(`[SESSION] guest ${client.viewerId} joined room ${client.roomNumber}, mates=${client.mates.length} is_npc_mode=false`)
                        checkHostAutoReady(client.roomNumber)
                    }
                } else {
                    client.mates = [yours]
                    console.log(`[SESSION] host party from client Enter: chars=${ed.party?.characters?.map((c: any) => c?.[0] === 0 ? c[1]?.id : 'none')?.join(',')}`);
                    sendJson(client.socket, [1, [0, yours, [yours]]]);
                    setTimeout(() => sendJson(client.socket, [1, [1, [yours]]]), 100);
                    if (room?.is_npc_mode && client.mates.length === 1) {
                        setTimeout(() => handleEnterComs(client, [{ name: "开心超人" }, { name: "名字真难取" }]), 500)
                    }
                }
            }
            break;
        }
        case 4: // Heartbeat
            sendJson(client.socket, [1, [10, String(client.viewerId)]]);
            break;
        case 2: { // ChangeParty
            const pd = msg[1]
            if (pd?.party && client.mates[0] && pd.currentPartyId !== undefined) {
                const mate = client.mates.find(m => m.viewerId === client.viewerId)
                if (mate) {
                    mate.party = pd.party
                    mate.currentPartyId = pd.currentPartyId
                    if (client.playerId) {
                        try { updatePlayerSync({ id: client.playerId, partySlot: pd.currentPartyId }) } catch (e) {}
                    }
                    const room = getRoom(client.roomNumber)
                    if (room) room.host_party_id = pd.currentPartyId
                    broadcastToRoom(client.roomNumber, [1, [1, client.mates]])
                    console.log(`[SESSION] client ${client.viewerId} changed party to slot=${pd.currentPartyId}`)
                }
            }
            break;
        }
        case 3: { // Ready
            const mate = client.mates.find(m => m.viewerId === client.viewerId)
            if (mate) {
                mate.state = msg[1] ?? [1]
                broadcastToRoom(client.roomNumber, [1, [2, mate.connectionId, mate.state]])
                console.log(`[SESSION] client ${client.viewerId} ready via cid=${mate.connectionId}`)
                checkHostAutoReady(client.roomNumber)
            }
            break;
        }
        case 1: // Bye
            console.log(`[SESSION] client ${client.viewerId} leaving room ${client.roomNumber}`);
            disconnectClient(client);
            break;
        case 6: // StartBattle
            console.log(`[SESSION] client ${client.viewerId} StartBattle, mates=${client.mates.length}`)
            const room = getRoom(client.roomNumber)
            battleExpectedCount.set(client.roomNumber, room?.is_npc_mode ? 1 : client.mates.length)
            broadcastToRoom(client.roomNumber, [1, [5, client.mates]])
            break;
        case 5: case 7: case 8: case 9:
            break;
        case 10: // EnterComs
            handleEnterComs(client, msg[1] as any[])
            break;
        default:
            console.log(`[SESSION] unhandled Notify: ${tag}`, JSON.stringify(msg).substring(0, 100));
    }
}

function disconnectClient(client: SessionClient) {
    removeClient(client);
    try { client.socket.destroy(); } catch (e) {}
}

function handleBattleNotify(client: SessionClient, msg: any[]) {
    const tag = msg[0];
    switch (tag) {
        case 0: { // SceneReady → wait for ALL battle clients
            const expected = battleExpectedCount.get(client.roomNumber) ?? 0
            if (expected <= 0) break
            console.log(`[SESSION] battle SceneReady: room=${client.roomNumber} cid=${client.connectionId}`)
            let readySet = sceneReadyClients.get(client.roomNumber)
            if (!readySet) { readySet = new Set(); sceneReadyClients.set(client.roomNumber, readySet) }
            readySet.add(client.connectionId)
            const connected = battleClients.get(client.roomNumber)?.size ?? 0
            if (readySet.size >= expected && readySet.size >= connected) {
                console.log(`[SESSION] battle all SceneReady (${readySet.size}/${expected}): room=${client.roomNumber}, broadcasting BattleStart`)
                battleExpectedCount.set(client.roomNumber, 0)
                const set = battleClients.get(client.roomNumber)
                if (set) for (const cid of set) {
                    const c = cidToBattleClient.get(cid)
                    if (c) sendJson(c.socket, [1, [1]])
                }
            }
            break;
        }
        case 1: // Finalize
            console.log(`[SESSION] battle Finalize: room=${client.roomNumber}`)
            sendJson(client.socket, [1, [2]]);
            break;
        case 2: { // Measurement
            const params = msg[1];
            const frame = params?.[0] ?? 0;
            const clientTime = params?.[1] ?? 0;
            sendJson(client.socket, [1, [3, frame, clientTime, Date.now()]]);
            break;
        }
        case 4: // Heartbeat
            sendJson(client.socket, [1, [3, 0, 0, Date.now()]]);
            break;
        default:
            console.log(`[SESSION] battle unhandled Notify: ${tag}`, JSON.stringify(msg).substring(0, 100));
    }
}

function handleEnterComs(client: SessionClient, coms: any[]) {
    const room = getRoom(client.roomNumber)
    if (room) room.is_npc_mode = true
    const host = client.mates[0]
    if (!host) return
    const npcParties: any[] = []
    const hostParty = host.party
    if (client.playerId) {
        try {
            for (const category of [PartyCategory.NORMAL, PartyCategory.EVENT]) {
                const groups = getPlayerPartyGroupListSync(client.playerId, category)
                for (const g of Object.values(groups)) {
                    for (const party of Object.values(g.list)) {
                        if (party.name && party.name.includes("NPC")) {
                            npcParties.push(buildRealParty(client.playerId, party))
                        }
                    }
                }
            }
        } catch (e) {}
    }
    const npcMates: any[] = []
    for (let i = 0; i < 2; i++) {
        const party = npcParties[i] ?? (npcParties[0] ?? hostParty)
        const comId = i + 1
        npcMates.push({
            viewerId: 900000000 + comId, comId, name: coms[i]?.name ?? `NPC${comId}`,
            rank: host.rank, degreeId: host.degreeId, playerRoleKind: 99,
            party, connectionId: `${client.roomNumber}-npc-${comId}`,
            autoplayMode: false, autoskillMode: 1, autoSpeedLevel: 1, autoStart: false,
            skillAbilityBehaviorMode: 1, dashBehaviorMode: 1, allowHealFromOtherPlayers: true,
            state: [0], entryTime: Date.now(), isNewbie: false, isHost: false
        })
    }
    client.mates = [host, ...npcMates]
    console.log(`[SESSION] EnterComs: room=${client.roomNumber} total mates=${client.mates.length}`)
    updateRoomState(client.roomNumber, 3)
    setTimeout(() => { sendJson(client.socket, [1, [1, client.mates]]) }, NPC_JOIN_DELAY_MS)
    setTimeout(() => {
        for (const npc of npcMates) { npc.state = [1]; sendJson(client.socket, [1, [2, npc.connectionId, [1]]]) }
    }, NPC_JOIN_DELAY_MS + NPC_READY_DELAY_MS)
    const hostReadyAt = NPC_JOIN_DELAY_MS + NPC_READY_DELAY_MS + NPC_HOST_READY_COUNTDOWN_MS
    if (NPC_HOST_READY_COUNTDOWN_MS > 0) console.log(`[SESSION] host ready in ${NPC_HOST_READY_COUNTDOWN_MS / 1000}s room=${client.roomNumber}`)
    setTimeout(() => {
        host.state = [1]; client.isReady = true
        sendJson(client.socket, [1, [2, host.connectionId, [1]]])
    }, hostReadyAt)
}

export function startSessionServer(): Promise<void> {
    return new Promise((resolve) => {
        server = net.createServer((socket) => {
            const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
            console.log(`[SESSION] new connection from ${remoteAddr}`);
            let buffer = ""; let handledHandshake = false; let sessionClient: SessionClient | null = null;
            socket.on("data", (chunk: Buffer) => {
                buffer += chunk.toString("utf-8");
                while (buffer.includes("\0")) {
                    const idx = buffer.indexOf("\0");
                    const data = buffer.substring(0, idx);
                    buffer = buffer.substring(idx + 1);
                    if (data.trim().length === 0) continue;
                    if (!handledHandshake) {
                        handleHandshake(socket, data, remoteAddr).then((cl) => { sessionClient = cl; handledHandshake = true; }).catch((err) => { console.log(`[SESSION] handshake failed:`, err); socket.destroy(); });
                    } else if (sessionClient) {
                        handleMessage(sessionClient, data);
                    }
                }
            });
            socket.on("close", () => { if (sessionClient) removeClient(sessionClient); });
            socket.on("error", (err) => { if (sessionClient) removeClient(sessionClient); });
        });
        server.listen(SESSION_PORT, SESSION_HOST, () => { console.log(`[SESSION] TCP session server listening on ${SESSION_HOST}:${SESSION_PORT}`); resolve(); });
    });
}

export function stopSessionServer(): Promise<void> {
    return new Promise((resolve) => {
        if (server) { clients.clear(); roomClients.clear(); server.close(() => resolve()); } else resolve();
    });
}

function buildDefaultParty(): any {
    const emptyChar = [0, { id: 0, evolution_level: 0, exp: 0, over_limit_step: 0, mana_node_ids: [], ex_boost: [1], illustration_settings: [1] }]
    return { characters: [emptyChar, emptyChar, emptyChar], unison_characters: [emptyChar, emptyChar, emptyChar], equipments: [[1], [1], [1]], abilitySoulIds: [[1], [1], [1]] }
}

function buildRealParty(playerId: number, party: PlayerParty): any {
    const buildChar = (charId: number | null) => {
        if (!charId) return [1]
        const dbChar = getPlayerCharacterSync(playerId, charId)
        if (!dbChar) return [1]
        const rawNodes = getPlayerCharacterManaNodesSync(playerId, charId)
        const manaNodeMap: Record<string, number> = {}
        for (const id of rawNodes) manaNodeMap[String(id)] = 0
        let exBoost: any = [1]
        if (dbChar.exBoost && dbChar.exBoost.abilityIdList && dbChar.exBoost.abilityIdList.length > 0) {
            exBoost = [0, { ability_id_list: dbChar.exBoost.abilityIdList, status_id: dbChar.exBoost.statusId }]
        }
        let illustration: any = [1]
        if (dbChar.illustrationSettings && dbChar.illustrationSettings.length > 0) illustration = [0, dbChar.illustrationSettings]
        return [0, { id: charId, evolution_level: dbChar.evolutionLevel, exp: dbChar.exp, over_limit_step: dbChar.overLimitStep, mana_node_ids: manaNodeMap, ex_boost: exBoost, illustration_settings: illustration }]
    }
    const buildEquip = (equipId: number | null) => {
        if (!equipId) return [1]
        const dbEquip = getPlayerEquipmentSync(playerId, equipId)
        if (!dbEquip) return [1]
        return [0, { equipmentId: equipId, level: dbEquip.level, enhancementLevel: dbEquip.enhancementLevel }]
    }
    return { characters: party.characterIds.map(buildChar), unison_characters: party.unisonCharacterIds.map(buildChar), equipments: party.equipmentIds.map(buildEquip), abilitySoulIds: party.abilitySoulIds.map(id => id ? [0, id] : [1]) }
}

async function handleHandshake(socket: net.Socket, data: string, remoteAddr: string): Promise<SessionClient> {
    console.log(`[SESSION] handshake from ${remoteAddr}:`, data);
    let handshake: any;
    try { handshake = JSON.parse(data); } catch { throw new Error("Invalid handshake JSON"); }

    if (handshake.socklet === "cooperation_battle") {
        const battleRoomNumber = handshake.roomNumber, connectionId = handshake.connectionId
        if (!battleRoomNumber) throw new Error("Missing roomNumber for battle handshake")
        const battleClient: SessionClient = { socket, viewerId: 0, roomNumber: String(battleRoomNumber), connectionId: String(connectionId), isReady: false, buffer: "", mates: [], enterData: null, playerId: null, isBattle: true }
        addClient(battleClient)
        let btSet = battleClients.get(String(battleRoomNumber)); if (!btSet) { btSet = new Set(); battleClients.set(String(battleRoomNumber), btSet) }
        btSet.add(String(connectionId))
        cidToBattleClient.set(String(connectionId), battleClient)
        sendJson(socket, [0, battleRoomNumber, ""])
        return battleClient
    }

    const viewerId = handshake.viewerId, roomNumber = handshake.roomNumber;
    if (!viewerId || !roomNumber) throw new Error("Missing viewerId or roomNumber");
    let playerName = `Player${viewerId}`, playerRank = 1, playerDegreeId = 1, playerRoleKind = 1, playerIsNewbie = false, playerPartySlot = 1, actualPlayerId: number | null = null;
    try {
        const session = await getSession(String(viewerId));
        if (session) {
            const playerIds = await getAccountPlayers(session.accountId);
            if (playerIds && playerIds.length > 0 && !isNaN(playerIds[0])) {
                const player = getPlayerSync(playerIds[0]);
                if (player) { playerName = player.name || playerName; playerRank = getRankLevel(player.rankPoint || 0); playerDegreeId = player.degreeId || playerDegreeId; playerRoleKind = player.role || playerRoleKind; playerIsNewbie = !!player.tutorialStep; playerPartySlot = player.partySlot || 1; actualPlayerId = playerIds[0]; }
            }
        }
    } catch (e) { console.log(`[SESSION] failed to read player data for viewer=${viewerId}:`, (e as Error).message); }

    const isHost = Number(viewerId) === getRoom(String(roomNumber))?.host_viewer_id
    const connectionId = isHost ? `${roomNumber}-host` : `${roomNumber}-${viewerId}`;
    const client: SessionClient = { socket, viewerId: Number(viewerId), roomNumber: String(roomNumber), connectionId, isReady: false, buffer: "", mates: [], enterData: null, playerId: actualPlayerId, isBattle: false };
    const isReconnect = (roomClients.get(String(roomNumber))?.size ?? 0) > 0
    const existingTimer = roomDisbandTimers.get(String(roomNumber))
    if (existingTimer) { clearTimeout(existingTimer); roomDisbandTimers.delete(String(roomNumber)); console.log(`[SESSION] room ${roomNumber} return window cancelled, new client connecting`) }
    addClient(client);
    console.log(`[SESSION] client added: viewer=${viewerId} room=${roomNumber} total=${roomClients.get(roomNumber)?.size} ${isReconnect ? '[RECONNECT]' : '[NEW]'}`);
    console.log(`[SESSION] handshake OK viewer=${viewerId} room=${roomNumber} name=${playerName} ${isHost ? '[HOST]' : '[GUEST]'}`)
    sendJson(socket, [0, connectionId, roomNumber]);
    if (isHost) updateRoomState(String(roomNumber), 1);

    let hostParty = buildDefaultParty()
    const rawPartyId = getRoom(roomNumber)?.host_party_id ?? playerPartySlot
    if (actualPlayerId) {
        try {
            const partyGroups = getPlayerPartyGroupListSync(actualPlayerId, PartyCategory.NORMAL)
            const groupIndex = Math.floor((rawPartyId - 1) / 10), slot = ((rawPartyId - 1) % 10) + 1
            const group = partyGroups[groupIndex + 1] ?? partyGroups[Object.keys(partyGroups)[0]]
            if (group) { const party = group.list[slot] ?? group.list[Object.keys(group.list)[0]]; if (party) hostParty = buildRealParty(actualPlayerId, party) }
        } catch (e) {}
    }
    const yourself = { viewerId: Number(viewerId), name: playerName, playerRoleKind, rank: playerRank, degreeId: playerDegreeId, party: hostParty, connectionId, autoplayMode: false, autoskillMode: 1, autoSpeedLevel: 1, autoStart: false, skillAbilityBehaviorMode: 1, dashBehaviorMode: 1, allowHealFromOtherPlayers: true, state: [0], entryTime: Date.now(), isNewbie: playerIsNewbie, isHost, currentPartyId: playerPartySlot };
    client.yourself = yourself;
    client.mates = [yourself];
    return client;
}

export { SESSION_PORT, SESSION_HOST };
