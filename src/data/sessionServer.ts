// Multi battle TCP session server
// Phase 1: Room creation only (no NPCs, no auto-start)
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

import * as net from "net";
import { MultiRoom } from "../lib/types";
import { disbandRoom, getRoom } from "./multiRoom";
import { getSession, getAccountPlayers, getPlayerSync, getPlayerPartyGroupListSync, getPlayerCharacterSync, getPlayerCharacterManaNodesSync, getPlayerEquipmentSync, updatePlayerSync } from "./wdfpData";
import { PartyCategory, PlayerParty, PlayerCharacter, PlayerEquipment } from "./types";
import playerRankTable from "../../../wf-assets-cn/orderedmap/player/player_rank.json";

interface SessionClient {
    socket: net.Socket;
    viewerId: number;
    roomNumber: string;
    isReady: boolean;
    buffer: string;
    mates: any[];
    enterData: any;
    playerId: number | null;
    isBattle: boolean;
}

const clients = new Map<string, SessionClient>();
const roomClients = new Map<string, Set<string>>();

let server: net.Server | null = null;
const SESSION_PORT = parseInt(process.env.SESSION_PORT || "8003");
const SESSION_HOST = process.env.SESSION_HOST || "0.0.0.0";

// NPC recruit timing (env-configurable, defaults)
const NPC_JOIN_DELAY_MS = parseInt(process.env.NPC_JOIN_DELAY_MS || "2000");
const NPC_READY_DELAY_MS = parseInt(process.env.NPC_READY_DELAY_MS || "500");
const HOST_READY_DELAY_MS = parseInt(process.env.NPC_HOST_READY_DELAY_MS || "500");

// Calculate rank level from rankPoint using CDN threshold table
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
    if (!set) {
        set = new Set();
        roomClients.set(client.roomNumber, set);
    }
    set.add(addr);
}

function removeClient(client: SessionClient) {
    const addr = getAddress(client);
    clients.delete(addr);

    const set = roomClients.get(client.roomNumber);
    if (set) {
        set.delete(addr);
        if (set.size === 0) {
            roomClients.delete(client.roomNumber);
            disbandRoom(client.roomNumber);
            console.log(`[SESSION] room ${client.roomNumber} disbanded (all clients disconnected)`);
        }
    }
}

function sendJson(socket: net.Socket, obj: any) {
    const json = JSON.stringify(obj);
    socket.write(json + "\0");
    const tag = Array.isArray(obj) && Array.isArray(obj[1]) && Array.isArray(obj[1][1]) ? ` [1][${obj[1][0]}][N=${obj[1][1].length}]` : '';
    // Log full JSON for Start messages to debug F1009
    const isStart = Array.isArray(obj) && obj[1] && obj[1][0] === 5
    if (isStart) {
        console.log(`[SESSION] START full: ${json}`)
    } else {
        console.log(`[SESSION] sent to ${(socket as any).remoteAddress}:${(socket as any).remotePort}${tag}:`, json.substring(0, 200));
    }
}

function handleMessage(client: SessionClient, data: string) {
    try {
        const msg = JSON.parse(data);
        console.log(`[SESSION] recv from viewer=${client.viewerId}: ${data.substring(0, 150)}`);

        if (Array.isArray(msg)) {
            handleClient2Server(client, msg);
            return;
        }

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
                const notifyTag = msg[1][0]
                console.log(`[SESSION] Notify tag=${notifyTag} from viewer=${client.viewerId} ${client.isBattle ? '[BATTLE]' : ''}`)
                if (client.isBattle) {
                    handleBattleNotify(client, msg[1]);
                } else {
                    handleNotify(client, msg[1]);
                }
            }
            break;
        case 1: // Broadcast
            console.log(`[SESSION] Broadcast from viewer=${client.viewerId}`);
            break;
        case 2: // Send
            console.log(`[SESSION] Send from viewer=${client.viewerId}`);
            break;
        default:
            console.log(`[SESSION] unhandled Client2Server: ${tag}`);
    }
}

