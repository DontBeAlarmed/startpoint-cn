// Active mission reward claiming endpoint
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerActiveMissionsSync, updatePlayerActiveMissionStageSync } from "../../data/domains/mission"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { givePlayerItemSync } from "../../data/domains/item"
import { insertDefaultPlayerCharacterSync } from "../../data/domains/character"
import { generateDataHeaders, getServerTime } from "../../utils";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getActiveMissionRewards, getAwakeMissionRewards } from "../../lib/mission/index";

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/receive", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            viewer_id: number,
            api_count: number,
            active_mission_list: { mission_id: number, stages: number[] }[]
        }

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        const player = getPlayerSync(playerId)
        if (!player) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "Player not found."
        })

        const activeMissions = getPlayerActiveMissionsSync(playerId)
        const resultList: any[] = []
        const itemRewards: Record<number, number> = {}
        let freeMana = player.freeMana
        let expPool = player.expPool
        let totalManaGained = 0

        const requestList = body.active_mission_list || []

        for (const entry of requestList) {
            const missionId = entry.mission_id
            const stages = entry.stages || []
            const currentMission = activeMissions[String(missionId)]
            const progress = currentMission?.progress ?? 0
            const responseStages: any[] = []

            for (const stage of stages) {
                // Skip if already received (prevent duplicate rewards)
                const existingStages = currentMission?.stages
                if (existingStages && !Array.isArray(existingStages) && (existingStages as Record<string, boolean>)[String(stage)]) continue

                // Mark stage as received
                updatePlayerActiveMissionStageSync(playerId, stage, missionId, true)

                // Get rewards from CDN — awake missions use a different reward table
                const isAwake = String(missionId).length >= 7 && missionId % 10 <= 4
                const rewards = isAwake
                    ? getAwakeMissionRewards(missionId, stage)
                    : getActiveMissionRewards(missionId, stage)
                for (const r of rewards) {
                    switch (r.kind) {
                        case 1: // Item
                            if (r.itemId) {
                                const newTotal = givePlayerItemSync(playerId, r.itemId, r.amount)
                                itemRewards[r.itemId] = newTotal
                            }
                            break
                        case 2: // Equipment
                            if (r.equipmentId) {
                                const newTotal = givePlayerItemSync(playerId, r.equipmentId, r.amount)
                                itemRewards[r.equipmentId] = newTotal
                            }
                            break
                        case 3: // Mana
                            freeMana += r.amount
                            totalManaGained += r.amount
                            break
                        case 4: // Character
                            if (r.characterId && r.amount > 0) {
                                try {
                                    insertDefaultPlayerCharacterSync(playerId, r.characterId)
                                } catch (_) {
                                    // Character may already exist — ignore duplicate
                                }
                            }
                            break
                        case 5: // Exp pool
                            expPool += r.amount
                            break
                    }
                }

                responseStages.push({ stage, received: true })
            }

            resultList.push({
                mission_id: missionId,
                progress_value: progress,
                stages: responseStages
            })
        }

        // Apply mana and exp changes
        if (freeMana !== player.freeMana || expPool !== player.expPool) {
            updatePlayerSync({ id: playerId, freeMana, expPool, totalManaObtained: (player.totalManaObtained ?? 0) + totalManaGained })
        }

        console.log(`[ACTIVE_MISSION] receive viewer=${viewerId} missions=${requestList.length} items=${Object.keys(itemRewards).length}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "active_mission_list": resultList,
                "user_info": {
                    "free_mana": freeMana,
                    "exp_pool": expPool,
                    "exp_pooled_time": getServerTime(player.expPooledTime)
                },
                "item_list": itemRewards,
                "mail_arrived": false
            }
        })
    })
}

export default routes;
