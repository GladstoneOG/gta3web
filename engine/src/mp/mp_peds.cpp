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
#include "AnimBlendAssociation.h"
#include "RpAnimBlend.h"
#include "Weapon.h"
#include "WeaponInfo.h"
#include "Particle.h"
#include "Explosion.h"
#include "ProjectileInfo.h"
#include "DMAudio.h"
#include "Radar.h"
#include "Timer.h"
#include "Pad.h"
#include "Camera.h"
#include "General.h"
#include "soundlist.h"
#include <math.h>

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

uint8 EncodeDoorCode(uint32 doorNode)
{
	switch (doorNode) {
	case CAR_DOOR_LF: return 1;
	case CAR_DOOR_RF: return 2;
	case CAR_DOOR_LR: return 3;
	case CAR_DOOR_RR: return 4;
	default:          return 0;
	}
}

uint32 DecodeDoorCode(uint8 code)
{
	switch (code) {
	case 1: return CAR_DOOR_LF;
	case 2: return CAR_DOOR_RF;
	case 3: return CAR_DOOR_LR;
	case 4: return CAR_DOOR_RR;
	default: return 0;
	}
}

bool IsCarSwingDoorNode(uint32 doorNode)
{
	return doorNode == CAR_DOOR_LF || doorNode == CAR_DOOR_RF ||
	       doorNode == CAR_DOOR_LR || doorNode == CAR_DOOR_RR;
}

bool IsDoorCloseAnim(int32 animId)
{
	return animId == ANIM_STD_CAR_CLOSE_DOOR_LHS ||
	       animId == ANIM_STD_CAR_CLOSE_DOOR_LO_LHS ||
	       animId == ANIM_STD_CAR_CLOSE_DOOR_RHS ||
	       animId == ANIM_STD_CAR_CLOSE_DOOR_LO_RHS;
}

CAnimBlendAssociation *FindLiveVehAnim(CPed *ped)
{
	if (!ped || !ped->m_pVehicleAnim || !ped->GetClump()) return nil;
	for (CAnimBlendAssociation *a = RpAnimBlendClumpGetFirstAssociation(ped->GetClump()); a; a = RpAnimBlendGetNextAssociation(a)) {
		if (a == ped->m_pVehicleAnim) return a;
	}
	return nil;
}

bool IsLocomotionAnimId(int32 animId)
{
	switch (animId) {
	case ANIM_STD_WALK:
	case ANIM_STD_RUN:
	case ANIM_STD_RUNFAST:
	case ANIM_STD_IDLE:
	case ANIM_STD_IDLE_BIGGUN:
	case ANIM_STD_IDLE_HBHB:
	case ANIM_STD_IDLE_TIRED:
	case ANIM_STD_RUNSTOP1:
	case ANIM_STD_RUNSTOP2:
	case ANIM_STD_JUMP_LAUNCH:
	case ANIM_STD_JUMP_GLIDE:
	case ANIM_STD_JUMP_LAND:
	case ANIM_STD_FALL:
	case ANIM_STD_FALL_GLIDE:
	case ANIM_STD_FALL_LAND:
		return true;
	default:
		return false;
	}
}

struct MpRecentExplosion3 {
	CVector pos;
	uint32 timeMs;
};
MpRecentExplosion3 gRecentExplosions3[8];
int32 gRecentExpCursor3 = 0;

void RecordExplosion3(const CVector &pos, uint32 nowMs)
{
	gRecentExplosions3[gRecentExpCursor3].pos = pos;
	gRecentExplosions3[gRecentExpCursor3].timeMs = nowMs;
	gRecentExpCursor3 = (gRecentExpCursor3 + 1) % 8;
}

bool IsDuplicateExplosion3(const CVector &pos, uint32 nowMs)
{
	for (int i = 0; i < 8; i++) {
		if (gRecentExplosions3[i].timeMs != 0 && (nowMs - gRecentExplosions3[i].timeMs) < 450u) {
			if ((gRecentExplosions3[i].pos - pos).MagnitudeSqr() < SQR(3.0f))
				return true;
		}
	}
	return false;
}

bool gMpSuppressExplosion3 = false;

AnimationId ExpectedSeatedAnim(CVehicle *veh, int8 seatIdx)
{
	if (!veh) return ANIM_STD_CAR_SIT;
	if (veh->IsBoat()) return veh->GetDriverAnim();
	if (seatIdx == -1) return veh->bLowVehicle ? ANIM_STD_CAR_SIT_LO : ANIM_STD_CAR_SIT;
	return veh->bLowVehicle ? ANIM_STD_CAR_SIT_P_LO : ANIM_STD_CAR_SIT_P;
}

void CloseRemoteLastDoor(MPRemotePlayer &rp)
{
	if (rp.lastDoorVehId <= 0 || rp.lastDoorCode == 0) return;
	uint32 doorComp = DecodeDoorCode(rp.lastDoorCode);
	if (IsCarSwingDoorNode(doorComp)) {
		CVehicle *lv = gMP.FindVehByNetId(rp.lastDoorVehId);
		if (lv && lv->IsCar() && ValidateVehiclePtr(lv)) {
			lv->ProcessOpenDoor(doorComp, ANIM_STD_NUM, 0.0f);
		}
	}
	rp.lastDoorVehId = 0;
	rp.lastDoorCode = 0;
}

void DetachRemotePedFromVehicle(CPed *ped)
{
	if (!ped) return;
	if (ped->bInVehicle && ped->m_pMyVehicle && ValidateVehiclePtr(ped->m_pMyVehicle)) {
		if (ped->m_pMyVehicle->pDriver == ped) ped->m_pMyVehicle->RemoveDriver();
		else ped->m_pMyVehicle->RemovePassenger(ped);
	}
	ped->RemoveInCarAnims();
	ped->bInVehicle = false;
	ped->m_pMyVehicle = nil;
	ped->m_pVehicleAnim = nil;
}

void EnsureRemoteSeatedAnim(CPed *ped, CVehicle *veh, int8 seatIdx)
{
	if (!ped || !veh || !ped->GetClump()) return;
	AnimationId expAnim = ExpectedSeatedAnim(veh, seatIdx);
	CAnimBlendAssociation *sit = RpAnimBlendClumpGetAssociation(ped->GetClump(), expAnim);
	if (!sit || sit->blendDelta < 0.0f) {
		for (CAnimBlendAssociation *a = RpAnimBlendClumpGetFirstAssociation(ped->GetClump()); a; a = RpAnimBlendGetNextAssociation(a)) {
			if (a->animId != expAnim) {
				a->blendDelta = -1000.0f;
				a->flags |= ASSOC_DELETEFADEDOUT;
			}
		}
		ped->m_pVehicleAnim = CAnimManager::BlendAnimation(ped->GetClump(), ASSOCGRP_STD, expAnim, 100.0f);
		ped->StopNonPartialAnims();
	}
	ped->bChangedSeat = false;
	ped->bRenderPedInCar = !veh->bIsBus;
}

