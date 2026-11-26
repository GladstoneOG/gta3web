#include "common.h"
#ifdef MULTIPLAYER_COOP

#include "mp_core.h"
#include "World.h"
#include "Pools.h"
#include "Game.h"
#include "crossplatform.h"
#include "PlayerPed.h"
#include "PlayerInfo.h"
#include "Vehicle.h"
#include "Automobile.h"
#include "Boat.h"
#include "ModelInfo.h"
#include "ModelIndices.h"
#include "Streaming.h"
#include "PathFind.h"
#include "Clock.h"
#include "Weather.h"
#include "Stats.h"
#include "Bridge.h"
#include "Garages.h"
#include "Remote.h"
#include "Darkel.h"
#include "Pickups.h"
#include "Radar.h"
#include "Messages.h"
#include "Hud.h"
#include "Text.h"
#include "Explosion.h"
#include "Weapon.h"
#include "Wanted.h"
#include "Script.h"
#include "Timer.h"
#include "Pad.h"
#include "DMAudio.h"
#include "soundlist.h"

// Built-in cheats defined in Pad.cpp
extern void WeaponCheat();
extern void HealthCheat();
extern void TankCheat();
extern void BlowUpCarsCheat();
extern void MayhemCheat();
extern void EverybodyAttacksPlayerCheat();
extern void WeaponsForAllCheat();
extern void FastTimeCheat();
extern void SlowTimeCheat();
extern void MoneyCheat();
extern void ArmourCheat();
extern void WantedLevelUpCheat();
extern void WantedLevelDownCheat();
extern void SunnyWeatherCheat();
extern void CloudyWeatherCheat();
extern void RainyWeatherCheat();
extern void FoggyWeatherCheat();
extern void FastWeatherCheat();
extern void OnlyRenderWheelsCheat();
extern void ChittyChittyBangBangCheat();
extern void StrongGripCheat();
extern void NastyLimbsCheat();

#ifdef __EMSCRIPTEN__
extern "C" void EmscriptenRequestRestart(bool wantToLoad);
#endif

CVehicle *CMPManager::SpawnVehicleLocal(int modelIndex, const CVector &pos, float heading, uint8 ownerPeer)
{
	if (modelIndex < MI_FIRST_VEHICLE || modelIndex >= MI_GRENADE)
		return nil;
	CBaseModelInfo *mi = CModelInfo::GetModelInfo(modelIndex);
	if (!mi || mi->GetModelType() != MITYPE_VEHICLE)
		return nil;

	CStreaming::RequestModel(modelIndex, STREAMFLAGS_DEPENDENCY);
	CStreaming::LoadAllRequestedModels(false);
	if (CStreaming::ms_aInfoForModel[modelIndex].m_loadState != STREAMSTATE_LOADED)
		return nil;

	CVehicle *veh = nil;
	if (((CVehicleModelInfo *)mi)->m_vehicleType == VEHICLE_TYPE_BOAT) {
		veh = new CBoat(modelIndex, RANDOM_VEHICLE);
	} else {
		veh = new CAutomobile(modelIndex, RANDOM_VEHICLE);
	}
	if (!veh) return nil;

	veh->SetPosition(pos);
	veh->SetOrientation(0.0f, 0.0f, heading);
	veh->SetStatus(STATUS_ABANDONED);
	veh->m_nDoorLock = CARLOCK_UNLOCKED;
	CWorld::Add(veh);
	AssignOrGetVehNetId(veh, ownerPeer);
	return veh;
}

CVehicle *CMPManager::SpawnVehicleAhead(int modelIndex, float aheadDist, bool broadcast)
{
	if (gGameState != GS_PLAYING_GAME || CPools::GetPedPool() == nil) return nil;
	CPlayerPed *ped = FindPlayerPed();
	if (!ped) return nil;
	CVector pos = ped->GetPosition() + ped->GetForward() * Max(aheadDist, 5.5f);
	pos.z += 1.2f;
	float heading = ped->m_fRotationCur;

	if (active && !isHost && broadcast) {
		uint8 pkt[32];
		MPBufWriter w(pkt, sizeof(pkt));
		w.Write<uint8>(PKT_SPAWN_REQ);
		w.Write<uint8>(0); // vehicle
		w.Write<int32>(modelIndex);
		w.Write<int32>(0);
		w.Write<float>(pos.x); w.Write<float>(pos.y); w.Write<float>(pos.z);
		w.Write<float>(heading);
		if (w.ok) QueuePacket(1, 1, pkt, w.pos); // request host to spawn authoritatively
		return nil;
	}

	CVehicle *veh = SpawnVehicleLocal(modelIndex, pos, heading, (uint8)localPeerId);
	if (veh && active && broadcast) {
		// Immediate sync packet so all peers see it instantly
		TickVehiclesAfterGame(lastVehTxMs + 1000);
	}
	return veh;
}

