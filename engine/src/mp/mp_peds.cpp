#include "common.h"
#ifdef MULTIPLAYER_COOP

#include "mp_core.h"
#include "World.h"
#include "Pools.h"
#include "Ped.h"
#include "CivilianPed.h"
#include "PlayerPed.h"
#include "PlayerInfo.h"
#include "Vehicle.h"
#include "Automobile.h"
#include "Streaming.h"
#include "ModelInfo.h"
#include "ModelIndices.h"
#include "AnimManager.h"
#include "Weapon.h"
#include "WeaponInfo.h"
#include "Particle.h"
#include "DMAudio.h"
#include "Radar.h"
#include "Timer.h"
#include "Pad.h"
#include "Camera.h"
#include "soundlist.h"

namespace {

bool IsPoolPedValid(CPed *ped)
{
	if (!ped) return false;
	CPool<CPed, CPlayerPed> *pool = CPools::GetPedPool();
	if (!pool) return false;
	int sz = pool->GetSize();
	for (int i = 0; i < sz; i++) {
		if (pool->GetSlot(i) == ped)
			return true;
	}
	return false;
}

float LerpAngle(float a, float b, float t)
{
	float diff = b - a;
	while (diff > PI) diff -= TWOPI;
	while (diff < -PI) diff += TWOPI;
	return a + diff * t;
}

bool ValidateVehiclePtr(CVehicle *v)
{
	if (!v) return false;
	CPool<CVehicle, CAutomobile> *pool = CPools::GetVehiclePool();
	if (!pool) return false;
	for (int i = 0; i < pool->GetSize(); i++) {
		if (pool->GetSlot(i) == v) return true;
	}
	return false;
}

} // namespace

bool CMPManager::IsRemotePlayerPed(const CPed *ped) const
{
	if (!ped) return false;
	for (int i = 0; i < MP_MAX_PEERS; i++) {
		if (peers[i].active && peers[i].ped == ped)
			return true;
	}
	return false;
}

void CMPManager::CleanupStalePeds()
{
	for (int i = 0; i < MP_MAX_PED_MAP; i++) {
		if (pedMap[i].used && !IsPoolPedValid(pedMap[i].ped))
			memset(&pedMap[i], 0, sizeof(pedMap[i]));
	}
}

void CMPManager::SendLocalPlayerState(uint32 nowMs)
{
	if (nowMs - lastStateTxMs < 25) // ~40 Hz
		return;
	lastStateTxMs = nowMs;

	CPlayerPed *ped = FindPlayerPed();
	if (!ped) return;

	uint8 pkt[96];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_PLAYER_STATE);
	w.Write<uint8>((uint8)localPeerId);
	w.Write<int32>((int32)ped->m_modelIndex);

	CVector pos = ped->GetPosition();
	w.Write<float>(pos.x); w.Write<float>(pos.y); w.Write<float>(pos.z);
	w.Write<float>(ped->m_vecMoveSpeed.x); w.Write<float>(ped->m_vecMoveSpeed.y); w.Write<float>(ped->m_vecMoveSpeed.z);
	w.Write<float>(ped->m_fRotationCur);

	w.Write<uint8>((uint8)Clamp(ped->m_fHealth, 0.0f, 255.0f));
	w.Write<uint8>((uint8)Clamp(ped->m_fArmour, 0.0f, 255.0f));
	w.Write<uint8>((uint8)ped->GetWeapon()->m_eWeaponType);
	w.Write<uint8>((uint8)ped->m_nMoveState);
	w.Write<float>(ped->m_fMoveSpeed);

	uint16 flags = 0;
	int32 vehNetId = 0;
	int8 seatIdx = -2;
	if (ped->bInVehicle && ped->m_pMyVehicle) {
		flags |= MP_PFLAG_IN_VEHICLE;
		vehNetId = AssignOrGetVehNetId(ped->m_pMyVehicle, (uint8)localPeerId);
		if (ped->m_pMyVehicle->pDriver == ped)
			seatIdx = -1;
		else {
			for (int s = 0; s < 4; s++) {
				if (ped->m_pMyVehicle->pPassengers[s] == ped) { seatIdx = (int8)s; break; }
			}
		}
	}
	if (ped->bIsShooting) flags |= MP_PFLAG_FIRING;
	if (ped->m_nMoveState == PEDMOVE_SPRINT) flags |= MP_PFLAG_SPRINTING;
	if (ped->bIsDucking) flags |= MP_PFLAG_DUCKING;
	if (ped->m_nPedState == PED_JUMP) flags |= MP_PFLAG_JUMPING;
	if (ped->DyingOrDead()) flags |= MP_PFLAG_DEAD;
	if (ped->bIsAimingGun) flags |= MP_PFLAG_AIMING;

	w.Write<uint16>(flags);
	w.Write<int32>(vehNetId);
	w.Write<int8>(seatIdx);
	if (w.ok) QueuePacket(0, 0, pkt, w.pos);
}