void FadeOutVehicleDoorAnims(CPed *ped, int32 keepAnimId)
{
	if (!ped || !ped->GetClump()) return;
	for (CAnimBlendAssociation *a = RpAnimBlendClumpGetFirstAssociation(ped->GetClump()); a; a = RpAnimBlendGetNextAssociation(a)) {
		bool isSeatedAnim = (keepAnimId < 0) && (a->animId >= ANIM_STD_CAR_SIT && a->animId <= ANIM_STD_BOAT_DRIVE);
		if (isSeatedAnim || (a->animId >= ANIM_STD_QUICKJACK && a->animId <= ANIM_STD_CAR_CLOSE_DOOR_LO_RHS)) {
			if (a->animId != keepAnimId) {
				a->blendDelta = -1000.0f;
				a->flags |= ASSOC_DELETEFADEDOUT;
			}
		}
	}
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
	if (nowMs - lastStateTxMs < 30)
		return;
	lastStateTxMs = nowMs;

	CPlayerPed *ped = FindPlayerPed();
	if (!ped) return;

	uint8 pkt[112];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_PLAYER_STATE);
	w.Write<uint8>((uint8)localPeerId);
	w.Write<int32>((int32)ped->m_modelIndex);

	bool hasMyVeh = (ped->m_pMyVehicle != nil && ValidateVehiclePtr(ped->m_pMyVehicle));
	bool isEntering = hasMyVeh && (ped->m_nPedState == PED_ENTER_CAR || ped->m_nPedState == PED_CARJACK || ped->m_nPedState == PED_SEEK_IN_BOAT);
	bool isExiting = hasMyVeh && (ped->m_nPedState == PED_EXIT_CAR || ped->m_nPedState == PED_DRAG_FROM_CAR);
	bool isSeated = ped->bInVehicle && hasMyVeh && !isExiting;

	CVector pos = ped->GetPosition();
	CVector vel = isSeated ? ped->m_pMyVehicle->m_vecMoveSpeed : ped->m_vecMoveSpeed;
	w.Write<float>(pos.x); w.Write<float>(pos.y); w.Write<float>(pos.z);
	w.Write<float>(vel.x); w.Write<float>(vel.y); w.Write<float>(vel.z);
	w.Write<float>(ped->m_fRotationCur);

	w.Write<uint8>((uint8)Clamp(ped->m_fHealth, 0.0f, 255.0f));
	w.Write<uint8>((uint8)Clamp(ped->m_fArmour, 0.0f, 255.0f));
	w.Write<uint8>((uint8)ped->GetWeapon()->m_eWeaponType);
	w.Write<uint8>((uint8)ped->m_nMoveState);
	w.Write<float>(ped->m_fMoveSpeed);

	uint16 flags = 0;
	int32 vehNetId = 0;
	int8 seatIdx = -2;
	if (isSeated) flags |= MP_PFLAG_IN_VEHICLE;
	if (isEntering) flags |= MP_PFLAG_ENTERING_VEH;
	if (isExiting) flags |= MP_PFLAG_EXITING_VEH;
	if (hasMyVeh) {
		vehNetId = AssignOrGetVehNetId(ped->m_pMyVehicle, (uint8)localPeerId);
		if (isEntering) {
			if (ped->m_objective == OBJECTIVE_ENTER_CAR_AS_DRIVER || ped->m_nPedState == PED_CARJACK || ped->m_pMyVehicle->pDriver == ped) {
				seatIdx = -1;
			} else if (ped->m_vehDoor == CAR_DOOR_RF) seatIdx = 0;
			else if (ped->m_vehDoor == CAR_DOOR_RR) seatIdx = 2;
			else if (ped->m_vehDoor == CAR_DOOR_LR) seatIdx = 1;
			else seatIdx = 0;
		} else if (ped->m_pMyVehicle->pDriver == ped) {
			seatIdx = -1;
		} else {
			for (int s = 0; s < 4; s++) {
				if (ped->m_pMyVehicle->pPassengers[s] == ped) { seatIdx = (int8)s; break; }
			}
		}
	}
	if (ped->bIsShooting) flags |= MP_PFLAG_FIRING;
	if (ped->m_nMoveState == PEDMOVE_SPRINT) flags |= MP_PFLAG_SPRINTING;
	if (ped->bIsDucking) flags |= MP_PFLAG_DUCKING;
	if (ped->m_nPedState == PED_JUMP || ped->bIsInTheAir) flags |= MP_PFLAG_JUMPING;
	if (ped->DyingOrDead()) flags |= MP_PFLAG_DEAD;
	if (ped->bIsAimingGun || ped->m_nPedState == PED_AIM_GUN) flags |= MP_PFLAG_AIMING;
	if (ped->m_nPedState == PED_FIGHT || ped->m_nPedState == PED_ATTACK || ped->bIsAttacking || ped->bIsShooting) flags |= MP_PFLAG_ATTACKING;

	CAnimBlendAssociation *va = FindLiveVehAnim(ped);
	int16 animId = -1;
	float animTime = 0.0f;
	if (va && (isEntering || isExiting || (isSeated && IsDoorCloseAnim(va->animId)))) {
		animId = (int16)va->animId;
		animTime = va->currentTime;
	} else if (!isSeated && !isEntering && !isExiting && (flags & (MP_PFLAG_ATTACKING | MP_PFLAG_AIMING | MP_PFLAG_FIRING)) && ped->GetClump()) {
		CAnimBlendAssociation *best = nil;
		float bestWeight = 0.05f;
		for (CAnimBlendAssociation *a = RpAnimBlendClumpGetFirstAssociation(ped->GetClump()); a; a = RpAnimBlendGetNextAssociation(a)) {
			if (IsLocomotionAnimId(a->animId)) continue;
			if (a->blendDelta >= 0.0f && a->blendAmount > bestWeight) {
				bestWeight = a->blendAmount;
				best = a;
			}
		}
		if (best) {
			animId = (int16)best->animId;
			animTime = best->currentTime;
		}
	}

	w.Write<uint16>(flags);
	w.Write<int32>(vehNetId);
	w.Write<int8>(seatIdx);
	w.Write<uint8>((uint8)ped->m_nPedState);
	w.Write<uint8>(EncodeDoorCode(ped->m_vehDoor));
	w.Write<int16>(animId);
	w.Write<float>(animTime);
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

	bool firstTime = !rp->active || rp->lastRxMs == 0;
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
	if (r.pos + 8 <= len - 1) {
		rp->pedState = r.Read<uint8>();
		rp->vehDoorCode = r.Read<uint8>();
		rp->vehAnimId = r.Read<int16>();
		rp->vehAnimTime = r.Read<float>();
	} else {
		rp->pedState = 0;
		rp->vehDoorCode = 0;
		rp->vehAnimId = -1;
		rp->vehAnimTime = 0.0f;
	}
	rp->lastRxMs = CTimer::GetTimeInMilliseconds();
}

