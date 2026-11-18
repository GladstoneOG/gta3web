#include "common.h"
#ifdef MULTIPLAYER_COOP

#include "mp_core.h"
#include "World.h"
#include "Pools.h"
#include "PlayerPed.h"
#include "PlayerInfo.h"
#include "Vehicle.h"
#include "Automobile.h"
#include "Streaming.h"
#include "ModelInfo.h"
#include "ModelIndices.h"
#include "Ped.h"
#include "Pad.h"
#include "Timer.h"
#include "Frontend.h"
#include "Sprite.h"
#include "Sprite2d.h"
#include "Font.h"
#include "Text.h"
#include "Hud.h"
#include "Messages.h"
#include "Camera.h"
#include "Wanted.h"
#include "Clock.h"
#include "Weather.h"
#include "Zones.h"
#include "CutsceneMgr.h"
#include "Script.h"
#include "DMAudio.h"
#include "MusicManager.h"
#include "Darkel.h"
#include "Radar.h"
#include "GenericGameStorage.h"
#include "PCSave.h"
#include "FileMgr.h"
#include "ControllerConfig.h"
#include "main.h"
#include "crossplatform.h"

const char *_psGetUserFilesFolder();

#ifdef __EMSCRIPTEN__
#include <GLFW/glfw3.h>
extern "C" void EmscriptenRequestRestart(bool wantToLoad);
#endif

CMPManager gMP;

CMPManager::CMPManager()
{
	active = false;
	isHost = false;
	localPeerId = 1;
	strcpy(localName, "Claude");
	localPreferredModel = MI_PLAYER;
	openIslands = false;
	uiPauseBlock = false;
	nextNetId = 100;
	lastStateTxMs = 0;
	lastVehTxMs = 0;
	lastPedTxMs = 0;
	lastWorldTxMs = 0;
	lastMissionTxMs = 0;
	spawnFocusIdx = 0;
	lastPagerMsg[0] = '\0';
	outHead = 0;
	outTail = 0;
	suppressLocalHooks = false;
	memset(peers, 0, sizeof(peers));
	memset(vehMap, 0, sizeof(vehMap));
	memset(pedMap, 0, sizeof(pedMap));
	for (int i = 0; i < MP_MAX_PEERS; i++) {
		peers[i].radarBlipHandle = -1;
		peers[i].seatIdx = -2;
	}
}

void CMPManager::Init(int peerId, bool host)
{
	Shutdown();
	active = true;
	isHost = host;
	localPeerId = (peerId >= 1 && peerId <= MP_MAX_PEERS) ? peerId : 1;
	nextNetId = (uint32)(localPeerId * 100000 + 1);
	outHead = 0;
	outTail = 0;
	SetUiPauseBlock(true);

	// Ensure all 3 island collisions remain loaded so teammates across islands never fall through ground
	CMenuManager::m_PrefsIslandLoading = CMenuManager::ISLAND_LOADING_HIGH;

	// Broadcast identity right away
	uint8 pkt[64];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_PLAYER_IDENTITY);
	w.Write<uint8>((uint8)localPeerId);
	w.Write<int32>(localPreferredModel);
	w.WriteBytes(localName, MP_NAME_LEN);
	if (w.ok)
		QueuePacket(1, 0, pkt, w.pos);
}

void CMPManager::Shutdown()
{
	suppressLocalHooks = true;
	for (int i = 0; i < MP_MAX_PEERS; i++) {
		if (peers[i].radarBlipHandle >= 0) {
			CRadar::ClearBlip(peers[i].radarBlipHandle);
			peers[i].radarBlipHandle = -1;
		}
		if (peers[i].ped) {
			if (peers[i].ped->bInVehicle && peers[i].ped->m_pMyVehicle) {
				if (peers[i].ped->m_pMyVehicle->pDriver == peers[i].ped)
					peers[i].ped->m_pMyVehicle->RemoveDriver();
				else
					peers[i].ped->m_pMyVehicle->RemovePassenger(peers[i].ped);
			}
			CWorld::Remove(peers[i].ped);
			delete peers[i].ped;
			peers[i].ped = nil;
		}
		peers[i].active = false;
	}
	memset(vehMap, 0, sizeof(vehMap));
	memset(pedMap, 0, sizeof(pedMap));
	suppressLocalHooks = false;
	active = false;
	isHost = false;
	outHead = 0;
	outTail = 0;
}