void CMPManager::HandlePlayerIdentityPacket(int fromPeerId, const uint8 *data, int len)
{
	MPBufReader r(data + 1, len - 1);
	uint8 peerId = r.Read<uint8>();
	int32 modelIdx = r.Read<int32>();
	char pname[MP_NAME_LEN];
	r.ReadBytes(pname, MP_NAME_LEN);
	pname[MP_NAME_LEN - 1] = '\0';
	if (!r.ok) return;
	(void)fromPeerId;
	if (peerId == (uint8)localPeerId) return;
	SetPlayerInfo(peerId, pname, modelIdx);
}

void CMPManager::HandlePlayerStatePacket(int fromPeerId, const uint8 *data, int len)
{
	MPBufReader r(data + 1, len - 1);
	uint8 peerId = r.Read<uint8>();
	int32 modelIdx = r.Read<int32>();
	CVector pos, vel;
	pos.x = r.Read<float>(); pos.y = r.Read<float>(); pos.z = r.Read<float>();
	vel.x = r.Read<float>(); vel.y = r.Read<float>(); vel.z = r.Read<float>();
	float heading = r.Read<float>();
	uint8 hp = r.Read<uint8>();
	uint8 armor = r.Read<uint8>();
	uint8 weapon = r.Read<uint8>();
	uint8 moveState = r.Read<uint8>();
	float moveSpeed = r.Read<float>();
	uint16 flags = r.Read<uint16>();
	int32 vehNetId = r.Read<int32>();
	int8 seatIdx = r.Read<int8>();
	if (!r.ok) return;
	(void)fromPeerId;
	if (peerId == (uint8)localPeerId) return;

	MPRemotePlayer *rp = GetPeerSlot(peerId);
	if (!rp) return;

	bool firstTime = !rp->active;
	rp->active = true;
	rp->peerId = peerId;
	if (!rp->name[0])
		snprintf(rp->name, MP_NAME_LEN, "Player %d", (int)peerId);
	if (modelIdx >= 0 && modelIdx <= MI_LAST_PED && rp->modelIndex != modelIdx)
		rp->pendingModelIndex = modelIdx;
	rp->prevPos = firstTime ? pos : rp->pos;
	rp->targetPos = pos;
	rp->vel = vel;
	rp->prevHeading = firstTime ? heading : rp->heading;
	rp->targetHeading = heading;
	rp->health = hp;
	rp->armor = armor;
	rp->weapon = weapon;
	rp->animState = moveState;
	rp->moveSpeed = moveSpeed;
	rp->flags = flags;
	rp->vehNetId = vehNetId;
	rp->seatIdx = seatIdx;
	rp->lastRxMs = CTimer::GetTimeInMilliseconds();
}