void CMPManager::TickRemotePlayers(uint32 nowMs)
{
	for (int i = 0; i < MP_MAX_PEERS; i++) {
		MPRemotePlayer &rp = peers[i];
		if (!rp.active || rp.peerId == localPeerId)
			continue;

		if (rp.lastRxMs != 0 && (nowMs - rp.lastRxMs) > 12000) {
			CloseRemoteLastDoor(rp);
			if (rp.radarBlipHandle >= 0) {
				CRadar::ClearBlip(rp.radarBlipHandle);
				rp.radarBlipHandle = -1;
			}
			if (rp.ped && IsPoolPedValid(rp.ped)) {
				DetachRemotePedFromVehicle(rp.ped);
				CWorld::Remove(rp.ped);
				delete rp.ped;
			}
			rp.ped = nil;
			rp.active = false;
			continue;
		}

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

		bool isTransition = !!(rp.flags & (MP_PFLAG_ENTERING_VEH | MP_PFLAG_EXITING_VEH));
		bool wantInVeh = !!(rp.flags & MP_PFLAG_IN_VEHICLE) && !isTransition && rp.vehNetId > 0;

		// Case 1: Transitioning in/out of vehicle with door animation
		if (isTransition && rp.vehNetId > 0) {
			if (ped->bInVehicle) {
				DetachRemotePedFromVehicle(ped);
			}
			ped->bUsesCollision = false;
			ped->bIsInTheAir = false;
			ped->bRenderPedInCar = true;
			ped->m_nPedState = PED_IDLE;

			float dSq = (rp.targetPos - rp.pos).MagnitudeSqr();
			rp.pos = (dSq > SQR(10.0f)) ? rp.targetPos : (rp.pos + (rp.targetPos - rp.pos) * 0.55f);
			rp.heading = LerpAngle(rp.heading, rp.targetHeading, 0.55f);
			ped->GetMatrix().SetRotateZ(rp.heading);
			ped->SetPosition(rp.pos);
			ped->m_fRotationCur = rp.heading;
			ped->m_fRotationDest = rp.heading;
			ped->UpdateRwFrame();

			if (rp.vehAnimId >= 0) {
				ped->StopNonPartialAnims();
				FadeOutVehicleDoorAnims(ped, rp.vehAnimId);
				CAnimBlendAssociation *cur = RpAnimBlendClumpGetAssociation(ped->GetClump(), (uint32)rp.vehAnimId);
				if (!cur) {
					cur = CAnimManager::AddAnimation(ped->GetClump(), ASSOCGRP_STD, (AnimationId)rp.vehAnimId);
				}
				if (cur) {
					cur->callbackType = CAnimBlendAssociation::CB_NONE;
					cur->SetBlend(1.0f, 8.0f);
					cur->SetRun();
					if (fabsf(cur->currentTime - rp.vehAnimTime) > 0.08f) {
						cur->SetCurrentTime(rp.vehAnimTime);
					}
					ped->m_pVehicleAnim = cur;
				}
			}

			CVehicle *v = FindVehByNetId(rp.vehNetId);
			uint32 doorComp = DecodeDoorCode(rp.vehDoorCode);
			if (v && v->IsCar() && ValidateVehiclePtr(v) && IsCarSwingDoorNode(doorComp) && rp.vehAnimId >= 0) {
				v->ProcessOpenDoor(doorComp, (uint32)rp.vehAnimId, rp.vehAnimTime);
				rp.lastDoorVehId = rp.vehNetId;
				rp.lastDoorCode = rp.vehDoorCode;
			}
			continue;
		}

		// Case 2: Seated in vehicle
		if (wantInVeh) {
			CVehicle *veh = FindVehByNetId(rp.vehNetId);
			if (veh && ValidateVehiclePtr(veh)) {
				bool needSeat = !ped->bInVehicle || ped->m_pMyVehicle != veh;
				if (!needSeat) {
					if (rp.seatIdx == -1 && veh->pDriver != ped) needSeat = true;
					else if (rp.seatIdx >= 0 && rp.seatIdx < 4 && veh->pPassengers[rp.seatIdx] != ped) needSeat = true;
				}
				if (needSeat) {
					DetachRemotePedFromVehicle(ped);
					if (rp.seatIdx == -1) {
						if (veh->pDriver && veh->pDriver != ped && !IsRemotePlayerPed(veh->pDriver) && veh->pDriver != FindPlayerPed()) {
							CPed *oldDrv = veh->pDriver;
							veh->RemoveDriver();
							if (IsPoolPedValid(oldDrv) && oldDrv->CharCreatedBy == MISSION_CHAR) {
								oldDrv->RemoveInCarAnims();
								oldDrv->bInVehicle = false;
								oldDrv->m_pMyVehicle = nil;
								CWorld::Remove(oldDrv);
								delete oldDrv;
							}
						}
						if (!veh->pDriver) {
							veh->SetDriver(ped);
							ped->bInVehicle = true;
							ped->m_pMyVehicle = veh;
							ped->bUsesCollision = false;
							ped->bChangedSeat = false;
							ped->SetPedState(PED_DRIVING);
							ped->RemoveWeaponWhenEnteringVehicle();
						}
					} else {
						int seat = Clamp((int)rp.seatIdx, 0, 3);
						if (!veh->pPassengers[seat]) {
							veh->AddPassenger(ped, (uint8)seat);
							ped->bInVehicle = true;
							ped->m_pMyVehicle = veh;
							ped->bUsesCollision = false;
							ped->bChangedSeat = false;
							ped->SetPedState(PED_DRIVING);
							ped->RemoveWeaponWhenEnteringVehicle();
						}
					}
				}
				if (ped->bInVehicle && ped->m_pMyVehicle == veh) {
					EnsureRemoteSeatedAnim(ped, veh, rp.seatIdx);
					ped->SetPedPositionInCar();
					ped->UpdateRwFrame();
					uint32 doorComp = DecodeDoorCode(rp.vehDoorCode);
					if (veh->IsCar() && IsCarSwingDoorNode(doorComp) && IsDoorCloseAnim(rp.vehAnimId)) {
						veh->ProcessOpenDoor(doorComp, (uint32)rp.vehAnimId, rp.vehAnimTime);
						rp.lastDoorVehId = rp.vehNetId;
						rp.lastDoorCode = rp.vehDoorCode;
					} else {
						CloseRemoteLastDoor(rp);
					}
					rp.pos = ped->GetPosition();
					rp.heading = ped->m_fRotationCur;
					continue;
				}
			}
		}

		// Case 3: On foot
		if (ped->bInVehicle || ped->m_pVehicleAnim != nil) {
			DetachRemotePedFromVehicle(ped);
			ped->bUsesCollision = true;
			ped->SetPedState(PED_IDLE);
			ped->RestartNonPartialAnims();
			ped->ReplaceWeaponWhenExitingVehicle();
			CAnimManager::BlendAnimation(ped->GetClump(), ped->m_animGroup, ANIM_STD_IDLE, 100.0f);
		}
		CloseRemoteLastDoor(rp);
		FadeOutVehicleDoorAnims(ped, -1);

		if (rp.weapon < WEAPONTYPE_LAST_WEAPONTYPE && ped->GetWeapon()->m_eWeaponType != (eWeaponType)rp.weapon) {
			if (rp.weapon == WEAPONTYPE_UNARMED) {
				ped->SetCurrentWeapon(WEAPONTYPE_UNARMED);
			} else {
				ped->GiveWeapon((eWeaponType)rp.weapon, 999);
				ped->SetCurrentWeapon((eWeaponType)rp.weapon);
			}
		}

		float dtExtrap = Min((float)(nowMs - rp.lastRxMs) * 0.001f, 0.1f);
		CVector predPos = rp.targetPos + rp.vel * (dtExtrap * 50.0f);
		float dSq = (predPos - rp.pos).MagnitudeSqr();
		rp.pos = (dSq > SQR(10.0f)) ? predPos : (rp.pos + (predPos - rp.pos) * 0.42f);
		rp.heading = LerpAngle(rp.heading, rp.targetHeading, 0.42f);

		ped->bUsesCollision = true;
		ped->GetMatrix().SetRotateZ(rp.heading);
		ped->SetPosition(rp.pos);
		ped->m_fRotationCur = rp.heading;
		ped->m_fRotationDest = rp.heading;
		ped->m_vecMoveSpeed = rp.vel;
		ped->m_nMoveState = (eMoveState)rp.animState;
		ped->bIsDucking = !!(rp.flags & MP_PFLAG_DUCKING);
		ped->UpdateRwFrame();

		if (rp.flags & MP_PFLAG_DEAD) {
			if (ped->m_nPedState != PED_DEAD) ped->SetDead();
			rp.lastCombatAnimId = -1;
		} else {
			if (ped->m_nPedState == PED_DEAD) ped->m_nPedState = PED_IDLE;
			ped->RestartNonPartialAnims();
			if (rp.flags & MP_PFLAG_DUCKING) {
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
			if (rp.vehAnimId >= 0) {
				if (rp.lastCombatAnimId >= 0 && rp.lastCombatAnimId != rp.vehAnimId) {
					CAnimBlendAssociation *prev = RpAnimBlendClumpGetAssociation(ped->GetClump(), (uint32)rp.lastCombatAnimId);
					if (prev) {
						prev->blendDelta = -8.0f;
						prev->flags |= ASSOC_DELETEFADEDOUT;
					}
				}
				CAnimBlendAssociation *ca = RpAnimBlendClumpGetAssociation(ped->GetClump(), (uint32)rp.vehAnimId);
				if (!ca || ca->blendDelta < 0.0f) {
					ca = CAnimManager::BlendAnimation(ped->GetClump(), ASSOCGRP_STD, (AnimationId)rp.vehAnimId, 8.0f);
				}
				if (ca) {
					ca->callbackType = CAnimBlendAssociation::CB_NONE;
					ca->SetRun();
					if (fabsf(ca->currentTime - rp.vehAnimTime) > 0.10f && rp.vehAnimTime >= 0.0f && ca->hierarchy && rp.vehAnimTime <= ca->hierarchy->totalLength) {
						ca->SetCurrentTime(rp.vehAnimTime);
					}
				}
				rp.lastCombatAnimId = rp.vehAnimId;
			} else if (rp.lastCombatAnimId >= 0) {
				CAnimBlendAssociation *prev = RpAnimBlendClumpGetAssociation(ped->GetClump(), (uint32)rp.lastCombatAnimId);
				if (prev) {
					prev->blendDelta = -8.0f;
					prev->flags |= ASSOC_DELETEFADEDOUT;
				}
				rp.lastCombatAnimId = -1;
			}
		}
	}
}

void CMPManager::TickRemotePlayersAfter(uint32 nowMs)
{
	(void)nowMs;
	for (int i = 0; i < MP_MAX_PEERS; i++) {
		MPRemotePlayer &rp = peers[i];
		if (!rp.active || rp.peerId == localPeerId || !rp.ped || !IsPoolPedValid(rp.ped))
			continue;
		bool isTransition = !!(rp.flags & (MP_PFLAG_ENTERING_VEH | MP_PFLAG_EXITING_VEH));
		if (!isTransition && (rp.flags & MP_PFLAG_IN_VEHICLE) && rp.ped->bInVehicle && rp.ped->m_pMyVehicle && ValidateVehiclePtr(rp.ped->m_pMyVehicle)) {
			EnsureRemoteSeatedAnim(rp.ped, rp.ped->m_pMyVehicle, rp.seatIdx);
			rp.ped->SetPedPositionInCar();
			rp.ped->UpdateRwFrame();
		} else if (!(rp.flags & MP_PFLAG_DEAD)) {
			rp.ped->SetPosition(rp.pos);
			rp.ped->m_fRotationCur = rp.heading;
			rp.ped->m_fRotationDest = rp.heading;
			rp.ped->SetHeading(rp.heading);
			rp.ped->UpdateRwFrame();
		}
	}
	if (!isHost) {
		for (int i = 0; i < MP_MAX_PED_MAP; i++) {
			MPPedNetEntry &sp = pedMap[i];
			if (!sp.used || !sp.ped || !IsPoolPedValid(sp.ped)) continue;
			if (!(sp.targetFlags & 1)) {
				sp.ped->SetPosition(sp.pos);
				sp.ped->m_fRotationCur = sp.heading;
				sp.ped->m_fRotationDest = sp.heading;
				sp.ped->SetHeading(sp.heading);
				sp.ped->UpdateRwFrame();
			}
		}
	}
}

int CMPManager::FindPeerIdByPed(const CPed *ped) const
{
	if (!ped) return -1;
	for (int i = 0; i < MP_MAX_PEERS; i++) {
		if (peers[i].active && peers[i].ped == ped)
			return peers[i].peerId;
	}
	return -1;
}

int32 CMPManager::FindSyncedPedNetIdByPtr(const CPed *ped) const
{
	if (!ped) return -1;
	for (int i = 0; i < MP_MAX_PED_MAP; i++) {
		if (pedMap[i].used && pedMap[i].ped == ped)
			return pedMap[i].netId;
	}
	return -1;
}

void CMPManager::OnShotFired(eWeaponType weapon, const CVector &origin, const CVector &dir, CEntity *hitEnt, float dmg, bool isDriveBy, uint8 shotKind, float power)
{
	if (!active || suppressLocalHooks)
		return;
	uint8 pkt[64];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_SHOT_EVENT);
	w.Write<uint8>((uint8)localPeerId);
	w.Write<uint8>((uint8)weapon);
	w.Write<uint8>((uint8)((isDriveBy ? 1 : 0) | ((shotKind & 7) << 1)));
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
	w.Write<float>(power);
	if (w.ok) QueuePacket((shotKind == 2) ? 1 : 0, 0, pkt, w.pos);
}