void CMPManager::OnWorldReset()
{
	suppressLocalHooks = true;
	for (int i = 0; i < MP_MAX_PEERS; i++) {
		peers[i].ped = nil;
		peers[i].radarBlipHandle = -1;
		peers[i].vehNetId = 0;
		peers[i].seatIdx = -2;
	}
	memset(vehMap, 0, sizeof(vehMap));
	memset(pedMap, 0, sizeof(pedMap));
	suppressLocalHooks = false;

	CMenuManager::m_PrefsIslandLoading = CMenuManager::ISLAND_LOADING_HIGH;
	if (openIslands)
		SetOpenIslands(1, true);
}

MPRemotePlayer *CMPManager::GetPeerSlot(int peerId)
{
	if (peerId < 1 || peerId > MP_MAX_PEERS)
		return nil;
	return &peers[peerId - 1];
}

void CMPManager::QueuePacket(int channel, int targetPeer, const uint8 *data, int len)
{
	if (!active || !data || len <= 0 || len > MP_MAX_PKT_BYTES)
		return;
	int nextTail = (outTail + 1) % MP_OUTBOX_CAP;
	if (nextTail == outHead) {
		// Drop oldest packet cleanly when ring is full
		outHead = (outHead + 1) % MP_OUTBOX_CAP;
	}
	MPQueuedPacket &q = outbox[outTail];
	q.channel = (uint8)channel;
	q.targetPeer = (uint8)targetPeer;
	q.len = (uint16)len;
	memcpy(q.data, data, (size_t)len);
	outTail = nextTail;
}

int CMPManager::PollPacket(int *outChannel, int *outTargetPeer, uint8 *outBuf, int maxLen)
{
	if (outHead == outTail)
		return 0;
	const MPQueuedPacket &q = outbox[outHead];
	int copyLen = q.len;
	if (copyLen > maxLen)
		copyLen = maxLen;
	if (outChannel) *outChannel = q.channel;
	if (outTargetPeer) *outTargetPeer = q.targetPeer;
	if (outBuf && copyLen > 0)
		memcpy(outBuf, q.data, (size_t)copyLen);
	outHead = (outHead + 1) % MP_OUTBOX_CAP;
	return copyLen;
}

void CMPManager::PushPacket(int fromPeerId, const uint8 *data, int len)
{
	if (!active || !data || len < 1)
		return;
	uint8 pktType = data[0];
	switch (pktType) {
		case PKT_PLAYER_STATE:    HandlePlayerStatePacket(fromPeerId, data, len); break;
		case PKT_PLAYER_IDENTITY: HandlePlayerIdentityPacket(fromPeerId, data, len); break;
		case PKT_VEHICLE_SYNC:    HandleVehicleSyncPacket(fromPeerId, data, len); break;
		case PKT_VEHICLE_ENTER:   HandleVehicleEnterPacket(fromPeerId, data, len); break;
		case PKT_VEHICLE_EXIT:    HandleVehicleExitPacket(fromPeerId, data, len); break;
		case PKT_SHOT_EVENT:      HandleShotEventPacket(fromPeerId, data, len); break;
		case PKT_GARAGE_EVENT:    HandleGarageEventPacket(fromPeerId, data, len); break;
		case PKT_PED_SYNC:        HandlePedSyncPacket(fromPeerId, data, len); break;
		case PKT_WORLD_SYNC:      HandleWorldSyncPacket(fromPeerId, data, len); break;
		case PKT_MISSION_SYNC:    HandleMissionSyncPacket(fromPeerId, data, len); break;
		case PKT_SPAWN_REQ:       HandleSpawnReqPacket(fromPeerId, data, len); break;
		case PKT_RC_EVENT:        HandleRcEventPacket(fromPeerId, data, len); break;
		case PKT_PICKUP_EVENT:    HandlePickupEventPacket(fromPeerId, data, len); break;
		case PKT_CHAT_OR_PAGER: {
			MPBufReader r(data + 1, len - 1);
			uint8 sender = r.Read<uint8>();
			uint8 kind = r.Read<uint8>();
			char msg[128];
			memset(msg, 0, sizeof(msg));
			int rem = len - 1 - r.pos;
			if (rem > 127) rem = 127;
			if (rem > 0) r.ReadBytes(msg, rem);
			if (r.ok) {
				strncpy(lastPagerMsg, msg, sizeof(lastPagerMsg) - 1);
				lastPagerMsg[sizeof(lastPagerMsg) - 1] = '\0';
				if (kind == 1) {
					wchar wmsg[128];
					AsciiToUnicode(lastPagerMsg, wmsg);
					CMessages::AddMessageJumpQ(wmsg, 4500, 0);
				}
				(void)sender;
			}
			break;
		}
		default: break;
	}
}