function handleNotify(client: SessionClient, msg: any[]) {
    const tag = msg[0];
    switch (tag) {
        case 0: // Enter
            client.enterData = msg[1];
            console.log(`[SESSION] client ${client.viewerId} entered room ${client.roomNumber}`);
            // Sync host mate with client's actual settings from Enter data
            if (client.mates[0] && msg[1]) {
                const host = client.mates[0]
                const ed = msg[1]
                if (ed.autoplayMode !== undefined) host.autoplayMode = ed.autoplayMode
                if (ed.autoskillMode !== undefined) host.autoskillMode = ed.autoskillMode
                if (ed.autoSpeedLevel !== undefined) host.autoSpeedLevel = ed.autoSpeedLevel
                if (ed.autoStart !== undefined) host.autoStart = ed.autoStart
                if (ed.skillAbilityBehaviorMode !== undefined) host.skillAbilityBehaviorMode = ed.skillAbilityBehaviorMode
                if (ed.dashBehaviorMode !== undefined) host.dashBehaviorMode = ed.dashBehaviorMode
                if (ed.allowHealFromOtherPlayers !== undefined) host.allowHealFromOtherPlayers = ed.allowHealFromOtherPlayers
                if (ed.currentPartyId !== undefined) host.currentPartyId = ed.currentPartyId
                console.log(`[SESSION] host synced: auto=${host.autoplayMode} speed=${host.autoSpeedLevel} allowHeal=${host.allowHealFromOtherPlayers} partyId=${host.currentPartyId}`)
                // Push updated mate data to client
                sendJson(client.socket, [1, [1, client.mates]])
            }
            break;

        case 4: // Heartbeat
            sendJson(client.socket, [1, [10, String(client.viewerId)]]);
            break;

        case 2: // ChangeParty
            console.log(`[SESSION] client ${client.viewerId} changed party`);
            // Rebuild host party from ChangeParty data
            const pd = msg[1]
            if (pd?.party && client.mates[0] && pd.currentPartyId !== undefined) {
                const host = client.mates[0]
                // Extract IDs: characters → .id, equipment → .equipmentId, souls → bare number
                const getOptVal = (arr: any) => (Array.isArray(arr) && arr[0] === 0 && arr[1]) ? arr[1] : null
                const getCharIds = (arr: any) => Array.isArray(arr) ? arr.map((c: any) => { const v = getOptVal(c); return v?.id ?? null }) : []
                const getEquipIds = (arr: any) => Array.isArray(arr) ? arr.map((e: any) => { const v = getOptVal(e); return v?.equipmentId ?? null }) : []
                const getSoulIds = (arr: any) => Array.isArray(arr) ? arr.map((s: any) => { const v = getOptVal(s); return v ?? null }) : []
                const charIds = getCharIds(pd.party.characters)
                const unisonIds = getCharIds(pd.party.unison_characters)
                const equipIds = getEquipIds(pd.party.equipments)
                const soulIds = getSoulIds(pd.party.abilitySoulIds)
                const newParty: PlayerParty = {
                    name: pd.name ?? host.name,
                    characterIds: [charIds[0] ?? null, charIds[1] ?? null, charIds[2] ?? null],
                    unisonCharacterIds: [unisonIds[0] ?? null, unisonIds[1] ?? null, unisonIds[2] ?? null],
                    equipmentIds: [equipIds[0] ?? null, equipIds[1] ?? null, equipIds[2] ?? null],
                    abilitySoulIds: [soulIds[0] ?? null, soulIds[1] ?? null, soulIds[2] ?? null],
                    edited: true,
                    options: { allowOtherPlayersToHealMe: true },
                    category: PartyCategory.NORMAL
                }
                host.party = buildRealParty(client.playerId!, newParty)
                host.currentPartyId = pd.currentPartyId
                // Sync party slot to DB + room so re-entry uses correct party
                if (client.playerId) {
                    try {
                        updatePlayerSync({ id: client.playerId, partySlot: pd.currentPartyId })
                    } catch (e) {
                        console.log(`[SESSION] failed to sync partySlot to DB:`, (e as Error).message)
                    }
                }
                const room = getRoom(client.roomNumber)
                if (room) room.host_party_id = pd.currentPartyId
                const gIdx = Math.floor((pd.currentPartyId - 1) / 10)
                const s = ((pd.currentPartyId - 1) % 10) + 1
                console.log(`[SESSION] party changed: partyId=${pd.currentPartyId} group=${gIdx+1} slot=${s} chars=${charIds.filter(Boolean)}`)
                sendJson(client.socket, [1, [1, client.mates]])
            }
            break;

        case 3: // Ready
            console.log(`[SESSION] client ${client.viewerId} ready state=`, msg[1])
            const mate = client.mates.find(m => m.viewerId === client.viewerId)
            if (mate) {
                mate.state = msg[1] ?? [1]
                sendJson(client.socket, [1, [2, mate.connectionId, mate.state]])
                console.log(`[SESSION] client ${client.viewerId} ready via cid=${mate.connectionId}`)
            }
            break;

        case 1: // Bye
            console.log(`[SESSION] client ${client.viewerId} leaving room ${client.roomNumber}`);
            disconnectClient(client);
            break;

        case 6: // StartBattle (CN index 6)
            console.log(`[SESSION] client ${client.viewerId} StartBattle, mates=${client.mates.length}`)
            // Send Start(members) to all mates
            sendJson(client.socket, [1, [5, client.mates]])
            break;

        case 5: // Suspend (CN index 5)
            console.log(`[SESSION] client ${client.viewerId} suspended`);
            break;

        case 9: // Log
            console.log(`[SESSION] client ${client.viewerId} log:`, typeof msg[1] === 'string' ? (msg[1] as string).substring(0, 100) : msg[1]);
            break;

        case 10: // EnterComs (NPC recruitment)
            const coms = msg[1] as any[]
            console.log(`[SESSION] client ${client.viewerId} EnterComs: ${coms.length} NPCs`)
            handleEnterComs(client, coms)
            break;

        case 7: // ChangeAutoplayMode
        case 8: // ChangeAutoStart
            console.log(`[SESSION] client ${client.viewerId}: notify=${tag}`);
            break;

        default:
            console.log(`[SESSION] unhandled Notify: ${tag}`, JSON.stringify(msg).substring(0, 100));
    }
}