void CMPManager::TickRemotePlayers(uint32 nowMs)
{
	for (int i = 0; i < MP_MAX_PEERS; i++) {
		MPRemotePlayer &rp = peers[i];
		if (!rp.active || rp.peerId == localPeerId)
			continue;

		// Drop timed out peer peds after 12s without packets
		if (rp.lastRxMs != 0 && (nowMs - rp.lastRxMs) > 12000) {
			if (rp.radarBlipHandle >= 0) {
				CRadar::ClearBlip(rp.radarBlipHandle);
				rp.radarBlipHandle = -1;
			}
			if (rp.ped) {
				if (rp.ped->bInVehicle && rp.ped->m_pMyVehicle && ValidateVehiclePtr(rp.ped->m_pMyVehicle)) {
					if (rp.ped->m_pMyVehicle->pDriver == rp.ped) rp.ped->m_pMyVehicle->RemoveDriver();
					else rp.ped->m_pMyVehicle->RemovePassenger(rp.ped);
				}
				CWorld::Remove(rp.ped);
				delete rp.ped;
				rp.ped = nil;
			}
			rp.active = false;
			continue;
		}

		// Lazy spawn remote player ped cleanly once position received
		if (!rp.ped && rp.lastRxMs != 0) {
			int32 useModel = (rp.pendingModelIndex >= 0 && rp.pendingModelIndex <= MI_LAST_PED) ? rp.pendingModelIndex : MI_PLAYER;
			CStreaming::RequestModel(useModel, STREAMFLAGS_DEPENDENCY | STREAMFLAGS_DONT_REMOVE);
			CStreaming::LoadAllRequestedModels(false);
			if (CStreaming::ms_aInfoForModel[useModel].m_loadState == STREAMSTATE_LOADED) {
				CCivilianPed *rped = new CCivilianPed(PEDTYPE_PLAYER2, (uint32)useModel);
				if (rped) {
					rped->CharCreatedBy = MISSION_CHAR;
					rped->bRespondsToThreats = false;
					rped->bStreamingDontDelete = true;
					rped->bRenderPedInCar = true;
					rped->m_animGroup = ASSOCGRP_PLAYER;
					rped->SetPosition(rp.targetPos);
					CWorld::Add(rped);
					rp.ped = rped;
					rp.modelIndex = useModel;
					rp.pos = rp.targetPos;
					rp.heading = rp.targetHeading;

					// Create teammate radar blip!
					int32 pedHandle = CPools::GetPedRef(rped);
					rp.radarBlipHandle = CRadar::SetEntityBlip(BLIP_CHAR, pedHandle, 0, BLIP_DISPLAY_BOTH);
					if (rp.radarBlipHandle >= 0) {
						int blipCol = (rp.peerId == 2) ? RADAR_TRACE_GREEN : (rp.peerId == 3) ? RADAR_TRACE_LIGHT_BLUE : RADAR_TRACE_MAGENTA;
						CRadar::ChangeBlipColour(rp.radarBlipHandle, blipCol);
						CRadar::ChangeBlipScale(rp.radarBlipHandle, 2);
					}
				}
			}
		}

		if (!rp.ped || !IsPoolPedValid(rp.ped)) {
			rp.ped = nil;
			continue;
		}

		CPed *ped = rp.ped;
		if (rp.pendingModelIndex != rp.modelIndex && !ped->bInVehicle) {
			if (ApplyPedSkin(ped, rp.pendingModelIndex, true))
				rp.modelIndex = rp.pendingModelIndex;
		}

		ped->m_fHealth = (float)rp.health;
		ped->m_fArmour = (float)rp.armor;
		ped->m_nPedState = (rp.flags & MP_PFLAG_IN_VEHICLE) ? PED_DRIVING :
		                   (rp.flags & MP_PFLAG_DEAD) ? PED_DEAD : PED_IDLE;

		// Update active held weapon cleanly
		if (rp.weapon < WEAPONTYPE_LAST_WEAPONTYPE && ped->GetWeapon()->m_eWeaponType != (eWeaponType)rp.weapon) {
			if (rp.weapon == WEAPONTYPE_UNARMED) {
				ped->SetCurrentWeapon(WEAPONTYPE_UNARMED);
			} else {
				ped->GiveWeapon((eWeaponType)rp.weapon, 999);
				ped->SetCurrentWeapon((eWeaponType)rp.weapon);
			}
		}

		bool wantInVeh = !!(rp.flags & MP_PFLAG_IN_VEHICLE) && rp.vehNetId > 0;
		if (wantInVeh) {
			CVehicle *veh = FindVehByNetId(rp.vehNetId);
			if (veh && ValidateVehiclePtr(veh)) {
				if (!ped->bInVehicle || ped->m_pMyVehicle != veh) {
					if (ped->bInVehicle && ped->m_pMyVehicle && ValidateVehiclePtr(ped->m_pMyVehicle)) {
						if (ped->m_pMyVehicle->pDriver == ped) ped->m_pMyVehicle->RemoveDriver();
						else ped->m_pMyVehicle->RemovePassenger(ped);
					}
					ped->bInVehicle = true;
					ped->m_pMyVehicle = veh;
					ped->bUsesCollision = false;
					ped->SetPedState(PED_DRIVING);
					if (rp.seatIdx == -1) {
						veh->SetDriver(ped);
					} else {
						int seat = Clamp((int)rp.seatIdx, 0, 3);
						veh->AddPassenger(ped, (uint8)seat);
					}
					ped->m_pVehicleAnim = CAnimManager::BlendAnimation(ped->GetClump(), ASSOCGRP_STD, veh->GetDriverAnim(), 100.0f);
				}
				ped->SetPedPositionInCar();
				rp.pos = ped->GetPosition();
				rp.heading = ped->m_fRotationCur;
			}
		} else {
			if (ped->bInVehicle) {
				if (ped->m_pMyVehicle && ValidateVehiclePtr(ped->m_pMyVehicle)) {
					if (ped->m_pMyVehicle->pDriver == ped) ped->m_pMyVehicle->RemoveDriver();
					else ped->m_pMyVehicle->RemovePassenger(ped);
				}
				ped->bInVehicle = false;
				ped->m_pMyVehicle = nil;
				ped->bUsesCollision = true;
				ped->SetPedState(PED_IDLE);
				CAnimManager::BlendAnimation(ped->GetClump(), ped->m_animGroup, ANIM_STD_IDLE, 100.0f);
			}

			// Interpolate remote player on foot smoothly
			float dtExtrap = Min((float)(nowMs - rp.lastRxMs) * 0.001f, 0.1f);
			CVector predPos = rp.targetPos + rp.vel * (dtExtrap * 50.0f);
			float dSq = (predPos - rp.pos).MagnitudeSqr();
			if (dSq > SQR(10.0f))
				rp.pos = predPos;
			else
				rp.pos = rp.pos + (predPos - rp.pos) * 0.38f;
			rp.heading = LerpAngle(rp.heading, rp.targetHeading, 0.4f);

			ped->SetPosition(rp.pos);
			ped->SetHeading(rp.heading);
			ped->m_fRotationCur = rp.heading;
			ped->m_fRotationDest = rp.heading;
			ped->m_vecMoveSpeed = rp.vel;
			ped->m_nMoveState = (eMoveState)rp.animState;
			ped->bIsDucking = !!(rp.flags & MP_PFLAG_DUCKING);

			// Blend locomotion animation smoothly
			if (rp.flags & MP_PFLAG_DEAD) {
				if (ped->m_nPedState != PED_DEAD) ped->SetDead();
			} else if (rp.flags & MP_PFLAG_DUCKING) {
				ped->SetDuck(200);
			} else if (rp.flags & MP_PFLAG_SPRINTING) {
				CAnimManager::BlendAnimation(ped->GetClump(), ped->m_animGroup, ANIM_STD_RUNFAST, 4.0f);
			} else if (rp.animState == PEDMOVE_RUN) {
				CAnimManager::BlendAnimation(ped->GetClump(), ped->m_animGroup, ANIM_STD_RUN, 4.0f);
			} else if (rp.animState == PEDMOVE_WALK) {
				CAnimManager::BlendAnimation(ped->GetClump(), ped->m_animGroup, ANIM_STD_WALK, 4.0f);
			} else {
				CAnimManager::BlendAnimation(ped->GetClump(), ped->m_animGroup, ANIM_STD_IDLE, 4.0f);
			}
		}
	}
}