void CMPManager::HandleShotEventPacket(int fromPeerId, const uint8 *data, int len)
{
	MPBufReader r(data + 1, len - 1);
	uint8 peerId = r.Read<uint8>();
	uint8 weapon = r.Read<uint8>();
	uint8 shotFlags = r.Read<uint8>();
	CVector origin, dir;
	origin.x = r.Read<float>(); origin.y = r.Read<float>(); origin.z = r.Read<float>();
	dir.x = r.Read<float>(); dir.y = r.Read<float>(); dir.z = r.Read<float>();
	uint8 hitType = r.Read<uint8>();
	int32 hitNetId = r.Read<int32>();
	float dmg = r.Read<float>();
	if (!r.ok || peerId == (uint8)localPeerId)
		return;
	float power = (r.pos + 4 <= len - 1) ? r.Read<float>() : 0.35f;
	(void)fromPeerId;
	(void)hitType;
	(void)hitNetId;
	(void)dmg;

	MPRemotePlayer *rp = GetPeerSlot(peerId);
	CPed *shooter = (rp && rp->ped && IsPoolPedValid(rp->ped)) ? rp->ped : nil;
	if (!shooter) return;
	if (dir.MagnitudeSqr() < 0.0001f) dir = shooter->GetForward();
	else dir.Normalise();

	uint8 shotKind = (shotFlags >> 1) & 7;
	eWeaponType ewt = (eWeaponType)Clamp((int)weapon, 0, (int)WEAPONTYPE_TOTALWEAPONS - 1);
	CWeaponInfo *info = CWeaponInfo::GetWeaponInfo(ewt);
	if (shotKind == 0 && (ewt == WEAPONTYPE_UNARMED || ewt == WEAPONTYPE_BASEBALLBAT))
		shotKind = 1;

	if (shotKind == 1) {
		uint16 sfx = (ewt == WEAPONTYPE_BASEBALLBAT) ? SOUND_WEAPON_BAT_ATTACK : SOUND_FIGHT_PUNCH_37;
		DMAudio.PlayOneShot(shooter->m_audioEntityId, sfx, 0.0f);
	} else if (shotKind == 2) {
		CMatrix savedMat = shooter->GetMatrix();
		float hdg = CGeneral::GetRadianAngleBetweenPoints(dir.x, dir.y, 0.0f, 0.0f);
		shooter->GetMatrix().SetRotateZ(hdg);
		if (ewt == WEAPONTYPE_ROCKETLAUNCHER) {
			shooter->GetMatrix().GetForward() = dir;
			shooter->GetMatrix().GetRight() = CrossProduct(dir, CVector(0.0f, 0.0f, 1.0f));
			if (shooter->GetMatrix().GetRight().MagnitudeSqr() < 0.001f)
				shooter->GetMatrix().GetRight() = CVector(1.0f, 0.0f, 0.0f);
			else
				shooter->GetMatrix().GetRight().Normalise();
			shooter->GetMatrix().GetUp() = CrossProduct(shooter->GetMatrix().GetRight(), dir);
		}
		shooter->SetPosition(savedMat.GetPosition());
		suppressLocalHooks = true;
		CProjectileInfo::AddProjectile(shooter, ewt, origin, power);
		suppressLocalHooks = false;
		shooter->GetMatrix() = savedMat;
		shooter->UpdateRwFrame();
	} else if (shotKind == 3) {
		CWeapon::GenerateFlameThrowerParticles(origin, dir);
		DMAudio.PlayOneShot(shooter->m_audioEntityId, SOUND_WEAPON_FLAMETHROWER_FIRE, 0.0f);
	} else {
		CParticle::AddParticle(PARTICLE_GUNFLASH, origin, dir * 0.4f, nil, 0.2f);
		uint16 sfx = SOUND_WEAPON_SHOT_FIRED;
		if (weapon == WEAPONTYPE_UZI || weapon == WEAPONTYPE_UZI_DRIVEBY) sfx = SOUND_WEAPON_UZI_BULLET_ECHO;
		else if (weapon == WEAPONTYPE_AK47) sfx = SOUND_WEAPON_AK47_BULLET_ECHO;
		else if (weapon == WEAPONTYPE_M16) sfx = SOUND_WEAPON_M16_BULLET_ECHO;
		DMAudio.PlayOneShot(shooter->m_audioEntityId, sfx, 1.0f);

		float range = info ? Min(info->m_fRange, 85.0f) : 65.0f;
		CColPoint cp;
		CEntity *hitEnt = nil;
		CWorld::pIgnoreEntity = shooter;
		CWorld::bIncludeDeadPeds = true;
		bool hit = CWorld::ProcessLineOfSight(origin, origin + dir * range, cp, hitEnt, true, true, true, true, false, false, false);
		CWorld::pIgnoreEntity = nil;
		CWorld::bIncludeDeadPeds = false;
		if (hit && hitEnt && hitEnt != shooter) {
			if (hitEnt->IsPed())
				CParticle::AddParticle(PARTICLE_BLOOD, cp.point, CVector(0.0f, 0.0f, 0.04f));
			else if (hitEnt->IsVehicle()) {
				for (int k = 0; k < 4; k++) CParticle::AddParticle(PARTICLE_SPARK, cp.point, cp.normal * 0.05f);
			} else {
				CParticle::AddParticle(PARTICLE_GUNSMOKE, cp.point, cp.normal * 0.05f, nil, 0.15f);
			}
		}
	}
}

