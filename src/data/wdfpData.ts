import { randomBytes } from "crypto";
import getDatabase, { Database } from ".";
import { generateViewerId, getServerTime } from "../utils";
import { DailyChallengePointListCampaign, DailyChallengePointListEntry, MergedPlayerData, PartyCategory, Player, PlayerActiveMission, PlayerBoxGacha, PlayerBoxGachaDrawnReward, PlayerCharacter, PlayerCharacterBondToken, PlayerCharacterExBoost, PlayerDrawnQuest, PlayerEquipment, PlayerGachaCampaign, PlayerGachaInfo, PlayerMultiSpecialExchangeCampaign, PlayerParty, PlayerPartyGroup, PlayerPeriodicRewardPoint, PlayerQuestProgress, PlayerRushEvent, PlayerRushEventClearedFolders, PlayerRushEventPlayedParty, PlayerStartDashExchangeCampaign, Account, RawDailyChallengePointListCampaign, RawDailyChallengePointListEntry, RawPlayer, RawPlayerActiveMission, RawPlayerActiveMissionStage, RawPlayerBoxGacha, RawPlayerCharacter, RawPlayerCharacterBondToken, RawPlayerCharacterManaNode, RawPlayerClearedRegularMission, RawPlayerDrawnQuest, RawPlayerEquipment, RawPlayerGachaCampaign, RawPlayerGachaInfo, RawPlayerItem, RawPlayerMultiSpecialExchangeCampaign, RawPlayerOption, RawPlayerParty, RawPlayerPartyGroup, RawPlayerQuestProgress, RawPlayerRushEvent, RawPlayerRushEventClearedFolder, RawPlayerRushEventPlayedParty, RawPlayerRushEventRanking, RawPlayerStartDashExchangeCampaign, RawPlayerTriggeredTutorial, RawSession, RushEventBattleType, GetRushEventEndlessRankingListResult, Session, SessionType, UserRushEventEndlessBattleRanking, UserRushEventPlayedParty } from "./types";
import { deserializeBoolean, deserializeNumberList, getDefaultPlayerData, serializeBoolean, serializeNumberList } from "./utils";
import { getPlayerRushEventEndlessBattleRankingSync } from "../lib/rush";

