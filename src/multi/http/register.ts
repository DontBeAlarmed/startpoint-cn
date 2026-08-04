import { FastifyInstance } from "fastify"
import { registerLobbyRoutes } from "./lobby"
import { registerRoomRoutes } from "./room"
import { registerBattleRoutes } from "./battle"
import { registerSocialRoutes } from "./social"
import type { MultiHttpContext } from "./context"

export interface MultiBattleRouteOptions {
    readonly context: MultiHttpContext
}

export async function multiBattleRoutes(
    fastify: FastifyInstance,
    options: MultiBattleRouteOptions,
): Promise<void> {
    registerLobbyRoutes(fastify, options.context)
    registerRoomRoutes(fastify, options.context)
    registerBattleRoutes(fastify, options.context)
    registerSocialRoutes(fastify, options.context)
}