void CMPManager::OnPedDamaged(CPed *victim, CEntity *attacker, eWeaponType method, float damage, int pedPiece, uint8 direction)
{
	if (!active || suppressLocalHooks || !victim) return;
	CPlayerPed *local = FindPlayerPed();
	CVehicle *localVeh = FindPlayerVehicle();
	if (attacker != local && (!localVeh || attacker != localVeh)) return;

	uint8 targetKind = 0;
	int32 targetId = FindPeerIdByPed(victim);
	if (targetId > 0) {
		targetKind = 0;
	} else if (!isHost) {
		targetId = FindSyncedPedNetIdByPtr(victim);
		if (targetId < 0) return;
		targetKind = 1;
	} else {
		return;
	}

	uint8 isMelee = (method == WEAPONTYPE_UNARMED || method == WEAPONTYPE_BASEBALLBAT) ? 1 : 0;
	CVector hitPos = victim->GetPosition();
	uint8 pkt[40];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_DAMAGE_EVENT);
	w.Write<uint8>(targetKind);
	w.Write<uint8>((uint8)method);
	w.Write<uint8>((uint8)pedPiece);
	w.Write<uint8>(direction);
	w.Write<uint8>(isMelee);
	w.Write<int32>(targetId);
	w.Write<float>(damage);
	w.Write<float>(hitPos.x); w.Write<float>(hitPos.y); w.Write<float>(hitPos.z);
	if (w.ok) QueuePacket(1, 0, pkt, w.pos);
}

