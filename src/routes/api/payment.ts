// Handles payment (IAP) endpoints.
// Private server: accepts any valid request, no real payment validation.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders, getServerTime } from "../../utils";
import { getConfigSync } from "../../lib/assets";
import { setPlayerPassCardPurchasedSync } from "../../data/domains/pass-card";
import { getActivePassCardEventDefinitionAt } from "../../lib/pass-card";
import paymentProducts from "../../../assets/payment_products.json";

interface PaymentProduct {
    store_product_id: string
    charge_vmoney_num: number
    free_vmoney_num: number
    start_time: number
    end_time: number
    age_limit: boolean
    monthly_alert: boolean
}

const PRODUCTS: Record<string, PaymentProduct> = paymentProducts as Record<string, PaymentProduct>

// In-memory purchase tracking (resets on server restart)
const purchaseHistory: Record<string, number> = {}
const pendingProducts: Record<string, string> = {}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/item_list", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { api_count: number, viewer_id: number }
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(session.accountId)
        const purchaseKey = playerId === null || playerId === undefined
            ? null
            : `${playerId}_com.leiting.wf.pass_card`
        const purchasedTimes = purchaseKey === null
            ? 0
            : (purchaseHistory[purchaseKey] ?? 0)

        const now = new Date(getServerTime() * 1000)
        const activePass = getActivePassCardEventDefinitionAt(now)
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "payment_item_list": activePass ? [{
                    "store_product_id": "com.leiting.wf.pass_card",
                    "age_limit": false,
                    "monthly_alert": false,
                    "purchased_times": purchasedTimes,
                    "start_time": activePass.startTime / 1000,
                    "end_time": activePass.endTime / 1000,
                }] : [],
                "refund_penalty_status": null
            }
        })
    })

    fastify.post("/start", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            viewer_id: number
            api_count: number
            payment?: { product_id: string }
        }
        const viewerId = body.viewer_id
        // Leiting SDK wraps product_id in nested payment object
        const productId = body.payment?.product_id || (body as any).product_id

        if (!viewerId || isNaN(viewerId) || !productId) {
            console.warn(`[PAYMENT-START] invalid request, body: ${JSON.stringify(body)}`)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": {}
            })
        }

        const session = await getSession(viewerId.toString())
        if (!session) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": {}
            })
        }

        const product = PRODUCTS[productId]
        if (!product) {
            console.warn(`[PAYMENT-START] unknown product: ${productId}`)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": {}
            })
        }

        console.log(`[PAYMENT-START] viewer ${viewerId}, product: ${productId} (paid=${product.charge_vmoney_num} free=${product.free_vmoney_num})`)
        const playerId = resolvePlayerIdSync(session.accountId)
        if (playerId !== null && playerId !== undefined) {
            pendingProducts[String(playerId)] = productId
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        })
    })

    fastify.post("/finish", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            viewer_id: number
            api_count: number
            product_id?: string
            receipt?: string
            signature?: string
            payment?: {
                product_id?: string
                original_receipt?: string
                signature?: string
                currency_code?: string
                price_number?: number
                transaction_id?: string
            }
            deviceInfo?: any
        }
        const viewerId = body.viewer_id
        // Leiting SDK wraps receipt in nested payment object
        const receipt = body.receipt || body.payment?.original_receipt || ""

        if (!viewerId || isNaN(viewerId)) {
            console.warn(`[PAYMENT-FINISH] invalid viewer_id`)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": {}
            })
        }

        const session = await getSession(viewerId.toString())
        if (!session) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": {}
            })
        }

        const playerId = resolvePlayerIdSync(session.accountId)!
        if (!playerId) return reply.status(500).send({ "error": "Internal Server Error", "message": "No player bound to account." })

        const player = getPlayerSync(playerId)
        if (!player) return reply.status(500).send({ "error": "Internal Server Error", "message": "Player not found." })

        // Determine product_id from pending payment
        const pendingProductKey = String(playerId)
        const productId = body.product_id
            || body.payment?.product_id
            || pendingProducts[pendingProductKey]
            || ""
        delete pendingProducts[pendingProductKey]
        const product = PRODUCTS[productId]
        if (!product) {
            console.warn(`[PAYMENT-FINISH] unknown product: ${productId}, receipt: ${receipt}`)
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId }),
                "data": {}
            })
        }

        const paidVmoney = Math.max(0, isFinite(product.charge_vmoney_num) ? product.charge_vmoney_num : 0)
        const freeVmoney = Math.max(0, isFinite(product.free_vmoney_num) ? product.free_vmoney_num : 0)

        if (paidVmoney === 0 && freeVmoney === 0) {
            console.warn(`[PAYMENT-FINISH] product ${productId} has zero vmoney`)
        }

        const config = getConfigSync()
        const maxVmoney = config.max_virtual_money
        const afterPaid = Math.min(player.vmoney + paidVmoney, maxVmoney)
        const afterFree = Math.min(player.freeVmoney + freeVmoney, maxVmoney)

        updatePlayerSync({
            id: playerId,
            vmoney: afterPaid,
            freeVmoney: afterFree
        })

        if (productId === "com.leiting.wf.pass_card") {
            const activeEvent = getActivePassCardEventDefinitionAt(new Date(getServerTime() * 1000))
            if (activeEvent) setPlayerPassCardPurchasedSync(playerId, activeEvent.eventId)
        }

        // Track purchase count per player+product
        const purchaseKey = `${playerId}_${productId}`
        const times = (purchaseHistory[purchaseKey] ?? 0) + 1
        purchaseHistory[purchaseKey] = times

        console.log(`[PAYMENT-FINISH] player ${playerId}: paid ${player.vmoney}->${afterPaid} (+${paidVmoney}), free ${player.freeVmoney}->${afterFree} (+${freeVmoney}), product: ${productId}, times: ${times}`)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "after_vmoney": afterPaid,
                "after_free_vmoney": afterFree,
                "first_payment": times === 1,
                "first_time": times === 1,
                "purchased_times_list": { [productId]: times },
                "monthly_payment_total": 0,
                "monthly_charge_bonus_info": null,
                "premium_bonus_list": null
            }
        })
    })

    // Leiting SDK: report purchase result from native SDK callback
    fastify.post("/report_purchase_result", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            viewer_id: number
            api_count: number
            order_id: string
            status: string
            result_code: string
            result_msg: string
        }
        console.log(`[PAYMENT-REPORT] order=${body.order_id} status=${body.status}`)
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: body.viewer_id }),
            "data": {}
        })
    })
}

export default routes