void CMPManager::SpawnPickupAhead(int pickupKind, int weaponOrAmount, bool broadcast)
{
	if (gGameState != GS_PLAYING_GAME || CPools::GetPedPool() == nil) return;
	CPlayerPed *ped = FindPlayerPed();
	if (!ped) return;
	CVector pos = ped->GetPosition() + ped->GetForward() * 3.0f;
	pos.z += 0.35f;

	if (active && !isHost && broadcast) {
		uint8 pkt[32];
		MPBufWriter w(pkt, sizeof(pkt));
		w.Write<uint8>(PKT_SPAWN_REQ);
		w.Write<uint8>(1); // pickup
		w.Write<int32>(pickupKind);
		w.Write<int32>(weaponOrAmount);
		w.Write<float>(pos.x); w.Write<float>(pos.y); w.Write<float>(pos.z);
		w.Write<float>(0.0f);
		if (w.ok) QueuePacket(1, 1, pkt, w.pos);
		return;
	}

	int mi = MI_PICKUP_HEALTH;
	uint8 ptype = PICKUP_ONCE;
	uint32 qty = 1;
	switch (pickupKind) {
		case 1: mi = MI_PICKUP_HEALTH; qty = 100; break;
		case 2: mi = MI_PICKUP_BODYARMOUR; qty = 100; break;
		case 3: mi = MI_MONEY; ptype = PICKUP_MONEY; qty = (uint32)Max(weaponOrAmount, 1000); break;
		case 4: mi = MI_PICKUP_BRIBE; qty = 1; break;
		case 5: mi = MI_PICKUP_ADRENALINE; qty = 1; break;
		case 6: {
			eWeaponType wt = (eWeaponType)Clamp(weaponOrAmount, (int)WEAPONTYPE_BASEBALLBAT, (int)WEAPONTYPE_GRENADE);
			mi = CPickups::ModelForWeapon(wt);
			qty = (wt == WEAPONTYPE_BASEBALLBAT) ? 1 : 120;
			break;
		}
		default: break;
	}
	CStreaming::RequestModel(mi, 0);
	CStreaming::LoadAllRequestedModels(false);
	int32 slot = CPickups::GenerateNewOne(pos, (uint32)mi, ptype, qty);
	if (active && broadcast && slot >= 0) {
		OnPickupEvent((int)(slot & 0xFFFF), 0, mi, ptype, (int)qty, pos);
	}
}

void CMPManager::SetOpenIslands(int open, bool fromNetwork)
{
	openIslands = (open != 0);
	if ((gGameState != GS_PLAYING_GAME && gGameState != GS_INIT_PLAYING_GAME) || CPools::GetObjectPool() == nil)
		return;
	if (openIslands) {
		CStats::IndustrialPassed = 1;
		CStats::CommercialPassed = 1;
		CStats::SuburbanPassed = 1;
		CBridge::Update();
		// Clear roadwork/bridge blockade objects placed on Callahan Bridge (Portland<->Staunton) or Shoreside tunnel
		CObjectPool *objPool = CPools::GetObjectPool();
		for (int i = 0; i < objPool->GetSize(); i++) {
			CObject *obj = objPool->GetSlot(i);
			if (!obj) continue;
			if (obj->GetModelIndex() == MI_ROADWORKBARRIER1 || obj->GetModelIndex() == MI_FENCE || obj->GetModelIndex() == MI_FENCE2) {
				CVector p = obj->GetPosition();
				// Callahan bridge barrier zone & Porter tunnel barrier zone
				bool onCallahan = (p.x > 490.0f && p.x < 710.0f && p.y > -975.0f && p.y < -895.0f);
				bool onTunnel = (p.x > -760.0f && p.x < -580.0f && p.y > -200.0f && p.y < 140.0f);
				if (onCallahan || onTunnel) {
					CWorld::Remove(obj);
					delete obj;
				}
			}
		}
		if (open == 2 && CTheScripts::ScriptToLoad != 1) {
			CTheScripts::ScriptToLoad = 1; // data/main_freeroam.scm
#ifdef __EMSCRIPTEN__
			if (gGameState == GS_PLAYING_GAME)
				EmscriptenRequestRestart(false);
#endif
		}
	}
	if (!fromNetwork && active && isHost) {
		uint8 pkt[32];
		MPBufWriter w(pkt, sizeof(pkt));
		w.Write<uint8>(PKT_SPAWN_REQ);
		w.Write<uint8>(3); // open islands
		w.Write<int32>(open);
		w.Write<int32>(0);
		w.Write<float>(0.0f); w.Write<float>(0.0f); w.Write<float>(0.0f);
		w.Write<float>(0.0f);
		if (w.ok) QueuePacket(1, 0, pkt, w.pos);
	}
}