void CMPManager::OnVehicleDamaged(CVehicle *veh, CEntity *attacker, eWeaponType weapon, float damage)
{
	if (!active || suppressLocalHooks || !veh) return;
	if (!MP_IsRemoteControlledVehicle(veh)) return;
	CPlayerPed *local = FindPlayerPed();
	CVehicle *localVeh = FindPlayerVehicle();
	if (attacker != local && (!localVeh || attacker != localVeh)) return;
	MPVehicleNetEntry *e = FindVehEntry(veh);
	if (!e || e->netId <= 0) return;

	CVector pos = veh->GetPosition();
	uint8 pkt[40];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_DAMAGE_EVENT);
	w.Write<uint8>(2);
	w.Write<uint8>((uint8)weapon);
	w.Write<uint8>(0);
	w.Write<uint8>(0);
	w.Write<uint8>(0);
	w.Write<int32>(e->netId);
	w.Write<float>(damage);
	w.Write<float>(pos.x); w.Write<float>(pos.y); w.Write<float>(pos.z);
	if (w.ok) QueuePacket(1, 0, pkt, w.pos);
}

void CMPManager::HandleDamageEventPacket(int fromPeerId, const uint8 *data, int len)
{
	MPBufReader r(data + 1, len - 1);
	uint8 targetKind = r.Read<uint8>();
	uint8 wt = r.Read<uint8>();
	uint8 piece = r.Read<uint8>();
	uint8 dir = r.Read<uint8>();
	uint8 isMelee = r.Read<uint8>();
	int32 targetId = r.Read<int32>();
	float damage = r.Read<float>();
	CVector hitPos;
	hitPos.x = r.Read<float>(); hitPos.y = r.Read<float>(); hitPos.z = r.Read<float>();
	if (!r.ok) return;
	(void)hitPos;

	MPRemotePlayer *rp = GetPeerSlot(fromPeerId);
	CPed *attacker = (rp && rp->ped && IsPoolPedValid(rp->ped)) ? rp->ped : nil;
	eWeaponType ewt = (eWeaponType)Clamp((int)wt, 0, (int)WEAPONTYPE_TOTALWEAPONS - 1);

	suppressLocalHooks = true;
	if (targetKind == 0 && targetId == localPeerId) {
		CPlayerPed *local = FindPlayerPed();
		if (local && !local->DyingOrDead()) {
			if (isMelee && !local->bInVehicle) {
				local->StartFightDefend(dir, HITLEVEL_HIGH, 10);
			}
			local->InflictDamage(attacker, ewt, damage, (ePedPieceTypes)piece, dir);
			CParticle::AddParticle(PARTICLE_BLOOD, local->GetPosition() + CVector(0.0f, 0.0f, 0.35f), CVector(0.0f, 0.0f, 0.04f));
			if (attacker) {
				DMAudio.PlayOneShot(local->m_audioEntityId, isMelee ? SOUND_WEAPON_HIT_PED : SOUND_WEAPON_SHOT_FIRED, 0.0f);
			}
		}
	} else if (targetKind == 1 && isHost) {
		CPed *npc = CPools::GetPed(targetId);
		if (npc && IsPoolPedValid(npc) && npc != FindPlayerPed() && !IsRemotePlayerPed(npc) && !npc->DyingOrDead()) {
			npc->ReactToAttack(attacker ? (CEntity *)attacker : (CEntity *)FindPlayerPed());
			if (isMelee && !npc->bInVehicle) {
				npc->StartFightDefend(dir, HITLEVEL_HIGH, 10);
			}
			npc->InflictDamage(attacker, ewt, damage, (ePedPieceTypes)piece, dir);
			CParticle::AddParticle(PARTICLE_BLOOD, npc->GetPosition() + CVector(0.0f, 0.0f, 0.35f), CVector(0.0f, 0.0f, 0.04f));
		}
	} else if (targetKind == 2) {
		CVehicle *veh = FindVehByNetId(targetId);
		if (veh && ValidateVehiclePtr(veh) && !MP_IsRemoteControlledVehicle(veh)) {
			veh->InflictDamage(attacker, ewt, damage);
		}
	}
	suppressLocalHooks = false;
}

void CMPManager::OnExplosion(CEntity *culprit, int expType, const CVector &pos)
{
	if (!active || gMpSuppressExplosion3) return;
	CPlayerPed *local = FindPlayerPed();
	CVehicle *localVeh = FindPlayerVehicle();
	if (culprit != local && (!localVeh || culprit != localVeh)) return;
	RecordExplosion3(pos, CTimer::GetTimeInMilliseconds());

	uint8 pkt[24];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_EXPLOSION_EVENT);
	w.Write<uint8>((uint8)expType);
	w.Write<float>(pos.x); w.Write<float>(pos.y); w.Write<float>(pos.z);
	if (w.ok) QueuePacket(1, 0, pkt, w.pos);
}

