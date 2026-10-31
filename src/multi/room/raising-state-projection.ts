// 客户端 raising_state 投影的唯一决策表（切片 1 第②步：投影统一）。
// 此前同一套"该给客户端看几"的规则散在四处（lobby-projection / select_room /
// prepare / restore_room），各自手写 override 链；本模块把它们合并为一个
// 带上下文的纯函数。约定：
// - 输入 state 是权威值（本节点 room.raising_state、异节点注册值或远端
//   RoomStatus.raisingState；持久值只含 1/2/4，其他值原样透传，不在此产出）。
// - hostOnline 的来源随调用方：列表用本节点 TCP socket 存活判定，HTTP 三流
//   用 RoomStatus.hostOnline——投影函数不关心来源，只消费布尔。
// - 异节点列表行（本节点无 room 对象）信任注册值，由调用方短路，不进本函数；
//   hub 模式下 HTTP 三流的远端 RoomStatus 会进入本函数（远端已做权威投影）。
// - restore 的非成员→13 门（13=NotMate，客户端渲染为 resume_dismissed——
//   客户端官方设计，2026-10-31 反编译钉死：RestoreRoomService.remoteInput
//   case 1/2 → "multibattle_room_resume_dismissed"）保留在调用侧：它的响应
//   形状特殊（port=0/ip 空），不是一次 state 投影。
// - prepare 的战斗/结算期非成员 → 4507 Failure（不可回 4：prepare 远端的
//   链式 select 解析器对 4 抛 C5001，mac-c 实测）经 prepareFailure4507 标志
//   由调用方执行，本函数不构造响应；该场景下 raisingState 值无意义，
//   调用方必须先查标志（唯一调用方 room.ts 已如此）。
//
// 分支顺序即旧四链的字面顺序（双审 P1 修复的依据，不可调换）：
//   select/prepare/list：房主 → state4 → 房主离线 → 透传
//   restore：            房主 → 房主离线 → state4 透传 → 透传
// （restore 的离线覆盖先于 state4 透传：战斗期房主房间 socket 本就切到
//   battle socket，hostOnline=false 是常态——成员 restore 在离线时拿 2 轮询
//   而不是 4，与 4d050291 旧链逐组合等价。）

export type RaisingStateProjectionFlow = "list" | "select" | "prepare" | "restore"

export interface RaisingStateProjectionInput {
    /** 权威 raising_state（1/2/4；其他值透传，不在此产出） */
    readonly state: number
    /** 该 viewer 是否房主 */
    readonly isHost: boolean
    /** 非房主时：是否成员（state 4 的服务矩阵语义，members 表判定） */
    readonly isMember: boolean
    /** 房主在线与否（来源随调用方：本节点 socket 判定或 RoomStatus 字段） */
    readonly hostOnline: boolean
    /** 投影目的流：list 无 viewer 上下文（isHost=false、isMember=false） */
    readonly flow: RaisingStateProjectionFlow
}

export interface RaisingStateProjection {
    readonly raisingState: number
    /** 仅 prepare 消费：战斗/结算期非成员 → A-error 4507 Failure 弹窗；
     *  置位时 raisingState 无意义，调用方必须先查本标志。 */
    readonly prepareFailure4507: boolean
}

export function projectRaisingStateForViewer(
    input: RaisingStateProjectionInput,
): RaisingStateProjection {
    // 房主：4（战斗/结算未返回）→ 2 等待横幅（客户端 3s×5 重试，等 4→1）；
    // 其余 → 1。4→1 只在最后一个 finish 后（R-6），房主不透传 4。
    if (input.isHost) {
        return Object.freeze({
            raisingState: input.state === 4 ? 2 : 1,
            prepareFailure4507: false,
        })
    }
    // restore 的离线覆盖先于 state4 透传（旧链字面顺序，见头部说明）。
    if (input.flow === "restore" && !input.hostOnline) {
        return Object.freeze({ raisingState: 2, prepareFailure4507: false })
    }
    if (input.state === 4) {
        if (input.isMember) {
            // restore 成员透传 4：旧链行为（客户端 case 4 →
            // "multibattle_room_already_started" 终态弹窗——反编译钉死，
            // 不是重进战斗的通道；仅 case 0 走 EnterCooprationRoom(Resume)）。
            if (input.flow === "restore") {
                return Object.freeze({ raisingState: 4, prepareFailure4507: false })
            }
            return Object.freeze({ raisingState: 2, prepareFailure4507: false })
        }
        // 局外人：select/列表 → 4 已开战弹窗（立即明确）；prepare → 4507。
        return Object.freeze({
            raisingState: 4,
            prepareFailure4507: input.flow === "prepare",
        })
    }
    // 房主离线且未开战：2（招募中展示），客户端轮询有内建重试。
    if (!input.hostOnline) {
        return Object.freeze({ raisingState: 2, prepareFailure4507: false })
    }
    return Object.freeze({ raisingState: input.state, prepareFailure4507: false })
}