void CMPManager::OnShotFired(eWeaponType weapon, const CVector &origin, const CVector &dir, CEntity *hitEnt, float dmg, bool isDriveBy)
{
	if (!active || suppressLocalHooks)
		return;
	uint8 pkt[64];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_SHOT_EVENT);
	w.Write<uint8>((uint8)localPeerId);
	w.Write<uint8>((uint8)weapon);
	w.Write<uint8>(isDriveBy ? 1 : 0);
	w.Write<float>(origin.x); w.Write<float>(origin.y); w.Write<float>(origin.z);
	w.Write<float>(dir.x); w.Write<float>(dir.y); w.Write<float>(dir.z);
	uint8 hitType = 0;
	int32 hitNetId = 0;
	if (hitEnt && hitEnt->IsVehicle()) {
		hitType = 1;
		hitNetId = AssignOrGetVehNetId((CVehicle *)hitEnt, (uint8)localPeerId);
	}
	w.Write<uint8>(hitType);
	w.Write<int32>(hitNetId);
	w.Write<float>(dmg);
	if (w.ok) QueuePacket(1, 0, pkt, w.pos);
}

void CMPManager::HandleShotEventPacket(int fromPeerId, const uint8 *data, int len)
{
	MPBufReader r(data + 1, len - 1);
	uint8 peerId = r.Read<uint8>();
	uint8 weapon = r.Read<uint8>();
	uint8 isDriveBy = r.Read<uint8>();
	CVector origin, dir;
	origin.x = r.Read<float>(); origin.y = r.Read<float>(); origin.z = r.Read<float>();
	dir.x = r.Read<float>(); dir.y = r.Read<float>(); dir.z = r.Read<float>();
	uint8 hitType = r.Read<uint8>();
	int32 hitNetId = r.Read<int32>();
	float dmg = r.Read<float>();
	if (!r.ok || peerId == (uint8)localPeerId)
		return;
	(void)fromPeerId;
	(void)isDriveBy;

	MPRemotePlayer *rp = GetPeerSlot(peerId);
	CPed *shooter = rp ? rp->ped : nil;

	// Muzzle flash particle + weapon shot SFX
	CParticle::AddParticle(PARTICLE_GUNFLASH, origin, dir * 0.5f, nil, 0.2f);
	if (shooter) {
		uint16 sfx = SOUND_WEAPON_SHOT_FIRED;
		if (weapon == WEAPONTYPE_UZI || weapon == WEAPONTYPE_UZI_DRIVEBY) sfx = SOUND_WEAPON_UZI_BULLET_ECHO;
		else if (weapon == WEAPONTYPE_AK47) sfx = SOUND_WEAPON_AK47_BULLET_ECHO;
		else if (weapon == WEAPONTYPE_M16) sfx = SOUND_WEAPON_M16_BULLET_ECHO;
		DMAudio.PlayOneShot(shooter->m_audioEntityId, sfx, 1.0f);
	}

	if (hitType == 1 && hitNetId > 0) {
		CVehicle *veh = FindVehByNetId(hitNetId);
		if (veh && ValidateVehiclePtr(veh))
			veh->InflictDamage(shooter, (eWeaponType)weapon, dmg);
	} else {
		// Raycast shot on remote client to spark/hit NPCs or nearby world
		CColPoint cp;
		CEntity *hitEnt = nil;
		CVector endPt = origin + dir * 65.0f;
		if (CWorld::ProcessLineOfSight(origin, endPt, cp, hitEnt, true, true, true, true, false, false, false)) {
			CParticle::AddParticle(PARTICLE_GUNSMOKE, cp.point, CVector(0, 0, 0.05f), nil, 0.15f);
			if (hitEnt && hitEnt != shooter) {
				if (hitEnt->IsPed())
					((CPed *)hitEnt)->InflictDamage(shooter, (eWeaponType)weapon, dmg, PEDPIECE_TORSO, 0);
				else if (hitEnt->IsVehicle())
					((CVehicle *)hitEnt)->InflictDamage(shooter, (eWeaponType)weapon, dmg);
			}
		}
	}
}