void CMPManager::HandleExplosionEventPacket(int fromPeerId, const uint8 *data, int len)
{
	MPBufReader r(data + 1, len - 1);
	uint8 expType = r.Read<uint8>();
	CVector pos;
	pos.x = r.Read<float>(); pos.y = r.Read<float>(); pos.z = r.Read<float>();
	if (!r.ok) return;

	uint32 now = CTimer::GetTimeInMilliseconds();
	if (IsDuplicateExplosion3(pos, now)) return;
	RecordExplosion3(pos, now);

	MPRemotePlayer *rp = GetPeerSlot(fromPeerId);
	CEntity *attacker = (rp && rp->ped && IsPoolPedValid(rp->ped)) ? (CEntity *)rp->ped : nil;
	gMpSuppressExplosion3 = true;
	CExplosion::AddExplosion(nil, attacker, (eExplosionType)expType, pos, 0);
	gMpSuppressExplosion3 = false;
}

void CMPManager::TickPedsAfterGame(uint32 nowMs)
{
	if (!isHost || (nowMs - lastPedTxMs) < 50)
		return;
	lastPedTxMs = nowMs;

	CPlayerPed *localPed = FindPlayerPed();
	if (!localPed) return;
	CVector lpos = localPed->GetPosition();

	CPool<CPed, CPlayerPed> *pool = CPools::GetPedPool();
	int sz = pool->GetSize();
	if (sz <= 0) return;

	// Header 2 + count * 30 bytes (14 * 30 + 2 = 422 <= 512)
	uint8 pkt[MP_MAX_PKT_BYTES];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_PED_SYNC);
	w.Write<uint8>((uint8)0); // placeholder count
	uint8 count = 0;

	for (int step = 0; step < sz && count < 14; step++) {
		int i = (int)((pedScanCursor + (uint32)step) % (uint32)sz);
		CPed *p = pool->GetSlot(i);
		if (!p || p == localPed || IsRemotePlayerPed(p) || p->bInVehicle)
			continue;
		bool nearAny = ((p->GetPosition() - lpos).MagnitudeSqr2D() < SQR(70.0f)) || IsNearAnyPlayer2D(p->GetPosition(), 65.0f);
		if (!nearAny && p->CharCreatedBy != MISSION_CHAR)
			continue;

		int32 netId = CPools::GetPedRef(p);
		uint8 pflags = (p->DyingOrDead() ? 1 : 0) | ((p->CharCreatedBy == MISSION_CHAR) ? 2 : 0) | (p->bIsDucking ? 4 : 0);
		CVector pos = p->GetPosition();
		int16 vx16 = (int16)Clamp((int32)(p->m_vecMoveSpeed.x * 1000.0f), -32000, 32000);
		int16 vy16 = (int16)Clamp((int32)(p->m_vecMoveSpeed.y * 1000.0f), -32000, 32000);

		w.Write<int32>(netId);
		w.Write<int16>((int16)p->m_modelIndex);
		w.Write<uint8>((uint8)p->m_nPedType);
		w.Write<uint8>(pflags);
		w.Write<float>(pos.x); w.Write<float>(pos.y); w.Write<float>(pos.z);
		w.Write<int16>(vx16);
		w.Write<int16>(vy16);
		w.Write<float>(p->m_fRotationCur);
		w.Write<uint8>((uint8)Clamp(p->m_fHealth, 0.0f, 255.0f));
		w.Write<uint8>((uint8)p->GetWeapon()->m_eWeaponType);
		w.Write<uint8>((uint8)p->m_nMoveState);
		count++;
	}
	pedScanCursor = (pedScanCursor + 9) % (uint32)sz;
	if (count == 0) return;

	pkt[1] = count;
	if (w.ok) QueuePacket(0, 0, pkt, w.pos);
}

void CMPManager::HandlePedSyncPacket(int fromPeerId, const uint8 *data, int len)
{
	if (isHost) return;
	MPBufReader r(data + 1, len - 1);
	uint8 count = r.Read<uint8>();
	if (!r.ok || count == 0 || count > 16) return;

	uint32 nowMs = CTimer::GetTimeInMilliseconds();
	CVector lpos = FindPlayerCentreOfWorld(CWorld::PlayerInFocus);
	for (uint8 i = 0; i < count; i++) {
		int32 netId = r.Read<int32>();
		int16 mi = r.Read<int16>();
		uint8 pedType = r.Read<uint8>();
		uint8 flags = r.Read<uint8>();
		CVector pos;
		pos.x = r.Read<float>(); pos.y = r.Read<float>(); pos.z = r.Read<float>();
		int16 vx16 = r.Read<int16>();
		int16 vy16 = r.Read<int16>();
		float heading = r.Read<float>();
		uint8 hp = r.Read<uint8>();
		uint8 weapon = r.Read<uint8>();
		uint8 anim = r.Read<uint8>();
		if (!r.ok) break;
		if ((pos - lpos).MagnitudeSqr2D() > SQR(95.0f))
			continue;

		MPPedNetEntry *slot = nil;
		MPPedNetEntry *freeSlot = nil;
		MPPedNetEntry *deadSlot = nil;
		for (int k = 0; k < MP_MAX_PED_MAP; k++) {
			if (pedMap[k].used && pedMap[k].netId == netId) { slot = &pedMap[k]; break; }
			if (!pedMap[k].used && !freeSlot) freeSlot = &pedMap[k];
			if (pedMap[k].used && (pedMap[k].targetFlags & 1) && !deadSlot) deadSlot = &pedMap[k];
		}
		if (!slot) slot = freeSlot ? freeSlot : deadSlot;
		if (!slot) continue;

		bool fresh = !slot->used || slot->netId != netId;
		if (fresh && slot->ped && IsPoolPedValid(slot->ped)) {
			CWorld::Remove(slot->ped);
			delete slot->ped;
			slot->ped = nil;
		}
		if (!slot->ped && mi >= 0 && mi <= MI_LAST_PED && !(flags & 1)) {
			CStreaming::RequestModel(mi, STREAMFLAGS_DEPENDENCY);
			if (CStreaming::ms_aInfoForModel[mi].m_loadState == STREAMSTATE_LOADED) {
				ePedType safeType = (pedType == PEDTYPE_CIVFEMALE) ? PEDTYPE_CIVFEMALE : PEDTYPE_CIVMALE;
				CCivilianPed *np = new CCivilianPed(safeType, (uint32)mi);
				if (np) {
					np->CharCreatedBy = MISSION_CHAR;
					np->bRespondsToThreats = false;
					np->bStreamingDontDelete = true;
					np->SetPosition(pos);
					CWorld::Add(np);
					slot->ped = np;
				}
			}
		}
		slot->used = true;
		slot->netId = netId;
		slot->ownerPeer = (uint8)fromPeerId;
		slot->targetPos = pos;
		slot->targetVel = CVector((float)vx16 * 0.001f, (float)vy16 * 0.001f, 0.0f);
		slot->targetHeading = heading;
		slot->targetHealth = hp;
		slot->targetWeapon = weapon;
		slot->targetAnim = anim;
		slot->targetFlags = flags;
		if (fresh) {
			slot->lastHealth = hp;
			slot->prevFlags = flags;
		}
		if (fresh || (slot->pos - pos).MagnitudeSqr() > SQR(15.0f)) {
			slot->pos = pos;
			slot->heading = heading;
		}
		slot->hasTarget = true;
		slot->lastRxMs = nowMs;
	}
}