// Re-exports from domain modules
export { getAccountFromIdpIdSync, getAccount, getAllAccountsSync, deleteAccountSync, getAccountPlayersSync, getAccountPlayers, insertAccount, updateAccountSync, updateAccount } from "./domains/account";
import { getAccountSync } from "./domains/account";
// Session + DeviceBinding
export { getSession, getViewerIdSync, getDeviceBindingSync, insertDeviceBindingSync, deleteDeviceBindingSync, getAccountSessionsOfType, insertSessionWithToken, insertSession, deleteSession, deleteAccountSessions, deleteAccountSessionsOfType, generateViewerIdSession } from "./domains/session";
// DCPL + Player CRUD
export { getPlayerSync, getAllPlayersSync, insertPlayerSync, insertMergedPlayerDataSync, insertDefaultPlayerSync, updatePlayerSync, replacePlayerDataSync, deletePlayerSync, collectPlayerDataPooledExpSync, collectPlayerPooledExpSync, dailyResetPlayerDataSync, dailyResetPlayerSync, getPlayerDailyChallengePointListSync, insertPlayerDailyChallengePointListSync, updatePlayerDailyChallengePointSync, getDefaultPlayerPartyGroupsSync, getPlayerFromAccountIdSync, getAccountFromPlayerIdSync } from "./domains/player";
import { insertDefaultPlayerSync, insertPlayerDailyChallengePointListSync } from "./domains/player";
export { getPlayerTriggeredTutorialsSync, insertPlayerTriggeredTutorialSync, insertPlayerTriggeredTutorialsSync } from "./domains/tutorial";
import { insertPlayerTriggeredTutorialsSync } from "./domains/tutorial";
export { insertPlayerOptionSync, insertPlayerOptionsSync, getPlayerOptionsSync, updatePlayerOptionSync, updatePlayerOptionsSync } from "./domains/option";
import { insertPlayerOptionsSync } from "./domains/option";
export { getPlayerItemSync, getPlayerItemsSync, insertPlayerItemsSync, updatePlayerItemSync, givePlayerItemSync } from "./domains/item";
import { insertPlayerItemsSync } from "./domains/item";
export { getPlayerPeriodicRewardPointsSync, insertPlayerPeriodicRewardPointsListSync, getPlayerStartDashExchangeCampaignsSync, insertPlayerStartDashExchangeCampaignsSync, getPlayerMultiSpecialExchangeCampaignsSync, insertPlayerMultiSpecialExchangeCampaignsSync } from "./domains/campaign";
import { insertPlayerPeriodicRewardPointsListSync, insertPlayerStartDashExchangeCampaignsSync, insertPlayerMultiSpecialExchangeCampaignsSync } from "./domains/campaign";
export { getPlayerEquipmentListSync, getPlayerEquipmentSync, playerOwnsEquipmentSync, insertPlayerEquipmentSync, insertPlayerEquipmentListSync, updatePlayerEquipmentSync, deletePlayerEquipmentSync } from "./domains/equipment";
import { insertPlayerEquipmentListSync } from "./domains/equipment";
export { getPlayerPartyGroupListSync, insertPlayerPartyGroupListSync, updatePlayerPartySync, updatePlayerPartyGroupSync } from "./domains/party";
import { insertPlayerPartyGroupListSync } from "./domains/party";
export { playerOwnsCharacterSync, getPlayerCharacterSync, getPlayerCharactersSync, updatePlayerCharacterBondTokenSync, insertPlayerCharacterBondTokenSync, insertPlayerCharacterSync, insertDefaultPlayerCharacterSync, updatePlayerCharacterSync, getPlayerCharactersManaNodesSync, getPlayerCharacterManaNodesSync, hasPlayerUnlockedCharacterManaNodeSync, insertPlayerCharacterManaNodesSync, insertPlayerCharactersSync, insertPlayerCharactersManaNodesSync } from "./domains/character";
import { insertPlayerCharactersSync, insertPlayerCharactersManaNodesSync } from "./domains/character";
export { getPlayerQuestProgressSync, getPlayerSingleQuestProgressSync, insertPlayerQuestProgressSync, insertPlayerQuestProgressListSync, updatePlayerQuestProgressSync, getPlayerDrawnQuestsSync, insertPlayerDrawnQuestsSync } from "./domains/quest";
import { insertPlayerDrawnQuestsSync, insertPlayerQuestProgressListSync } from "./domains/quest";
export { getPlayerShopPurchasesSync, getPlayerShopPurchasesMapSync, getPlayerShopPurchaseCountSync, addPlayerShopPurchaseSync } from "./domains/shopPurchase";
export { getPlayerCarnivalEventRecordsSync, getPlayerCarnivalEventRecordSync, upsertPlayerCarnivalEventRecordSync } from "./domains/carnivalEvent";
export { getPlayerGachaInfoListSync, getPlayerGachaInfoSync, insertPlayerGachaInfoSync, insertPlayerGachaInfoListSync, updatePlayerGachaInfoSync, getPlayerGachaCampaignSync, getPlayerGachaCampaignListSync, insertPlayerGachaCampaignSync, insertPlayerGachaCampaignListSync, updatePlayerGachaCampaignSync } from "./domains/gacha";
import { insertPlayerGachaInfoListSync, insertPlayerGachaCampaignListSync } from "./domains/gacha";
import { getPlayerGachaInfoListSync, updatePlayerGachaInfoSync, getPlayerGachaCampaignListSync, updatePlayerGachaCampaignSync } from "./domains/gacha";
export { getPlayerClearedRegularMissionListSync, insertPlayerClearedRegularMissionListSync, getPlayerActiveMissionsSync, insertPlayerActiveMissionsSync, updatePlayerActiveMissionSync, updatePlayerActiveMissionStageSync } from "./domains/mission";
export { getPlayerCharacterClearSync, incrementPlayerCharacterClearSync } from "./domains/character_clear";
import { insertPlayerClearedRegularMissionListSync, insertPlayerActiveMissionsSync } from "./domains/mission";
export { getPlayerBoxGachaSync, getPlayerBoxGachasSync, insertPlayerBoxGachaSync, insertPlayerBoxGachasSync, updatePlayerBoxGachaSync, getPlayerBoxGachaDrawnRewardsSync, insertPlayerBoxGachaDrawnRewardSync, updatePlayerBoxGachaDrawnRewardSync } from "./domains/boxGacha";
import { insertPlayerBoxGachasSync } from "./domains/boxGacha";
export { MailType, insertMailSync, getPlayerMailsSync, getPlayerMailCountSync, receiveMailSync, receiveAllMailsSync, deleteAllPlayerMailSync, insertReceiveHistorySync, getReceiveHistorySync } from "./domains/mail";
export type { RawPlayerMail, MailAttachment, RawReceiveHistory } from "./domains/mail";
// Rush event re-exports
export { deserializeRushEvent, getDefaultPlayerRushEventSync, getPlayerRushEventSync, getPlayerRushEventListSync, getRushEventEndlessRankingListSync, getPlayerIdFromRushEventEndlessRankSync, insertPlayerRushEventSync, insertPlayerRushEventListSync, updatePlayerRushEventSync, getPlayerRushEventClearedFoldersSync, getPlayerRushEventListClearedFoldersSync, insertPlayerRushEventClearedFolderSync, insertPlayerRushEventClearedFolderListSync, getPlayerRushEventPlayedPartiesSync, getPlayerRushEventListPlayedPartiesSync, getPlayerRushEventNextEndlessBattleRoundSync, insertPlayerRushEventPlayedPartySync, insertPlayerRushEventPlayedPartyListSync, deletePlayerRushEventPlayedPartyListSync, deletePlayerRushEventPlayedPartySync, deletePlayerRushEventPlayedPartiesUntilSync, updatePlayerRushEventPlayedPartySync, deserializePlayerRushEventPlayedParty, serializePlayerRushEventPlayedParty } from "./domains/rushEvent";
import { insertPlayerRushEventListSync, insertPlayerRushEventClearedFolderListSync, insertPlayerRushEventPlayedPartyListSync } from "./domains/rushEvent";
// Active quest (unfinished battle recovery)
export { getPlayerActiveQuestSync, insertPlayerActiveQuestSync, deletePlayerActiveQuestSync, updatePlayerActiveQuestContinueCountSync } from "./domains/quest_active";

const db = getDatabase(Database.WDFP_DATA)

export function getDb() { return db; }
const expPoolMax = 100000 // the maximum amount of exp that can be pooled