void CMPManager::TickPedsAfterGame(uint32 nowMs)
{
	if (!isHost || (nowMs - lastPedTxMs) < 90) // Host syncs nearby ambient/mission peds @ ~11 Hz
		return;
	lastPedTxMs = nowMs;

	CPlayerPed *localPed = FindPlayerPed();
	if (!localPed) return;
	CVector lpos = localPed->GetPosition();

	CPool<CPed, CPlayerPed> *pool = CPools::GetPedPool();
	int sz = pool->GetSize();

	struct PedSnap {
		int32 netId;
		int16 mi;
		uint8 pedType;
		uint8 flags;
		CVector pos;
		float heading;
		uint8 hp;
		uint8 weapon;
		uint8 anim;
	} snaps[12];
	int count = 0;

	for (int i = 0; i < sz && count < 12; i++) {
		CPed *p = pool->GetSlot(i);
		if (!p || p == localPed || IsRemotePlayerPed(p) || p->bInVehicle)
			continue;
		bool nearAny = ((p->GetPosition() - lpos).MagnitudeSqr2D() < SQR(70.0f)) || IsNearAnyPlayer2D(p->GetPosition(), 55.0f);
		if (!nearAny && p->CharCreatedBy != MISSION_CHAR)
			continue;

		PedSnap &s = snaps[count++];
		s.netId = (int32)(i + 1);
		s.mi = (int16)p->m_modelIndex;
		s.pedType = (uint8)p->m_nPedType;
		s.flags = (p->DyingOrDead() ? 1 : 0) | ((p->CharCreatedBy == MISSION_CHAR) ? 2 : 0);
		s.pos = p->GetPosition();
		s.heading = p->m_fRotationCur;
		s.hp = (uint8)Clamp(p->m_fHealth, 0.0f, 255.0f);
		s.weapon = (uint8)p->GetWeapon()->m_eWeaponType;
		s.anim = (uint8)p->m_nMoveState;
	}
	if (count == 0) return;

	uint8 pkt[MP_MAX_PKT_BYTES];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_PED_SYNC);
	w.Write<uint8>((uint8)count);
	for (int i = 0; i < count; i++) {
		w.Write<int32>(snaps[i].netId);
		w.Write<int16>(snaps[i].mi);
		w.Write<uint8>(snaps[i].pedType);
		w.Write<uint8>(snaps[i].flags);
		w.Write<float>(snaps[i].pos.x); w.Write<float>(snaps[i].pos.y); w.Write<float>(snaps[i].pos.z);
		w.Write<float>(snaps[i].heading);
		w.Write<uint8>(snaps[i].hp);
		w.Write<uint8>(snaps[i].weapon);
		w.Write<uint8>(snaps[i].anim);
	}
	if (w.ok) QueuePacket(0, 0, pkt, w.pos);
}