function disconnectClient(client: SessionClient) {
    removeClient(client);
    try { client.socket.destroy(); } catch (e) {}
}

// Battle protocol (cooperation_battle socklet)
// BattleNotifyMessage: SceneReady=4?, Heartbeat=?, Finalize=?
// BattleServerMessage: BattleStart=1
function handleBattleNotify(client: SessionClient, msg: any[]) {
    const tag = msg[0];
    switch (tag) {
        case 4: // Heartbeat (battle)
            sendJson(client.socket, [1, [10, String(client.roomNumber)]]);
            break;
        case 5: // SceneReady → respond with BattleStart
            console.log(`[SESSION] battle SceneReady: room=${client.roomNumber}`)
            // MeetingServer2Client.Message(BattleServerMessage.BattleStart)
            // BattleStart index=1, parameterless → [1]
            sendJson(client.socket, [1, [1]]);
            break;
        default:
            console.log(`[SESSION] battle unhandled Notify: ${tag}`, JSON.stringify(msg).substring(0, 100));
    }
}

function handleEnterComs(client: SessionClient, coms: any[]) {
    // Get host mate (already built from real data)
    const host = client.mates[0]
    if (!host) {
        console.log(`[SESSION] EnterComs error: no host mate found`)
        return
    }

    // Build NPC parties from real DB data — find parties named with "NPC"
    const npcParties: any[] = []
    const hostParty = host.party  // fallback: use host party if no NPC parties

    if (client.playerId) {
        try {
            for (const category of [PartyCategory.NORMAL, PartyCategory.EVENT]) {
                const groups = getPlayerPartyGroupListSync(client.playerId, category)
                for (const g of Object.values(groups)) {
                    for (const party of Object.values(g.list)) {
                        if (party.name && party.name.includes("NPC")) {
                            npcParties.push(buildRealParty(client.playerId, party))
                            console.log(`[SESSION] EnterComs: NPC party "${party.name}" slot=${Object.keys(g.list).find(k => g.list[k] === party)}`)
                        }
                    }
                }
            }
        } catch (e) {
            console.log(`[SESSION] EnterComs: failed to read parties:`, (e as Error).message)
        }
    }

    // Build NPC mates
    const npcMates: any[] = []
    for (let i = 0; i < 2; i++) {
        const party = npcParties[i] ?? (npcParties[0] ?? hostParty)
        const comId = i + 1
        const mate = {
            viewerId: 900000000 + comId,  // dummy positive IDs for NPC finish validation
            comId: comId,
            name: coms[i]?.name ?? `NPC${comId}`,
            rank: host.rank,  // use host's rank level
            degreeId: host.degreeId,  // use host's degree
            playerRoleKind: 99,
            party: party,
            connectionId: `${client.roomNumber}-npc-${comId}`,
            autoplayMode: false,
            autoskillMode: 1,
            autoSpeedLevel: 1,
            autoStart: false,
            skillAbilityBehaviorMode: 1,
            dashBehaviorMode: 1,
            allowHealFromOtherPlayers: true,
            state: [0],
            entryTime: Date.now(),
            isNewbie: false,
            isHost: false
        }
        npcMates.push(mate)
    }

    console.log(`[SESSION] EnterComs: room=${client.roomNumber} npcParties=${npcParties.length} fromDB`)

    // Update mates: [host, npc1, npc2, ...]
    client.mates = [host, ...npcMates]
    console.log(`[SESSION] EnterComs: room=${client.roomNumber} total mates=${client.mates.length}`)

    // 1. Send Mates update after configured join delay (NPCs join, state=[0] Preparation)
    setTimeout(() => {
        sendJson(client.socket, [1, [1, client.mates]])
        console.log(`[SESSION] EnterComs: NPCs joined room=${client.roomNumber} mates=${client.mates.length}`)
    }, NPC_JOIN_DELAY_MS)

    // 2. NPCs transition to Ready state
    setTimeout(() => {
        for (const npc of npcMates) {
            npc.state = [1]
            sendJson(client.socket, [1, [2, npc.connectionId, [1]]])
            console.log(`[SESSION] NPC ready: cid=${npc.connectionId} name=${npc.name}`)
        }
    }, NPC_JOIN_DELAY_MS + NPC_READY_DELAY_MS)

    // 3. Host auto-ready after NPCs
    setTimeout(() => {
        host.state = [1]
        client.isReady = true
        sendJson(client.socket, [1, [2, host.connectionId, [1]]])
        console.log(`[SESSION] EnterComs: host auto-ready viewer=${client.viewerId} cid=${host.connectionId}`)
    }, NPC_JOIN_DELAY_MS + NPC_READY_DELAY_MS + HOST_READY_DELAY_MS)
}