void CMPManager::InterpolateSyncedPeds(uint32 nowMs)
{
	if (isHost) return;
	for (int i = 0; i < MP_MAX_PED_MAP; i++) {
		MPPedNetEntry &sp = pedMap[i];
		if (!sp.used) continue;
		if (sp.ped && !IsPoolPedValid(sp.ped)) {
			sp.ped = nil;
		}
		if (nowMs - sp.lastRxMs > 3500) {
			if (sp.ped) {
				if (sp.ped->bInVehicle && sp.ped->m_pMyVehicle && ValidateVehiclePtr(sp.ped->m_pMyVehicle)) {
					if (sp.ped->m_pMyVehicle->pDriver == sp.ped) sp.ped->m_pMyVehicle->RemoveDriver();
					else sp.ped->m_pMyVehicle->RemovePassenger(sp.ped);
					sp.ped->bInVehicle = false;
					sp.ped->m_pMyVehicle = nil;
				}
				CWorld::Remove(sp.ped);
				delete sp.ped;
			}
			memset(&sp, 0, sizeof(sp));
			continue;
		}
		if (!sp.ped || !sp.hasTarget) continue;
		CPed *p = sp.ped;
		if (sp.targetFlags & 1) {
			if (!(sp.prevFlags & 1) && !p->DyingOrDead()) {
				p->m_fHealth = 0.0f;
				p->SetDie(ANIM_STD_KO_FRONT, 4.0f, 0.0f);
			} else if (!p->DyingOrDead()) {
				p->m_fHealth = 0.0f;
				p->SetDead();
			}
			sp.lastHealth = 0;
			sp.prevFlags = sp.targetFlags;
			continue;
		}

		if (sp.targetHealth < sp.lastHealth && sp.lastHealth > 0) {
			p->StartFightDefend(0, HITLEVEL_HIGH, 10);
			CParticle::AddParticle(PARTICLE_BLOOD, p->GetPosition() + CVector(0.0f, 0.0f, 0.35f), CVector(0.0f, 0.0f, 0.04f));
		}
		sp.lastHealth = sp.targetHealth;
		sp.prevFlags = sp.targetFlags;

		float dtExtrap = Min((float)(nowMs - sp.lastRxMs) * 0.001f, 0.12f);
		CVector predPos = sp.targetPos + sp.targetVel * (dtExtrap * 50.0f);
		if ((predPos - sp.pos).MagnitudeSqr() > SQR(12.0f)) {
			sp.pos = predPos;
		} else {
			sp.pos = sp.pos + (predPos - sp.pos) * 0.35f;
		}
		sp.heading = LerpAngle(sp.heading, sp.targetHeading, 0.38f);

		p->bUsesCollision = true;
		p->SetPosition(sp.pos);
		p->m_vecMoveSpeed = sp.targetVel;
		p->m_fRotationCur = sp.heading;
		p->m_fRotationDest = sp.heading;
		p->SetHeading(sp.heading);
		p->UpdateRwFrame();
		p->m_fHealth = Clamp((float)sp.targetHealth, 1.0f, 100.0f);
		p->bIsDucking = !!(sp.targetFlags & 4);

		if (sp.targetWeapon < WEAPONTYPE_LAST_WEAPONTYPE && p->GetWeapon()->m_eWeaponType != (eWeaponType)sp.targetWeapon) {
			p->GiveWeapon((eWeaponType)sp.targetWeapon, 100);
			p->SetCurrentWeapon((eWeaponType)sp.targetWeapon);
		}
		eMoveState ms = (eMoveState)sp.targetAnim;
		if (ms == PEDMOVE_NONE) ms = (sp.targetVel.Magnitude2D() > 0.005f) ? PEDMOVE_WALK : PEDMOVE_STILL;
		p->m_nMoveState = ms;
		if (sp.targetFlags & 4) {
			p->SetDuck(200);
		} else if (ms == PEDMOVE_SPRINT) {
			CAnimManager::BlendAnimation(p->GetClump(), p->m_animGroup, ANIM_STD_RUNFAST, 4.0f);
		} else if (ms == PEDMOVE_RUN) {
			CAnimManager::BlendAnimation(p->GetClump(), p->m_animGroup, ANIM_STD_RUN, 4.0f);
		} else if (ms == PEDMOVE_WALK) {
			CAnimManager::BlendAnimation(p->GetClump(), p->m_animGroup, ANIM_STD_WALK, 4.0f);
		} else {
			CAnimManager::BlendAnimation(p->GetClump(), p->m_animGroup, ANIM_STD_IDLE, 4.0f);
		}
	}
}

bool MP_IsRemotePlayerPed(const CPed *ped) { return gMP.IsRemotePlayerPed(ped); }
void MP_OnShotFired(eWeaponType weapon, const CVector &origin, const CVector &dir, CEntity *hitEnt, float dmg, bool isDriveBy, uint8 shotKind, float power)
{
	gMP.OnShotFired(weapon, origin, dir, hitEnt, dmg, isDriveBy, shotKind, power);
}
void MP_OnPedDamaged(CPed *victim, CEntity *attacker, eWeaponType method, float damage, int pedPiece, uint8 direction)
{
	gMP.OnPedDamaged(victim, attacker, method, damage, pedPiece, direction);
}
void MP_OnVehicleDamaged(CVehicle *veh, CEntity *attacker, eWeaponType weapon, float damage)
{
	gMP.OnVehicleDamaged(veh, attacker, weapon, damage);
}
void MP_OnExplosion(CEntity *culprit, int expType, const CVector &pos)
{
	gMP.OnExplosion(culprit, expType, pos);
}
bool MP_ShouldSuppressExplosionDamage(CEntity *victim, CEntity *attacker, eWeaponType method)
{
	if (!gMP.active || gMP.suppressLocalHooks || method != WEAPONTYPE_EXPLOSION) return false;
	if (!victim || !attacker || !attacker->IsPed()) return false;
	if (!gMP.IsRemotePlayerPed((const CPed *)attacker)) return false;
	if (victim == FindPlayerPed()) return true;
	if (!gMP.isHost && victim->IsPed() && gMP.IsSyncedPed((const CPed *)victim)) return true;
	return false;
}

#endif // MULTIPLAYER_COOP
