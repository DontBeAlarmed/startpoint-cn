const roomStates = new Map<string, object>();

const sessionManager = {
    removeRoomState(roomNumber: string): void {
        roomStates.delete(roomNumber);
    },
};

export default sessionManager;
