import Fastify, { type FastifyInstance } from "fastify"
import type { RuntimeNetworkServiceConfig } from "../../runtime/config"

import {
    registerMultiHubControlRoutes,
    type MultiHubControlRoutesOptions,
} from "./control-routes"

export const MULTI_HUB_CONTROL_BODY_LIMIT = 256 * 1024

export function buildMultiHubControlApp(
    options: MultiHubControlRoutesOptions,
): FastifyInstance {
    const app = Fastify({
        bodyLimit: MULTI_HUB_CONTROL_BODY_LIMIT,
        logger: false,
    })
    registerMultiHubControlRoutes(app, options)
    app.setNotFoundHandler((_request, reply) => reply.status(404).send({
        ok: false,
        code: "NOT_FOUND",
    }))
    app.setErrorHandler((_error, _request, reply) => reply.status(400).send({
        ok: false,
        code: "INVALID_REQUEST",
    }))
    return app
}

export class MultiHubControlServer {
    private app: FastifyInstance | null = null

    isListening = (): boolean => this.app?.server.listening === true

    async start(
        config: RuntimeNetworkServiceConfig,
        routes: MultiHubControlRoutesOptions,
        onFatalError: (error: unknown) => void,
    ): Promise<void> {
        if (this.app !== null) throw new Error("Hub control server already started")
        const app = buildMultiHubControlApp(routes)
        this.app = app
        try {
            await app.listen({ host: config.host, port: config.port })
        } catch (error) {
            this.app = null
            await app.close().catch(() => {})
            throw error
        }
        app.server.on("error", onFatalError)
    }

    async stop(): Promise<void> {
        const app = this.app
        if (app === null) return
        await app.close()
        if (this.app === app) this.app = null
    }
}
