import { releaseAbandonedMultiActiveQuest } from "../../lib/quest/active-quest-service"
import { closeRecruitmentForRoom } from "../../data/domains/attention"
import { describeError } from "../describe-error"
import { sessionManager } from "../state/SessionManager"
import { identityOf, lifecycleRegistry } from "../lifecycle"
import { isEffectSwitched } from "../lifecycle/effect-executor"
import { applyEffects } from "../lifecycle/apply-effects"
import { setLifecycleEffectApplier } from "../lifecycle/room-lifecycle-registry"
import { setRoomDisbandListener } from "./manager"

/**
 * Every disband path funnels through manager.disbandRoom, which now owns the
 * client dismissal (dismiss-only) and socket teardown. This listener keeps
 * only persistence cleanup, so there is no second dismissal path.
 */
export function installDisbandLifecycleListener(): void {
    // 切片 1 第③步：效果执行器接线（注入式——registry 不静态 import DB 层）
    setLifecycleEffectApplier(applyEffects)
    // dismissed socket 关闭 → 内核 closeConfirmed；全部确认或到期后 closed。
    sessionManager.onDismissedSocketClosed = (roomNumber, viewerId, lifecycleGeneration) => {
        const decision = lifecycleRegistry.dispatch(roomNumber, generation => ({
            type: "closeConfirmed",
            generation,
            identity: identityOf({ viewerId }),
        }), lifecycleGeneration)
        if (decision?.state.phase === "closed") lifecycleRegistry.remove(roomNumber)
    }
    setRoomDisbandListener((roomNumber, hostPlayerId, hostViewerId) => {
        // 拆除已在 manager.disbandRoom 完成（dismiss-only）；这里只做持久层清理。
        try {
            releaseAbandonedMultiActiveQuest(hostPlayerId, roomNumber)
        } catch (error) {
            console.error(`[MULTI] abandoned host release failed: room=${roomNumber}: ${describeError(error)}`)
        }
        try {
            // 好友房间大厅注册行清理（覆盖 timer 等全部解散路径）
            const { deleteRoomShareRowForDisband } = require("./share-sync") as typeof import("./share-sync")
            deleteRoomShareRowForDisband(roomNumber)
        } catch (error) {
            console.error(`[MULTI] room share disband cleanup failed: room=${roomNumber}: ${describeError(error)}`)
        }
        // W1a：closeRecruitmentForRoom 为异步形状——同步 listener 内
        // fire-and-forget（拒绝就地捕获，不得成为 unhandled rejection）。
        // 切片 1 第③步：开关启用后由执行器消费内核 disband 的
        // closeRecruitment effect，此处停用（回退=摘掉 MULTI_EFFECT_SWITCHES）。
        if (!isEffectSwitched("closeRecruitment")) {
            void closeRecruitmentForRoom(hostViewerId, roomNumber).catch(error => {
                console.error(`[MULTI] recruitment disband cleanup failed: room=${roomNumber}: ${describeError(error)}`)
            })
        }
    })
}