bool CMPManager::ApplyPedSkin(CPed *ped, int modelIndex, bool preserveAnimGrp)
{
	if (!ped || modelIndex < 0 || modelIndex > MI_LAST_PED)
		return false;
	if (!CModelInfo::GetModelInfo(modelIndex))
		return false;
	if (ped->IsPlayer() && (CCutsceneMgr::HasLoaded() || CCutsceneMgr::IsRunning() || CCutsceneMgr::IsCutsceneProcessing() || !ped->bIsVisible || ped->m_rwObject == nil || (CPad::GetPad(0) && CPad::GetPad(0)->ArePlayerControlsDisabled())))
		return false;
	if (modelIndex == MI_TAXI_D && CModelInfo::GetModelInfo(modelIndex)->GetRwObject() == nil)
		modelIndex = MI_MALE01;
	if (ped->m_modelIndex == modelIndex && ped->m_rwObject != nil)
		return true;

	AssocGroupId prevAnim = ped->m_animGroup;
	bool wasInCar = ped->bInVehicle;
	CVehicle *veh = ped->m_pMyVehicle;

	if (modelIndex >= MI_SPECIAL01 && modelIndex <= MI_SPECIAL04) {
		if (ped->IsPlayer() && CTheScripts::IsPlayerOnAMission())
			return false;
		if (CModelInfo::GetModelInfo(modelIndex)->GetRwObject() == nil) {
			static const char *kSpecialNames[4] = { "eight2", "frankie", "asuka", "maria" };
			CStreaming::RequestSpecialModel(modelIndex, kSpecialNames[modelIndex - MI_SPECIAL01], STREAMFLAGS_DEPENDENCY | STREAMFLAGS_DONT_REMOVE);
		} else {
			CStreaming::RequestModel(modelIndex, STREAMFLAGS_DEPENDENCY | STREAMFLAGS_DONT_REMOVE);
		}
	} else {
		CStreaming::RequestModel(modelIndex, STREAMFLAGS_DEPENDENCY | STREAMFLAGS_DONT_REMOVE);
	}
	CStreaming::LoadAllRequestedModels(false);
	if (CStreaming::ms_aInfoForModel[modelIndex].m_loadState != STREAMSTATE_LOADED || CModelInfo::GetModelInfo(modelIndex)->GetRwObject() == nil)
		return false;

	ped->DeleteRwObject();
	ped->m_modelIndex = -1;
	ped->SetModelIndex((uint32)modelIndex);
	if (preserveAnimGrp || ped->IsPlayer())
		ped->m_animGroup = ASSOCGRP_PLAYER;
	else
		ped->m_animGroup = prevAnim;

	if (wasInCar && veh) {
		ped->m_pVehicleAnim = CAnimManager::BlendAnimation(ped->GetClump(), ASSOCGRP_STD, veh->GetDriverAnim(), 100.0f);
		ped->SetPedPositionInCar();
	} else {
		CAnimManager::BlendAnimation(ped->GetClump(), ped->m_animGroup, ANIM_STD_IDLE, 100.0f);
	}
	return true;
}