export function startSessionServer(): Promise<void> {
    return new Promise((resolve) => {
        server = net.createServer((socket) => {
            const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
            console.log(`[SESSION] new connection from ${remoteAddr}`);

            let buffer = "";
            let handledHandshake = false;
            let sessionClient: SessionClient | null = null;

            socket.on("data", (chunk: Buffer) => {
                buffer += chunk.toString("utf-8");

                while (buffer.includes("\0")) {
                    const idx = buffer.indexOf("\0");
                    const data = buffer.substring(0, idx);
                    buffer = buffer.substring(idx + 1);

                    if (data.trim().length === 0) continue;

                    if (!handledHandshake) {
                        handleHandshake(socket, data, remoteAddr).then((client) => {
                            sessionClient = client;
                            handledHandshake = true;
                        }).catch((err) => {
                            console.log(`[SESSION] handshake failed from ${remoteAddr}:`, err);
                            socket.destroy();
                        });
                    } else if (sessionClient) {
                        handleMessage(sessionClient, data);
                    }
                }
            });

            socket.on("close", () => {
                console.log(`[SESSION] disconnect from ${remoteAddr}`);
                if (sessionClient) removeClient(sessionClient);
            });

            socket.on("error", (err) => {
                console.log(`[SESSION] socket error from ${remoteAddr}:`, err.message);
                if (sessionClient) removeClient(sessionClient);
            });
        });

        server.listen(SESSION_PORT, SESSION_HOST, () => {
            console.log(`[SESSION] TCP session server listening on ${SESSION_HOST}:${SESSION_PORT}`);
            resolve();
        });
    });
}

export function stopSessionServer(): Promise<void> {
    return new Promise((resolve) => {
        if (server) {
            clients.clear();
            roomClients.clear();
            server.close(() => resolve());
        } else {
            resolve();
        }
    });
}

