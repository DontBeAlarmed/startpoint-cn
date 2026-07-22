// Barrel entry for multi battle / co-op system
// Re-exports for backward compatibility with cn-server.ts

export { multiBattleRoutes } from "./http/register"
export {
    getSessionServerStatus,
    isSessionServerListening,
    startSessionServer,
    stopSessionServer,
} from "./tcp/server"
export { sessionManager } from "./state/SessionManager"

// Compatibility shims — mirror the old exports that other files depend on
import { sessionManager } from "./state/SessionManager"

export function hasRoomClients(roomNumber: string): boolean {
    return sessionManager.hasRoomClients(roomNumber)
}

export function isHostOnline(hostViewerId: number, roomNumber: string): boolean {
    return sessionManager.isHostOnline(hostViewerId, roomNumber)
}

export function clearBattleExpectedCount(roomNumber: string): void {
    sessionManager.clearBattleExpectedCount(roomNumber)
}