void CMPManager::SetPlayerInfo(int peerId, const char *name, int modelIndex)
{
	int clModel = (modelIndex >= 0 && modelIndex <= MI_LAST_PED) ? modelIndex : MI_PLAYER;
	char safeName[MP_NAME_LEN];
	memset(safeName, 0, sizeof(safeName));
	if (name && name[0]) {
		strncpy(safeName, name, MP_NAME_LEN - 1);
	} else {
		snprintf(safeName, MP_NAME_LEN, "Player %d", peerId > 0 ? peerId : 1);
	}

	if (peerId == 0 || (active && peerId == localPeerId)) {
		strcpy(localName, safeName);
		localPreferredModel = clModel;
		if (gGameState == GS_PLAYING_GAME && CPools::GetPedPool() != nil && FindPlayerPed())
			ApplyPedSkin(FindPlayerPed(), clModel, true);
		if (active) {
			uint8 pkt[64];
			MPBufWriter w(pkt, sizeof(pkt));
			w.Write<uint8>(PKT_PLAYER_IDENTITY);
			w.Write<uint8>((uint8)localPeerId);
			w.Write<int32>(localPreferredModel);
			w.WriteBytes(localName, MP_NAME_LEN);
			if (w.ok) QueuePacket(1, 0, pkt, w.pos);
		}
		return;
	}

	MPRemotePlayer *rp = GetPeerSlot(peerId);
	if (rp) {
		rp->active = true;
		rp->peerId = peerId;
		strcpy(rp->name, safeName);
		rp->pendingModelIndex = clModel;
	}
}

void CMPManager::TickBeforeGame()
{
#ifdef __EMSCRIPTEN__
	if (uiPauseBlock)
		CTimer::EndUserPause();
#endif
	if (gGameState == GS_PLAYING_GAME && CTimer::GetFrameCounter() > 60) {
		if (CPlayerPed *ped = FindPlayerPed()) {
			if (localPreferredModel != MI_PLAYER && ped->m_modelIndex != localPreferredModel && ped->bIsVisible && ped->m_rwObject != nil && !CCutsceneMgr::HasLoaded() && !CCutsceneMgr::IsRunning() && !CCutsceneMgr::IsCutsceneProcessing() && CPad::GetPad(0) && !CPad::GetPad(0)->ArePlayerControlsDisabled())
				ApplyPedSkin(ped, localPreferredModel, true);
		}
	}
	// Handle explicit 'G' passenger seat hop key on foot
	if (CPad::GetPad(0) && !CPad::GetPad(0)->ArePlayerControlsDisabled()) {
		CPlayerPed *ped = FindPlayerPed();
		if (ped && !ped->bInVehicle && !uiPauseBlock && CPad::GetPad(0)->GetCharJustDown('G'))
			RequestPassengerEnter();
	}

	if (!active)
		return;

	uint32 nowMs = CTimer::GetTimeInMilliseconds();
	CleanupStaleVehicles();
	CleanupStalePeds();
	TickRemotePlayers(nowMs);
	InterpolateRemoteVehicles(nowMs);
}

void CMPManager::TickAfterGame()
{
	if (!active)
		return;

	uint32 nowMs = CTimer::GetTimeInMilliseconds();
	SendLocalPlayerState(nowMs);
	TickVehiclesAfterGame(nowMs);
	TickPedsAfterGame(nowMs);
	TickWorldAfterGame(nowMs);
}