function buildDefaultParty(): any {
    const emptyChar = [0, {
        id: 0, evolution_level: 0, exp: 0, over_limit_step: 0,
        mana_node_ids: [], ex_boost: [1], illustration_settings: [1]
    }]
    return {
        characters: [emptyChar, emptyChar, emptyChar],
        unison_characters: [emptyChar, emptyChar, emptyChar],
        equipments: [[1], [1], [1]],
        abilitySoulIds: [[1], [1], [1]]
    }
}

function buildRealParty(playerId: number, party: PlayerParty): any {
    const buildChar = (charId: number | null) => {
        if (!charId) return [1]  // Option None
        const dbChar = getPlayerCharacterSync(playerId, charId)
        if (!dbChar) return [1]
        // mana_node_ids must stay empty — CN client ManaNodeTable lookup crashes (C8601 key=0) in multi-battle
        const manaNodeIds: number[] = []
        // ex boost from DB
        let exBoost: any = [1]
        if (dbChar.exBoost && dbChar.exBoost.abilityIdList && dbChar.exBoost.abilityIdList.length > 0) {
            exBoost = [0, { ability_id_list: dbChar.exBoost.abilityIdList, status_id: dbChar.exBoost.statusId }]
        }
        // illustration_settings
        let illustration: any = [1]
        if (dbChar.illustrationSettings && dbChar.illustrationSettings.length > 0) {
            illustration = [0, dbChar.illustrationSettings]
        }
        return [0, {
            id: charId,
            evolution_level: dbChar.evolutionLevel,
            exp: dbChar.exp,
            over_limit_step: dbChar.overLimitStep,
            mana_node_ids: manaNodeIds,
            ex_boost: exBoost,
            illustration_settings: illustration
        }]
    }

    const buildEquip = (equipId: number | null) => {
        if (!equipId) return [1]
        const dbEquip = getPlayerEquipmentSync(playerId, equipId)
        if (!dbEquip) return [1]
        return [0, {
            equipmentId: equipId,
            level: dbEquip.level,
            enhancementLevel: dbEquip.enhancementLevel
        }]
    }

    return {
        characters: party.characterIds.map(buildChar),
        unison_characters: party.unisonCharacterIds.map(buildChar),
        equipments: party.equipmentIds.map(buildEquip),
        abilitySoulIds: party.abilitySoulIds.map(id => id ? [0, id] : [1])
    }
}