void CMPManager::ExecCheat(int cheatId, int p1, int p2, bool fromNetwork)
{
	(void)p2;
	if (gGameState != GS_PLAYING_GAME || CPools::GetPedPool() == nil)
		return;
	CPlayerPed *ped = FindPlayerPed();
	if (!ped) return;

	// If peer invokes cheat in MP without host flag, only apply safe personal cheats unless fromNetwork
	if (!fromNetwork && active && !isHost) {
		uint8 pkt[32];
		MPBufWriter w(pkt, sizeof(pkt));
		w.Write<uint8>(PKT_SPAWN_REQ);
		w.Write<uint8>(2); // cheat request
		w.Write<int32>(cheatId);
		w.Write<int32>(p1);
		w.Write<float>(0.0f); w.Write<float>(0.0f); w.Write<float>(0.0f);
		w.Write<float>(0.0f);
		if (w.ok) QueuePacket(1, 1, pkt, w.pos);
		return;
	}

	switch (cheatId) {
		case 1: HealthCheat(); break;
		case 2: ArmourCheat(); break;
		case 3: MoneyCheat(); break;
		case 4: WeaponCheat(); break;
		case 5: WantedLevelUpCheat(); break;
		case 6: WantedLevelDownCheat(); break;
		case 7: SpawnVehicleAhead(MI_RHINO, 7.0f, true); break;
		case 8: BlowUpCarsCheat(); break;
		case 9:
			if (p1 == 0) SunnyWeatherCheat();
			else if (p1 == 1) CloudyWeatherCheat();
			else if (p1 == 2) RainyWeatherCheat();
			else FoggyWeatherCheat();
			break;
		case 10:
			if (p1 == 1) FastTimeCheat();
			else if (p1 == 2) SlowTimeCheat();
			else CTimer::SetTimeScale(1.0f);
			break;
		case 11: FastWeatherCheat(); break;
		case 12: MayhemCheat(); break;
		case 13: EverybodyAttacksPlayerCheat(); break;
		case 14: WeaponsForAllCheat(); break;
		case 15: OnlyRenderWheelsCheat(); break;
		case 16: ChittyChittyBangBangCheat(); break;
		case 17: StrongGripCheat(); break;
		case 18: NastyLimbsCheat(); break;
		case 19:
			if (FindPlayerVehicle()) {
				CVehicle *v = FindPlayerVehicle();
				v->m_fHealth = 1000.0f;
				if (v->IsCar()) ((CAutomobile *)v)->Fix();
			}
			break;
		case 20:
			if (FindPlayerVehicle()) {
				CVehicle *v = FindPlayerVehicle();
				CVector pos = v->GetPosition();
				pos.z += 1.0f;
				v->SetPosition(pos);
				v->SetOrientation(0.0f, 0.0f, v->GetForward().Heading());
				v->m_vecTurnSpeed = CVector(0, 0, 0);
			}
			break;
		case 21: {
			CVector rcPos = ped->GetPosition() + ped->GetForward() * 3.0f;
			CRemote::GivePlayerRemoteControlledCar(rcPos.x, rcPos.y, rcPos.z, ped->m_fRotationCur, MI_RCBANDIT);
			break;
		}
		case 22:
			SetPlayerInfo(0, localName, p1);
			return; // SetPlayerInfo already syncs identity cleanly
		default: break;
	}

	if (!fromNetwork && active && isHost) {
		uint8 pkt[32];
		MPBufWriter w(pkt, sizeof(pkt));
		w.Write<uint8>(PKT_SPAWN_REQ);
		w.Write<uint8>(2);
		w.Write<int32>(cheatId);
		w.Write<int32>(p1);
		w.Write<float>(0.0f); w.Write<float>(0.0f); w.Write<float>(0.0f);
		w.Write<float>(0.0f);
		if (w.ok) QueuePacket(1, 0, pkt, w.pos);
	}
}