void CMPManager::RenderNameTags()
{
	if (!active)
		return;
	CVector camPos = TheCamera.GetPosition();
	for (int i = 0; i < MP_MAX_PEERS; i++) {
		MPRemotePlayer &rp = peers[i];
		if (!rp.active || rp.peerId == localPeerId || !rp.ped)
			continue;

		CVector headPos = rp.ped->GetPosition();
		headPos.z += rp.ped->bInVehicle ? 1.45f : 1.15f;
		float dist = (headPos - camPos).Magnitude();
		if (dist > 85.0f || dist < 0.5f)
			continue;

		RwV3d inPos = { headPos.x, headPos.y, headPos.z };
		RwV3d scrPos;
		float w = 0.0f, h = 0.0f;
		if (!CSprite::CalcScreenCoors(inPos, &scrPos, &w, &h, true))
			continue;
		if (scrPos.z <= 0.0f)
			continue;

		float scale = Clamp(1.1f - dist * 0.01f, 0.42f, 0.85f);
		wchar wbuf[64];
		AsciiToUnicode(rp.name[0] ? rp.name : "Player", wbuf);

		CFont::SetPropOn();
		CFont::SetBackgroundOff();
		CFont::SetCentreOn();
		CFont::SetCentreSize(SCREEN_SCALE_X(300));
		CFont::SetFontStyle(FONT_BANK);
		CFont::SetScale(SCREEN_SCALE_X(0.45f * scale), SCREEN_SCALE_Y(0.95f * scale));
		CFont::SetDropShadowPosition(1);
		CFont::SetDropColor(CRGBA(0, 0, 0, 220));

		CRGBA col = (rp.peerId == 1) ? CRGBA(255, 200, 75, 255) :
		            (rp.peerId == 2) ? CRGBA(115, 220, 120, 255) :
		            (rp.peerId == 3) ? CRGBA(100, 195, 255, 255) :
		                               CRGBA(235, 130, 255, 255);
		CFont::SetColor(col);
		CFont::PrintString(scrPos.x, scrPos.y - SCREEN_SCALE_Y(18.0f), wbuf);

		// Compact health bar beneath name tag
		float barW = SCREEN_SCALE_X(46.0f * scale);
		float barH = SCREEN_SCALE_Y(4.0f * scale);
		float bx = scrPos.x - barW * 0.5f;
		float by = scrPos.y - SCREEN_SCALE_Y(3.0f);
		float hpFrac = Clamp((float)rp.health / 100.0f, 0.0f, 1.0f);
		CSprite2d::DrawRect(CRect(bx - 1.0f, by - 1.0f, bx + barW + 1.0f, by + barH + 1.0f), CRGBA(10, 10, 10, 200));
		CSprite2d::DrawRect(CRect(bx, by, bx + barW * hpFrac, by + barH), CRGBA(225, 65, 55, 240));
	}
}

bool CMPManager::IsNearAnyPlayer2D(const CVector &pos, float maxDist) const
{
	if (!active)
		return false;
	float maxSq = maxDist * maxDist;
	CVector localPos = FindPlayerCentreOfWorld(CWorld::PlayerInFocus);
	if ((pos - localPos).MagnitudeSqr2D() <= maxSq)
		return true;
	for (int i = 0; i < MP_MAX_PEERS; i++) {
		const MPRemotePlayer &rp = peers[i];
		if (rp.active && rp.peerId != localPeerId && rp.ped) {
			if ((pos - rp.ped->GetPosition()).MagnitudeSqr2D() <= maxSq)
				return true;
		}
	}
	return false;
}

bool CMPManager::GetSpawnFocusCoors(CVector *outCoors)
{
	if (!active || !outCoors)
		return false;
	CVector candidates[MP_MAX_PEERS];
	int count = 0;
	if (FindPlayerPed())
		candidates[count++] = FindPlayerCentreOfWorld(CWorld::PlayerInFocus);
	for (int i = 0; i < MP_MAX_PEERS; i++) {
		if (peers[i].active && peers[i].peerId != localPeerId && peers[i].ped)
			candidates[count++] = peers[i].ped->GetPosition();
	}
	if (count <= 1)
		return false;
	*outCoors = candidates[spawnFocusIdx % (uint32)count];
	spawnFocusIdx++;
	return true;
}

void CMPManager::SetUiPauseBlock(bool block)
{
	uiPauseBlock = block;
#ifdef __EMSCRIPTEN__
	CTimer::ms_bDisableUserPause = block;
	if (block)
		CTimer::EndUserPause();
#endif
}

static void EscapeJsonStr(const char *src, char *dst, int dstCap)
{
	int o = 0;
	for (int i = 0; src && src[i] && o + 2 < dstCap; i++) {
		unsigned char c = (unsigned char)src[i];
		if (c == '"' || c == '\\') {
			dst[o++] = '\\';
			dst[o++] = (char)c;
		} else if (c >= 0x20 && c < 0x7F) {
			dst[o++] = (char)c;
		} else {
			dst[o++] = ' ';
		}
	}
	dst[o] = '\0';
}