async function handleHandshake(socket: net.Socket, data: string, remoteAddr: string): Promise<SessionClient> {
    console.log(`[SESSION] handshake from ${remoteAddr}:`, data);

    let handshake: any;
    try { handshake = JSON.parse(data); } catch {
        throw new Error("Invalid handshake JSON");
    }

    // Battle socklet: accept and handle basic messages (no viewerId needed)
    if (handshake.socklet === "cooperation_battle") {
        const battleRoomNumber = handshake.roomNumber
        const connectionId = handshake.connectionId
        console.log(`[SESSION] battle handshake: room=${battleRoomNumber} cid=${connectionId}`)
        if (!battleRoomNumber) throw new Error("Missing roomNumber for battle handshake")

        // Accept battle connection with minimal client
        const battleClient: SessionClient = {
            socket,
            viewerId: 0,
            roomNumber: String(battleRoomNumber),
            isReady: false,
            buffer: "",
            mates: [],
            enterData: null,
            playerId: null,
            isBattle: true
        }
        addClient(battleClient)
        sendJson(socket, [0, battleRoomNumber, ""])
        return battleClient
    }

    const viewerId = handshake.viewerId;
    const roomNumber = handshake.roomNumber;
    if (!viewerId || !roomNumber) throw new Error("Missing viewerId or roomNumber");

    // Look up player data from DB
    let playerName = `Player${viewerId}`;
    let playerRank = 1;
    let playerDegreeId = 1;
    let playerRoleKind = 1;
    let playerIsNewbie = false;
    let playerPartySlot = 1;
    let actualPlayerId: number | null = null;

    try {
        const session = await getSession(String(viewerId));
        if (session) {
            const playerIds = await getAccountPlayers(session.accountId);
            if (playerIds && playerIds.length > 0 && !isNaN(playerIds[0])) {
                const player = getPlayerSync(playerIds[0]);
                if (player) {
                    playerName = player.name || playerName;
					playerRank = getRankLevel(player.rankPoint || 0);
                    playerDegreeId = player.degreeId || playerDegreeId;
                    playerRoleKind = player.role || playerRoleKind;
                    playerIsNewbie = !!player.tutorialStep;
                    playerPartySlot = player.partySlot || 1;
                    actualPlayerId = playerIds[0];
                }
            }
        }
    } catch (e) {
        console.log(`[SESSION] failed to read player data for viewer=${viewerId}:`, (e as Error).message);
    }

    const client: SessionClient = {
        socket,
        viewerId: Number(viewerId),
        roomNumber: String(roomNumber),
        isReady: false,
        buffer: "",
        mates: [],
        enterData: null,
        playerId: actualPlayerId,
        isBattle: false
    };

    addClient(client);
    console.log(`[SESSION] client added: viewer=${viewerId} room=${roomNumber} (room total=${roomClients.get(roomNumber)?.size ?? 0})`);

    const hostConnectionId = `${roomNumber}-host`;

    // Send Accept (roomId, roomNumber) — client uses params[0] as myConnectionId
    console.log(`[SESSION] handshake OK viewer=${viewerId} room=${roomNumber} name=${playerName}`)
    sendJson(socket, [0, hostConnectionId, roomNumber]);

    // Build host party from real DB data (use room host_party_id from create_room, fallback to DB playerPartySlot)
    // party_id is a global PartyId: (groupIndex * 10 + slot), where groupIndex is 0-based
    let hostParty = buildDefaultParty()
    const rawPartyId = getRoom(roomNumber)?.host_party_id ?? playerPartySlot
    const groupIndex = Math.floor((rawPartyId - 1) / 10)
    const slot = ((rawPartyId - 1) % 10) + 1
    console.log(`[SESSION] host party: player=${actualPlayerId} partyId=${rawPartyId} groupIdx=${groupIndex} slot=${slot}`)
    if (actualPlayerId) {
        try {
            const partyGroups = getPlayerPartyGroupListSync(actualPlayerId, PartyCategory.NORMAL)
            const group = partyGroups[groupIndex + 1] ?? partyGroups[Object.keys(partyGroups)[0]]
            if (group) {
                const party = group.list[slot] ?? group.list[Object.keys(group.list)[0]]
                if (party) {
                    hostParty = buildRealParty(actualPlayerId, party)
                    console.log(`[SESSION] host party: loaded group=${groupIndex+1} slot=${slot} chars=${party.characterIds.filter(Boolean).length}`)
                } else {
                    console.log(`[SESSION] host party: NO party found for group=${groupIndex+1} slot=${slot}`)
                }
            }
        } catch (e) {
            console.log(`[SESSION] failed to read party for player=${actualPlayerId}:`, (e as Error).message)
        }
    }
    console.log(`[SESSION] host party chars: ${JSON.stringify(hostParty.characters.map((c: any) => c[0] === 0 ? c[1].id : 'none'))}`)

    // Build yourself from real DB data
    const yourself = {
        viewerId: Number(viewerId),
        name: playerName,
        playerRoleKind,
        rank: playerRank,
        degreeId: playerDegreeId,
        party: hostParty,
        connectionId: hostConnectionId,
        autoplayMode: false,
        autoskillMode: 1,
        autoSpeedLevel: 1,
        autoStart: false,
        skillAbilityBehaviorMode: 1,
        dashBehaviorMode: 1,
        allowHealFromOtherPlayers: true,
        state: [0],
        entryTime: Date.now(),
        isNewbie: playerIsNewbie,
        isHost: true,
        currentPartyId: playerPartySlot
    };

    // Welcome(self, [self]) — room with host only (avoids C15202)
    setTimeout(() => sendJson(socket, [1, [0, yourself, [yourself]]]), 100);
    setTimeout(() => sendJson(socket, [1, [1, [yourself]]]), 200);

    client.mates = [yourself]; // for future StartBattle

    return client;
}

export { SESSION_PORT, SESSION_HOST };