void CMPManager::HandleSpawnReqPacket(int fromPeerId, const uint8 *data, int len)
{
	MPBufReader r(data + 1, len - 1);
	uint8 kind = r.Read<uint8>();
	int32 p1 = r.Read<int32>();
	int32 p2 = r.Read<int32>();
	CVector pos;
	pos.x = r.Read<float>(); pos.y = r.Read<float>(); pos.z = r.Read<float>();
	float heading = r.Read<float>();
	if (!r.ok) return;

	if (kind == 0) { // vehicle spawn
		if (!isHost) return;
		SpawnVehicleLocal(p1, pos, heading, (uint8)fromPeerId);
		TickVehiclesAfterGame(lastVehTxMs + 1000);
	} else if (kind == 1) { // pickup spawn
		if (!isHost) return;
		SpawnPickupAhead(p1, p2, true);
	} else if (kind == 2) { // cheat
		ExecCheat(p1, p2, 0, !isHost);
	} else if (kind == 3) { // open islands
		SetOpenIslands(p1, true);
	}
}

void CMPManager::OnGarageAction(int garageIdx, uint8 action, CVehicle *veh, uint8 c1, uint8 c2, uint8 bombType)
{
	if (!active || suppressLocalHooks)
		return;
	int32 vehNetId = veh ? AssignOrGetVehNetId(veh, (uint8)localPeerId) : 0;
	uint8 pkt[24];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_GARAGE_EVENT);
	w.Write<int16>((int16)garageIdx);
	w.Write<uint8>(action);
	w.Write<int32>(vehNetId);
	w.Write<uint8>((uint8)localPeerId);
	w.Write<uint8>(c1);
	w.Write<uint8>(c2);
	w.Write<uint8>(bombType);
	if (w.ok) QueuePacket(1, 0, pkt, w.pos);
}

void CMPManager::HandleGarageEventPacket(int fromPeerId, const uint8 *data, int len)
{
	(void)fromPeerId;
	MPBufReader r(data + 1, len - 1);
	int16 gidx = r.Read<int16>();
	uint8 action = r.Read<uint8>();
	int32 vehNetId = r.Read<int32>();
	uint8 peerId = r.Read<uint8>();
	uint8 c1 = r.Read<uint8>();
	uint8 c2 = r.Read<uint8>();
	uint8 bombType = r.Read<uint8>();
	if (!r.ok || peerId == (uint8)localPeerId)
		return;

	CVehicle *veh = FindVehByNetId(vehNetId);
	if (veh && veh->IsCar()) {
		CAutomobile *ac = (CAutomobile *)veh;
		if (action == MP_GARAGE_RESPRAY) {
			ac->m_currentColour1 = c1;
			ac->m_currentColour2 = c2;
			ac->m_fHealth = 1000.0f;
			ac->Fix();
			DMAudio.PlayFrontEndSound(SOUND_GARAGE_OPENING, 1);
		} else if (action >= MP_GARAGE_BOMB1 && action <= MP_GARAGE_BOMB3) {
			ac->m_bombType = bombType & 7;
			MPRemotePlayer *rp = GetPeerSlot(peerId);
			ac->m_pBombRigger = rp ? (CEntity *)rp->ped : nil;
		} else if (action == MP_GARAGE_DETONATE) {
			MPRemotePlayer *rp = GetPeerSlot(peerId);
			ac->BlowUpCar(rp ? (CEntity *)rp->ped : nil);
		} else if (action == MP_GARAGE_CRUSH) {
			ac->BlowUpCar(nil);
		}
	}
	if (gidx >= 0 && gidx < NUM_GARAGES) {
		CGarages::aGarages[gidx].m_eGarageState = GS_OPENING;
	}
}

void CMPManager::OnRemoteCarEvent(uint8 action, const CVector &pos, float heading, int vehNetId)
{
	if (!active || suppressLocalHooks)
		return;
	uint8 pkt[32];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_RC_EVENT);
	w.Write<uint8>((uint8)localPeerId);
	w.Write<uint8>(action);
	w.Write<int32>(vehNetId);
	w.Write<float>(pos.x); w.Write<float>(pos.y); w.Write<float>(pos.z);
	w.Write<float>(heading);
	if (w.ok) QueuePacket(1, 0, pkt, w.pos);
}