int CMPManager::GetHudJson(char *outBuf, int maxLen)
{
	if (!outBuf || maxLen <= 0)
		return 0;
	if (gGameState != GS_PLAYING_GAME || CPools::GetPedPool() == nil) {
		char safeName[64];
		EscapeJsonStr(localName, safeName, sizeof(safeName));
		return snprintf(outBuf, (size_t)maxLen,
			"{\"ready\":false,\"active\":%s,\"isHost\":%s,\"peerId\":%d,\"name\":\"%s\",\"model\":%d,"
			"\"health\":100,\"hp\":100,\"armor\":0,\"money\":0,\"wanted\":0,\"weaponId\":0,\"weapon\":0,"
			"\"ammoInClip\":0,\"ammoTotal\":0,\"ammo\":0,\"inVeh\":0,\"vehNetId\":0,\"seat\":-2,"
			"\"zone\":\"LIBERTY CITY\",\"vehicleName\":\"\",\"island\":1,\"inRemoteMode\":false,"
			"\"activeGarageType\":0,\"openIslands\":%s,\"peers\":[]}",
			active ? "true" : "false", isHost ? "true" : "false", localPeerId, safeName, localPreferredModel,
			openIslands ? "true" : "false");
	}
	CPlayerPed *ped = FindPlayerPed();
	CVector pos = ped ? ped->GetPosition() : CVector(0.0f, 0.0f, 0.0f);
	float hp = ped ? ped->m_fHealth : 0.0f;
	float arm = ped ? ped->m_fArmour : 0.0f;
	int money = CWorld::Players[CWorld::PlayerInFocus].m_nMoney;
	int wanted = (ped && ped->m_pWanted) ? ped->m_pWanted->GetWantedLevel() : 0;
	int weap = ped ? (int)ped->GetWeapon()->m_eWeaponType : 0;
	int ammo = ped ? (int)ped->GetWeapon()->m_nAmmoTotal : 0;
	int inVeh = (ped && ped->bInVehicle && ped->m_pMyVehicle) ? 1 : 0;
	int vehNetId = (inVeh && ped->m_pMyVehicle) ? AssignOrGetVehNetId(ped->m_pMyVehicle, (uint8)localPeerId) : 0;
	int seatIdx = -2;
	if (inVeh && ped->m_pMyVehicle) {
		if (ped->m_pMyVehicle->pDriver == ped) seatIdx = -1;
		else {
			for (int s = 0; s < 4; s++) {
				if (ped->m_pMyVehicle->pPassengers[s] == ped) { seatIdx = s; break; }
			}
		}
	}

	const char *zoneName = "Liberty City";
	CZone *zone = CTheZones::FindSmallestZonePosition(&pos);
	if (zone && zone->name[0])
		zoneName = zone->name;

	int radioIdx = -1;
	if (ped && ped->bInVehicle && ped->m_pMyVehicle)
		radioIdx = (int)ped->m_pMyVehicle->m_nRadioStation;

	char safeName[64], safeZone[64], safePager[256];
	EscapeJsonStr(localName, safeName, sizeof(safeName));
	EscapeJsonStr(zoneName, safeZone, sizeof(safeZone));
	EscapeJsonStr(lastPagerMsg, safePager, sizeof(safePager));

	int n = snprintf(outBuf, (size_t)maxLen,
		"{\"ready\":true,\"active\":%s,\"isHost\":%s,\"peerId\":%d,\"name\":\"%s\",\"model\":%d,"
		"\"hp\":%.0f,\"armor\":%.0f,\"money\":%d,\"wanted\":%d,\"weapon\":%d,\"ammo\":%d,"
		"\"inVeh\":%d,\"vehNetId\":%d,\"seat\":%d,\"x\":%.2f,\"y\":%.2f,\"z\":%.2f,"
		"\"clockH\":%d,\"clockM\":%d,\"weather\":%d,\"zone\":\"%s\",\"radio\":%d,"
		"\"openIslands\":%s,\"rampage\":%d,\"pager\":\"%s\",\"peers\":[",
		active ? "true" : "false",
		isHost ? "true" : "false",
		localPeerId,
		safeName,
		ped ? (int)ped->m_modelIndex : localPreferredModel,
		hp, arm, money, wanted, weap, ammo,
		inVeh, vehNetId, seatIdx, pos.x, pos.y, pos.z,
		(int)CClock::GetHours(), (int)CClock::GetMinutes(),
		(int)CWeather::NewWeatherType, safeZone, radioIdx,
		openIslands ? "true" : "false",
		CDarkel::FrenzyOnGoing() ? 1 : 0,
		safePager);

	bool first = true;
	for (int i = 0; i < MP_MAX_PEERS && n < maxLen - 160; i++) {
		MPRemotePlayer &rp = peers[i];
		if (!rp.active)
			continue;
		char pSafe[64];
		EscapeJsonStr(rp.name, pSafe, sizeof(pSafe));
		n += snprintf(outBuf + n, (size_t)(maxLen - n),
			"%s{\"peerId\":%d,\"name\":\"%s\",\"model\":%d,\"hp\":%u,\"armor\":%u,"
			"\"inVeh\":%d,\"seat\":%d,\"x\":%.1f,\"y\":%.1f,\"z\":%.1f}",
			first ? "" : ",",
			rp.peerId, pSafe, (int)rp.modelIndex, (unsigned)rp.health, (unsigned)rp.armor,
			(rp.flags & MP_PFLAG_IN_VEHICLE) ? 1 : 0, (int)rp.seatIdx,
			rp.pos.x, rp.pos.y, rp.pos.z);
		first = false;
	}
	if (n < maxLen - 3)
		n += snprintf(outBuf + n, (size_t)(maxLen - n), "]}");
	return n;
}