void CMPManager::HandlePedSyncPacket(int fromPeerId, const uint8 *data, int len)
{
	if (isHost) return;
	(void)fromPeerId;
	MPBufReader r(data + 1, len - 1);
	uint8 count = r.Read<uint8>();
	if (!r.ok || count == 0 || count > 16) return;

	CVector lpos = FindPlayerCentreOfWorld(CWorld::PlayerInFocus);
	for (uint8 i = 0; i < count; i++) {
		int32 netId = r.Read<int32>();
		int16 mi = r.Read<int16>();
		uint8 pedType = r.Read<uint8>();
		uint8 flags = r.Read<uint8>();
		CVector pos;
		pos.x = r.Read<float>(); pos.y = r.Read<float>(); pos.z = r.Read<float>();
		float heading = r.Read<float>();
		uint8 hp = r.Read<uint8>();
		uint8 weapon = r.Read<uint8>();
		uint8 anim = r.Read<uint8>();
		if (!r.ok) break;
		if ((pos - lpos).MagnitudeSqr2D() > SQR(95.0f))
			continue;

		// Match by pedMap netId
		MPPedNetEntry *slot = nil;
		MPPedNetEntry *freeSlot = nil;
		for (int k = 0; k < MP_MAX_PED_MAP; k++) {
			if (pedMap[k].used && pedMap[k].netId == netId) { slot = &pedMap[k]; break; }
			if (!pedMap[k].used && !freeSlot) freeSlot = &pedMap[k];
		}
		if (!slot && freeSlot && mi >= 0 && mi <= MI_LAST_PED && !(flags & 1)) {
			CStreaming::RequestModel(mi, 0);
			if (CStreaming::ms_aInfoForModel[mi].m_loadState == STREAMSTATE_LOADED) {
				CCivilianPed *np = new CCivilianPed((ePedType)pedType, (uint32)mi);
				if (np) {
					np->CharCreatedBy = (flags & 2) ? MISSION_CHAR : RANDOM_CHAR;
					np->SetPosition(pos);
					CWorld::Add(np);
					freeSlot->used = true;
					freeSlot->ped = np;
					freeSlot->netId = netId;
					slot = freeSlot;
				}
			}
		}
		if (slot && slot->ped && IsPoolPedValid(slot->ped)) {
			CPed *p = slot->ped;
			if (flags & 1) {
				if (!p->DyingOrDead()) { p->m_fHealth = 0.0f; p->SetDead(); }
			} else {
				CVector cur = p->GetPosition();
				p->SetPosition(cur + (pos - cur) * 0.35f);
				p->m_fRotationCur = LerpAngle(p->m_fRotationCur, heading, 0.35f);
				p->m_fRotationDest = heading;
				p->m_fHealth = (float)hp;
				p->m_nMoveState = (eMoveState)anim;
				if (weapon < WEAPONTYPE_LAST_WEAPONTYPE && p->GetWeapon()->m_eWeaponType != (eWeaponType)weapon) {
					p->GiveWeapon((eWeaponType)weapon, 100);
					p->SetCurrentWeapon((eWeaponType)weapon);
				}
			}
		}
	}
}

bool MP_IsRemotePlayerPed(const CPed *ped) { return gMP.IsRemotePlayerPed(ped); }
void MP_OnShotFired(eWeaponType weapon, const CVector &origin, const CVector &dir, CEntity *hitEnt, float dmg, bool isDriveBy)
{
	gMP.OnShotFired(weapon, origin, dir, hitEnt, dmg, isDriveBy);
}

#endif // MULTIPLAYER_COOP