void CMPManager::HandleRcEventPacket(int fromPeerId, const uint8 *data, int len)
{
	(void)fromPeerId;
	MPBufReader r(data + 1, len - 1);
	uint8 peerId = r.Read<uint8>();
	uint8 action = r.Read<uint8>();
	int32 vehNetId = r.Read<int32>();
	CVector pos;
	pos.x = r.Read<float>(); pos.y = r.Read<float>(); pos.z = r.Read<float>();
	float heading = r.Read<float>();
	if (!r.ok || peerId == (uint8)localPeerId)
		return;

	if (action == 0) {
		CVehicle *rc = SpawnVehicleLocal(MI_RCBANDIT, pos, heading, peerId);
		if (rc && vehNetId > 0) {
			if (MPVehicleNetEntry *e = FindVehEntry(rc))
				e->netId = vehNetId;
		}
	} else if (action == 1) {
		CVehicle *rc = FindVehByNetId(vehNetId);
		CExplosion::AddExplosion(rc, nil, EXPLOSION_CAR, pos, 0);
		if (rc) rc->BlowUpCar(nil);
	}
}

void CMPManager::OnPickupEvent(int slot, uint8 action, int mi, uint8 type, int qty, const CVector &pos)
{
	if (!active || suppressLocalHooks)
		return;
	uint8 pkt[32];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_PICKUP_EVENT);
	w.Write<int16>((int16)slot);
	w.Write<uint8>(action);
	w.Write<uint8>((uint8)localPeerId);
	w.Write<int16>((int16)mi);
	w.Write<uint8>(type);
	w.Write<int16>((int16)qty);
	w.Write<float>(pos.x); w.Write<float>(pos.y); w.Write<float>(pos.z);
	if (w.ok) QueuePacket(1, 0, pkt, w.pos);
}

void CMPManager::HandlePickupEventPacket(int fromPeerId, const uint8 *data, int len)
{
	(void)fromPeerId;
	MPBufReader r(data + 1, len - 1);
	int16 slot = r.Read<int16>();
	uint8 action = r.Read<uint8>();
	uint8 collectorPeer = r.Read<uint8>();
	int16 mi = r.Read<int16>();
	uint8 ptype = r.Read<uint8>();
	int16 qty = r.Read<int16>();
	CVector pos;
	pos.x = r.Read<float>(); pos.y = r.Read<float>(); pos.z = r.Read<float>();
	if (!r.ok || collectorPeer == (uint8)localPeerId)
		return;

	suppressLocalHooks = true;
	if (action == 0 && mi > 0) {
		CStreaming::RequestModel((int)mi, 0);
		CStreaming::LoadAllRequestedModels(false);
		CPickups::GenerateNewOne(pos, (uint32)mi, ptype, (uint32)qty);
	} else if (action == 1 && slot >= 0 && slot < NUMPICKUPS) {
		CPickups::aPickUps[slot].m_eType = PICKUP_NONE;
		CPickups::aPickUps[slot].m_bRemoved = true;
	}
	suppressLocalHooks = false;
}

void CMPManager::TickWorldAfterGame(uint32 nowMs)
{
	if (!isHost)
		return;

	if (nowMs - lastWorldTxMs >= 200) {
		lastWorldTxMs = nowMs;
		uint8 pkt[32];
		MPBufWriter w(pkt, sizeof(pkt));
		w.Write<uint8>(PKT_WORLD_SYNC);
		w.Write<uint8>(CClock::GetHours());
		w.Write<uint8>(CClock::GetMinutes());
		w.Write<int16>(CWeather::OldWeatherType);
		w.Write<int16>(CWeather::NewWeatherType);
		w.Write<float>(CWeather::InterpolationValue);
		uint8 islandFlags = (CStats::IndustrialPassed ? 1 : 0)
			| (CStats::CommercialPassed ? 2 : 0)
			| (CStats::SuburbanPassed ? 4 : 0)
			| (openIslands ? 8 : 0)
			| (CTheScripts::ScriptToLoad == 1 ? 16 : 0);
		w.Write<uint8>(islandFlags);
		if (w.ok) QueuePacket(0, 0, pkt, w.pos);
	}

	if (nowMs - lastMissionTxMs >= 300) {
		lastMissionTxMs = nowMs;
		CPlayerPed *ped = FindPlayerPed();
		uint8 wanted = (ped && ped->m_pWanted) ? (uint8)ped->m_pWanted->GetWantedLevel() : 0;
		uint8 frenzyOn = CDarkel::FrenzyOnGoing() ? 1 : 0;

		uint8 pkt[MP_MAX_PKT_BYTES];
		MPBufWriter w(pkt, sizeof(pkt));
		w.Write<uint8>(PKT_MISSION_SYNC);
		w.Write<uint8>(wanted);
		w.Write<uint8>(frenzyOn);

		// Collect up to 8 active story coord blips for peer visibility
		int blipCountPos = w.pos;
		w.Write<uint8>(0);
		uint8 bcount = 0;
		for (int i = 0; i < NUMRADARBLIPS && bcount < 8; i++) {
			sRadarTrace &tr = CRadar::ms_RadarTrace[i];
			if (!tr.m_bInUse || tr.m_eBlipDisplay == BLIP_DISPLAY_NEITHER)
				continue;
			// Skip remote player blips (handled locally)
			bool isPeerBlip = false;
			for (int p = 0; p < MP_MAX_PEERS; p++) {
				if (peers[p].radarBlipHandle >= 0 && CRadar::GetActualBlipArrayIndex(peers[p].radarBlipHandle) == i) {
					isPeerBlip = true; break;
				}
			}
			if (isPeerBlip) continue;
			if (tr.m_eBlipType == BLIP_COORD || tr.m_eBlipType == BLIP_CONTACT_POINT || tr.m_eRadarSprite != RADAR_SPRITE_NONE) {
				w.Write<int16>((int16)i);
				w.Write<uint8>((uint8)tr.m_eRadarSprite);
				w.Write<uint32>(tr.m_nColor);
				w.Write<float>(tr.m_vecPos.x); w.Write<float>(tr.m_vecPos.y); w.Write<float>(tr.m_vecPos.z);
				bcount++;
			}
		}
		pkt[blipCountPos] = bcount;
		if (w.ok) QueuePacket(0, 0, pkt, w.pos);
	}
}