int CMPManager::GetFrontendSettingsJson(char *outBuf, int maxLen)
{
	if (!outBuf || maxLen <= 0)
		return 0;
	return snprintf(outBuf, (size_t)maxLen,
		"{\"musicVol\":%d,\"sfxVol\":%d,\"radioStation\":%d,\"brightness\":%d,"
		"\"drawDistance\":%.2f,\"frameLimiter\":%d,\"widescreen\":%d,\"subtitles\":%d,"
		"\"invertY\":%d,\"controlMethod\":%d,\"showHud\":%d,\"language\":%d}",
		(int)CMenuManager::m_PrefsMusicVolume,
		(int)CMenuManager::m_PrefsSfxVolume,
		(int)CMenuManager::m_PrefsRadioStation,
		(int)CMenuManager::m_PrefsBrightness,
		CMenuManager::m_PrefsLOD,
		(int)CMenuManager::m_PrefsFrameLimiter,
		(int)CMenuManager::m_PrefsUseWideScreen,
		(int)CMenuManager::m_PrefsShowSubtitles,
		MousePointerStateHelper.bInvertVertically ? 1 : 0,
		(int)CMenuManager::m_ControlMethod,
		CHud::m_Wants_To_Draw_Hud ? 1 : 0,
		(int)CMenuManager::m_PrefsLanguage);
}

int CMPManager::SetFrontendSetting(const char *key, float val)
{
	if (!key)
		return 0;
	if (!strcmp(key, "musicVol")) {
		CMenuManager::m_PrefsMusicVolume = (int32)Clamp(val, 0.0f, 127.0f);
		DMAudio.SetMusicMasterVolume((uint8)CMenuManager::m_PrefsMusicVolume);
	} else if (!strcmp(key, "sfxVol")) {
		CMenuManager::m_PrefsSfxVolume = (int32)Clamp(val, 0.0f, 127.0f);
		DMAudio.SetEffectsMasterVolume((uint8)CMenuManager::m_PrefsSfxVolume);
	} else if (!strcmp(key, "radioStation")) {
		CMenuManager::m_PrefsRadioStation = (int8)Clamp(val, 0.0f, 9.0f);
		DMAudio.SetRadioInCar((uint32)CMenuManager::m_PrefsRadioStation);
	} else if (!strcmp(key, "brightness")) {
		CMenuManager::m_PrefsBrightness = (int32)Clamp(val, 0.0f, 512.0f);
	} else if (!strcmp(key, "drawDistance")) {
		CMenuManager::m_PrefsLOD = Clamp(val, 0.8f, 1.8f);
	} else if (!strcmp(key, "frameLimiter")) {
		CMenuManager::m_PrefsFrameLimiter = (val > 0.5f) ? 1 : 0;
	} else if (!strcmp(key, "widescreen")) {
		CMenuManager::m_PrefsUseWideScreen = (val > 0.5f) ? 1 : 0;
	} else if (!strcmp(key, "subtitles")) {
		CMenuManager::m_PrefsShowSubtitles = (val > 0.5f) ? 1 : 0;
	} else if (!strcmp(key, "invertY")) {
		MousePointerStateHelper.bInvertVertically = (val > 0.5f);
	} else if (!strcmp(key, "controlMethod")) {
		CMenuManager::m_ControlMethod = (val > 0.5f) ? 1 : 0;
	} else if (!strcmp(key, "showHud")) {
		CHud::m_Wants_To_Draw_Hud = (val > 0.5f);
	} else {
		return 0;
	}
	FrontEndMenuManager.SaveSettings();
#ifdef LOAD_INI_SETTINGS
	SaveINISettings();
#endif
	return 1;
}

int CMPManager::ExportSave(uint8 **outPtr)
{
	if (!outPtr)
		return 0;
	*outPtr = nil;
	if (gGameState != GS_PLAYING_GAME || CPools::GetPedPool() == nil)
		return 0;
	const int kSlot = 7;
	if (!PcSaveHelper.SaveSlot(kSlot))
		return 0;

	int f = CFileMgr::OpenFile(ValidSaveName, "rb");
	if (f == 0)
		return 0;

	int total = 0;
	int cap = 262144;
	uint8 *buf = (uint8 *)malloc((size_t)cap);
	if (!buf) {
		CFileMgr::CloseFile(f);
		return 0;
	}
	uint8 chunk[8192];
	while (true) {
		int n = CFileMgr::Read(f, (const char *)chunk, sizeof(chunk));
		if (n <= 0)
			break;
		if (total + n > cap) {
			cap *= 2;
			uint8 *nb = (uint8 *)realloc(buf, (size_t)cap);
			if (!nb) {
				free(buf);
				CFileMgr::CloseFile(f);
				return 0;
			}
			buf = nb;
		}
		memcpy(buf + total, chunk, (size_t)n);
		total += n;
	}
	CFileMgr::CloseFile(f);
	*outPtr = buf;
	return total;
}

int CMPManager::ImportSave(const uint8 *data, int len)
{
	if (!data || len <= 0 || gGameState != GS_PLAYING_GAME || CPools::GetPedPool() == nil)
		return 0;
	const int kSlot = 7;
	_psGetUserFilesFolder();
	MakeValidSaveName(kSlot);
	int f = CFileMgr::OpenFile(ValidSaveName, "wb");
	if (f == 0)
		return 0;
	int written = CFileMgr::Write(f, (const char *)data, len);
	CFileMgr::CloseFile(f);
	if (written != len)
		return 0;

	strcpy(LoadFileName, ValidSaveName);
	FrontEndMenuManager.m_nCurrSaveSlot = kSlot;
	if (!CheckDataNotCorrupt(kSlot, LoadFileName))
		return 0;

#ifdef __EMSCRIPTEN__
	EmscriptenRequestRestart(true);
#endif
	return 1;
}

// Engine hook trampolines
void MP_Init(int localPeerId, int isHost) { gMP.Init(localPeerId, isHost != 0); }
void MP_Shutdown() { gMP.Shutdown(); }
void MP_OnWorldReset() { gMP.OnWorldReset(); }
void MP_TickBeforeGame() { gMP.TickBeforeGame(); }
void MP_TickAfterGame() { gMP.TickAfterGame(); }
void MP_RenderNameTags() { gMP.RenderNameTags(); }
bool MP_IsNearAnyPlayer2D(const CVector &pos, float maxDist) { return gMP.IsNearAnyPlayer2D(pos, maxDist); }
bool MP_GetSpawnFocusCoors(CVector *outCoors) { return gMP.GetSpawnFocusCoors(outCoors); }

#endif // MULTIPLAYER_COOP