void CMPManager::HandleWorldSyncPacket(int fromPeerId, const uint8 *data, int len)
{
	if (isHost) return;
	(void)fromPeerId;
	MPBufReader r(data + 1, len - 1);
	uint8 h = r.Read<uint8>();
	uint8 m = r.Read<uint8>();
	int16 oldW = r.Read<int16>();
	int16 newW = r.Read<int16>();
	float interp = r.Read<float>();
	uint8 islandFlags = r.Read<uint8>();
	if (!r.ok) return;

	CClock::SetGameClock(h, m);
	CWeather::OldWeatherType = oldW;
	CWeather::NewWeatherType = newW;
	CWeather::InterpolationValue = interp;
	if ((islandFlags & 16) && CTheScripts::ScriptToLoad != 1)
		SetOpenIslands(2, true);
	else if ((islandFlags & 8) && !openIslands)
		SetOpenIslands(1, true);
	else {
		if (islandFlags & 1) CStats::IndustrialPassed = 1;
		if (islandFlags & 2) CStats::CommercialPassed = 1;
		if (islandFlags & 4) CStats::SuburbanPassed = 1;
	}
}

void CMPManager::HandleMissionSyncPacket(int fromPeerId, const uint8 *data, int len)
{
	if (isHost) return;
	(void)fromPeerId;
	MPBufReader r(data + 1, len - 1);
	uint8 hostWanted = r.Read<uint8>();
	uint8 frenzyOn = r.Read<uint8>();
	uint8 bcount = r.Read<uint8>();
	if (!r.ok) return;
	(void)frenzyOn;

	// Sync shared mission blips gently
	for (uint8 i = 0; i < bcount && i < 8; i++) {
		int16 bidx = r.Read<int16>();
		uint8 sprite = r.Read<uint8>();
		uint32 col = r.Read<uint32>();
		CVector bpos;
		bpos.x = r.Read<float>(); bpos.y = r.Read<float>(); bpos.z = r.Read<float>();
		if (!r.ok) break;
		(void)bidx; (void)sprite; (void)col; (void)bpos;
	}
	(void)hostWanted;
}

void MP_OnGarageAction(int garageIdx, uint8 action, CVehicle *veh, uint8 c1, uint8 c2, uint8 bombType)
{
	gMP.OnGarageAction(garageIdx, action, veh, c1, c2, bombType);
}

void MP_OnRemoteCarEvent(uint8 action, const CVector &pos, float heading, CVehicle *veh)
{
	int32 netId = veh ? gMP.AssignOrGetVehNetId(veh, (uint8)gMP.localPeerId) : 0;
	gMP.OnRemoteCarEvent(action, pos, heading, netId);
}

void MP_OnPickupEvent(int slot, uint8 action, int mi, uint8 type, int qty, const CVector &pos)
{
	gMP.OnPickupEvent(slot, action, mi, type, qty, pos);
}

#endif // MULTIPLAYER_COOP
