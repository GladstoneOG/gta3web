#include "common.h"
#ifdef MULTIPLAYER_COOP

#include "mp_core.h"
#include "World.h"
#include "Pools.h"
#include "Vehicle.h"
#include "Automobile.h"
#include "Boat.h"
#include "ModelInfo.h"
#include "ModelIndices.h"
#include "Streaming.h"
#include "PlayerPed.h"
#include "CivilianPed.h"
#include "Ped.h"
#include "Pad.h"
#include "Timer.h"
#include "Weapon.h"
#include "Camera.h"
#include "Explosion.h"
#include "AnimManager.h"
#include "AnimBlendAssociation.h"
#include "RpAnimBlend.h"
#include "Quaternion.h"
#include "FileLoader.h"
#include "DMAudio.h"

namespace {

inline float WrapAngleDelta(float a)
{
	while (a > PI) a -= TWOPI;
	while (a < -PI) a += TWOPI;
	return a;
}

void QuatFromMatrix(const CMatrix &mat, float q[4])
{
	RwMatrix rwMat;
	const CMatrix &m = mat;
	rwMat.right.x = m.rx; rwMat.right.y = m.ry; rwMat.right.z = m.rz;
	rwMat.up.x    = m.fx; rwMat.up.y    = m.fy; rwMat.up.z    = m.fz;
	rwMat.at.x    = m.ux; rwMat.at.y    = m.uy; rwMat.at.z    = m.uz;
	rwMat.pos.x   = 0.0f; rwMat.pos.y   = 0.0f; rwMat.pos.z   = 0.0f;
	CQuaternion cq;
	cq.Set(rwMat);
	cq.Normalise();
	q[0] = cq.x; q[1] = cq.y; q[2] = cq.z; q[3] = cq.w;
}

void MatrixFromQuat(const float q[4], CMatrix &mat)
{
	CQuaternion cq(q[0], q[1], q[2], q[3]);
	cq.Normalise();
	RwMatrix rwMat;
	cq.Get(&rwMat);
	mat.rx = rwMat.right.x; mat.ry = rwMat.right.y; mat.rz = rwMat.right.z;
	mat.fx = rwMat.up.x;    mat.fy = rwMat.up.y;    mat.fz = rwMat.up.z;
	mat.ux = rwMat.at.x;    mat.uy = rwMat.at.y;    mat.uz = rwMat.at.z;
}

void SlerpQuat(const float qa[4], const float qb[4], float t, float out[4])
{
	CQuaternion q1(qa[0], qa[1], qa[2], qa[3]);
	CQuaternion q2(qb[0], qb[1], qb[2], qb[3]);
	float dot = DotProduct(q1, q2);
	if (dot < 0.0f) {
		q2 = -q2;
		dot = -dot;
	}
	if (dot > 0.9995f) {
		CQuaternion r = q1 * (1.0f - t) + q2 * t;
		r.Normalise();
		out[0] = r.x; out[1] = r.y; out[2] = r.z; out[3] = r.w;
		return;
	}
	float theta = acosf(Clamp(dot, -1.0f, 1.0f));
	float invSin = 1.0f / Sin(theta);
	CQuaternion r;
	r.Slerp(q1, q2, theta, invSin, t);
	r.Normalise();
	out[0] = r.x; out[1] = r.y; out[2] = r.z; out[3] = r.w;
}

bool IsPoolVehicleValid(CVehicle *veh)
{
	if (!veh)
		return false;
	CPool<CVehicle, CAutomobile> *pool = CPools::GetVehiclePool();
	if (!pool)
		return false;
	int sz = pool->GetSize();
	for (int i = 0; i < sz; i++) {
		if (pool->GetSlot(i) == veh)
			return true;
	}
	return false;
}

bool IsPoolPedValidLocal(CPed *ped)
{
	if (!ped) return false;
	CPool<CPed, CPlayerPed> *pool = CPools::GetPedPool();
	if (!pool) return false;
	for (int i = 0; i < pool->GetSize(); i++) {
		if (pool->GetSlot(i) == ped) return true;
	}
	return false;
}

void CleanupEntryNpcDriver(MPVehicleNetEntry &e, CVehicle *veh)
{
	if (!e.npcDriverPed) return;
	CPed *npc = e.npcDriverPed;
	e.npcDriverPed = nil;
	if (!IsPoolPedValidLocal(npc)) return;
	if (npc->bInVehicle && npc->m_pMyVehicle == veh && (!veh || !IsPoolVehicleValid(veh) || veh->pDriver == npc)) {
		if (veh && IsPoolVehicleValid(veh) && veh->pDriver == npc)
			veh->RemoveDriver();
		npc->RemoveInCarAnims();
		npc->bInVehicle = false;
		npc->m_pMyVehicle = nil;
		CWorld::Remove(npc);
		delete npc;
	} else {
		npc->CharCreatedBy = RANDOM_CHAR;
		npc->bStreamingDontDelete = false;
	}
}

} // namespace

MPVehicleNetEntry *CMPManager::FindVehEntry(CVehicle *veh)
{
	if (!veh) return nil;
	for (int i = 0; i < MP_MAX_VEH_MAP; i++) {
		if (vehMap[i].used && vehMap[i].veh == veh)
			return &vehMap[i];
	}
	return nil;
}

MPVehicleNetEntry *CMPManager::FindVehEntryByNetId(int32 netId)
{
	if (netId <= 0) return nil;
	for (int i = 0; i < MP_MAX_VEH_MAP; i++) {
		if (vehMap[i].used && vehMap[i].netId == netId)
			return &vehMap[i];
	}
	return nil;
}

CVehicle *CMPManager::FindVehByNetId(int32 netId)
{
	MPVehicleNetEntry *e = FindVehEntryByNetId(netId);
	return (e && e->veh && IsPoolVehicleValid(e->veh)) ? e->veh : nil;
}

int32 CMPManager::AssignOrGetVehNetId(CVehicle *veh, uint8 ownerPeer)
{
	if (!veh) return 0;
	if (MPVehicleNetEntry *e = FindVehEntry(veh))
		return e->netId;

	for (int i = 0; i < MP_MAX_VEH_MAP; i++) {
		if (!vehMap[i].used) {
			MPVehicleNetEntry &n = vehMap[i];
			memset(&n, 0, sizeof(n));
			n.used = true;
			n.veh = veh;
			n.netId = (int32)(nextNetId++);
			n.modelIndex = veh->GetModelIndex();
			n.ownerPeer = ownerPeer ? ownerPeer : (uint8)(isHost ? 1 : localPeerId);
			return n.netId;
		}
	}
	return 0;
}

void CMPManager::CleanupStaleVehicles()
{
	CVector focus = FindPlayerCentreOfWorld(CWorld::PlayerInFocus);
	for (int i = 0; i < MP_MAX_VEH_MAP; i++) {
		MPVehicleNetEntry &e = vehMap[i];
		if (!e.used) continue;
		bool valid = IsPoolVehicleValid(e.veh);
		bool hostCullDistant = false;
		if (valid && isHost && e.ownerPeer == (uint8)localPeerId &&
		    e.veh->VehicleCreatedBy != MISSION_VEHICLE && !e.veh->bHasBeenOwnedByPlayer &&
		    !IsVehicleOccupiedByPlayer(e.veh)) {
			if ((e.veh->GetPosition() - focus).MagnitudeSqr2D() > SQR(185.0f) && !IsNearAnyPlayer2D(e.veh->GetPosition(), 185.0f)) {
				hostCullDistant = true;
			}
		}
		if (!valid || hostCullDistant) {
			if (active && e.ownerPeer == (uint8)localPeerId && e.netId > 0) {
				uint8 pkt[32];
				MPBufWriter w(pkt, sizeof(pkt));
				w.Write<uint8>(PKT_VEHICLE_SYNC);
				w.Write<int32>(e.netId);
				w.Write<int16>(e.modelIndex);
				w.Write<uint16>(MP_VFLAG_REMOVED);
				if (w.ok) QueuePacket(1, 0, pkt, w.pos);
			}
			CleanupEntryNpcDriver(e, e.veh);
			memset(&e, 0, sizeof(e));
		}
	}
}

static bool IsDrivenByRemotePlayer(CVehicle *veh, uint8 &outDriverPeer)
{
	outDriverPeer = 0;
	if (!veh)
		return false;
	if (veh->pDriver) {
		for (int i = 0; i < MP_MAX_PEERS; i++) {
			if (gMP.peers[i].active && gMP.peers[i].peerId != gMP.localPeerId && gMP.peers[i].ped == veh->pDriver) {
				outDriverPeer = (uint8)gMP.peers[i].peerId;
				return true;
			}
		}
	}
	MPVehicleNetEntry *e = gMP.FindVehEntry(veh);
	if (e && e->driverPeer != 0 && e->driverPeer != (uint8)gMP.localPeerId && (CTimer::GetTimeInMilliseconds() - e->lastRxMs) < 2500) {
		outDriverPeer = e->driverPeer;
		return true;
	}
	return false;
}

static uint16 CollectVehicleFlags(CVehicle *veh)
{
	uint16 f = 0;
	if (veh->bEngineOn) f |= MP_VFLAG_ENGINE_ON;
	if (veh->m_bSirenOrAlarm) f |= MP_VFLAG_SIREN_ON;
	if (veh->bLightsOn) f |= MP_VFLAG_LIGHTS_ON;
	if (veh->m_nDoorLock != CARLOCK_UNLOCKED && veh->m_nDoorLock != CARLOCK_NOT_USED) f |= MP_VFLAG_LOCKED;
	if (veh->GetModelIndex() == MI_RCBANDIT) f |= MP_VFLAG_IS_RC;
	if (veh->VehicleCreatedBy == MISSION_VEHICLE) f |= MP_VFLAG_IS_MISSION;
	if (veh->GetStatus() == STATUS_WRECKED) f |= MP_VFLAG_WRECKED;
	if (veh->bIsHandbrakeOn) f |= MP_VFLAG_HANDBRAKE;
	if (veh->m_nCarHornTimer > 0) f |= MP_VFLAG_HORN;
	return f;
}

static void SendVehicleSyncEntry(MPVehicleNetEntry *entry, CVehicle *veh, CPed *localPed, uint32 nowMs)
{
	uint8 pkt[128];
	MPBufWriter w(pkt, sizeof(pkt));
	w.Write<uint8>(PKT_VEHICLE_SYNC);
	w.Write<int32>(entry->netId);
	w.Write<int16>(veh->GetModelIndex());
	w.Write<uint16>(CollectVehicleFlags(veh));
	w.Write<uint8>(entry->driverPeer);
	w.Write<uint8>(veh->m_currentColour1);
	w.Write<uint8>(veh->m_currentColour2);
	uint8 bomb = veh->IsCar() ? (uint8)((CAutomobile *)veh)->m_bombType : 0;
	w.Write<uint8>(bomb);

	CVector pos = veh->GetPosition();
	w.Write<float>(pos.x); w.Write<float>(pos.y); w.Write<float>(pos.z);

	float q[4];
	QuatFromMatrix(veh->GetMatrix(), q);
	w.Write<float>(q[0]); w.Write<float>(q[1]); w.Write<float>(q[2]); w.Write<float>(q[3]);

	w.Write<float>(veh->m_vecMoveSpeed.x); w.Write<float>(veh->m_vecMoveSpeed.y); w.Write<float>(veh->m_vecMoveSpeed.z);
	w.Write<float>(veh->m_vecTurnSpeed.x); w.Write<float>(veh->m_vecTurnSpeed.y); w.Write<float>(veh->m_vecTurnSpeed.z);
	w.Write<float>(veh->m_fSteerAngle);
	w.Write<float>(veh->m_fGasPedal);
	w.Write<float>(veh->m_fBrakePedal);
	w.Write<float>(veh->m_fHealth);

	uint16 npcMi = (veh->pDriver && veh->pDriver != localPed && !gMP.IsRemotePlayerPed(veh->pDriver) && IsPoolPedValidLocal(veh->pDriver))
		? (uint16)Clamp((int32)veh->pDriver->m_modelIndex, 1, 65535) : 0;
	w.Write<uint16>(npcMi);

	if (w.ok) {
		gMP.QueuePacket(0, 0, pkt, w.pos);
		entry->lastTxMs = nowMs;
	}
}

void CMPManager::TickVehiclesAfterGame(uint32 nowMs)
{
	CPlayerPed *localPed = FindPlayerPed();
	CVehicle *localVeh = localPed && localPed->bInVehicle ? localPed->m_pMyVehicle : nil;

	// Preserve synced vehicle lights, brake/gas pedals, handbrake, and wheel states before RenderEffects
	for (int i = 0; i < MP_MAX_VEH_MAP; i++) {
		MPVehicleNetEntry &e = vehMap[i];
		if (!e.used || !e.hasTarget || !e.veh || !IsPoolVehicleValid(e.veh)) continue;
		if ((localVeh == e.veh && e.veh->pDriver == localPed) || (e.ownerPeer == (uint8)localPeerId && e.driverPeer == (uint8)localPeerId)) continue;
		CVehicle *v = e.veh;
		v->m_fSteerAngle = e.targetSteer;
		v->m_fGasPedal = e.targetGas;
		v->m_fBrakePedal = e.targetBrake;
		v->bEngineOn = !!(e.targetFlags & MP_VFLAG_ENGINE_ON);
		v->m_bSirenOrAlarm = !!(e.targetFlags & MP_VFLAG_SIREN_ON);
		v->bLightsOn = !!(e.targetFlags & MP_VFLAG_LIGHTS_ON);
		v->bIsHandbrakeOn = !!(e.targetFlags & MP_VFLAG_HANDBRAKE);
		v->m_nCarHornTimer = (e.targetFlags & MP_VFLAG_HORN) ? 1 : 0;
		if (v->IsCar() && !v->bIsHandbrakeOn && v->m_fBrakePedal <= 0.05f) {
			CAutomobile *car = (CAutomobile *)v;
			for (int w = 0; w < 4; w++) {
				if (car->m_aWheelState[w] == WHEEL_STATE_FIXED || car->m_aWheelState[w] == WHEEL_STATE_SKIDDING)
					car->m_aWheelState[w] = WHEEL_STATE_NORMAL;
			}
		}
	}

	if (nowMs - lastVehTxMs < 25)
		return;
	lastVehTxMs = nowMs;

	CVector localPos = FindPlayerCentreOfWorld(CWorld::PlayerInFocus);

	CPool<CVehicle, CAutomobile> *pool = CPools::GetVehiclePool();
	int sz = pool->GetSize();
	if (sz <= 0) return;

	bool sentSlot[MP_MAX_VEH_MAP];
	memset(sentSlot, 0, sizeof(sentSlot));
	int sentCount = 0;

	// Pass 1: priority pass for driven, moving, or mission vehicles
	for (int i = 0; i < sz && sentCount < 28; i++) {
		CVehicle *veh = pool->GetSlot(i);
		if (!veh) continue;

		bool iAmDriver = (localVeh == veh && veh->pDriver == localPed)
			|| (localPed && localPed->m_pMyVehicle == veh && (localPed->m_nPedState == PED_ENTER_CAR || localPed->m_nPedState == PED_CARJACK || localPed->m_nPedState == PED_EXIT_CAR) && (localPed->m_objective == OBJECTIVE_ENTER_CAR_AS_DRIVER || veh->pDriver == localPed))
			|| (CWorld::Players[CWorld::PlayerInFocus].m_pRemoteVehicle == veh);
		uint8 remoteDriver = 0;
		bool remoteDriven = IsDrivenByRemotePlayer(veh, remoteDriver);

		MPVehicleNetEntry *entry = FindVehEntry(veh);
		bool iOwn = false;
		if (iAmDriver) iOwn = true;
		else if (!remoteDriven) {
			if (isHost) {
				if ((veh->GetPosition() - localPos).MagnitudeSqr2D() <= SQR(135.0f) || veh->VehicleCreatedBy == MISSION_VEHICLE || IsNearAnyPlayer2D(veh->GetPosition(), 135.0f))
					iOwn = true;
			} else if (entry && entry->ownerPeer == (uint8)localPeerId) {
				iOwn = true;
			}
		}
		if (!iOwn) continue;

		bool priority = iAmDriver || veh->VehicleCreatedBy == MISSION_VEHICLE || veh->m_vecMoveSpeed.MagnitudeSqr() > 0.0001f;
		if (!priority) continue;

		if (!entry) {
			int32 nid = AssignOrGetVehNetId(veh, (uint8)localPeerId);
			entry = FindVehEntryByNetId(nid);
		}
		if (!entry) continue;
		int eIdx = (int)(entry - vehMap);
		if (eIdx >= 0 && eIdx < MP_MAX_VEH_MAP && sentSlot[eIdx]) continue;

		if (iAmDriver) {
			entry->ownerPeer = (uint8)localPeerId;
			entry->driverPeer = (uint8)localPeerId;
			entry->releaseOwnerAtMs = nowMs + 1200;
		} else if (entry->driverPeer == (uint8)localPeerId) {
			entry->driverPeer = 0;
		}

		SendVehicleSyncEntry(entry, veh, localPed, nowMs);
		if (eIdx >= 0 && eIdx < MP_MAX_VEH_MAP) sentSlot[eIdx] = true;
		sentCount++;

		if (!isHost && !iAmDriver && entry->releaseOwnerAtMs != 0 && nowMs > entry->releaseOwnerAtMs) {
			entry->ownerPeer = 1;
			entry->releaseOwnerAtMs = 0;
		}
	}

	// Pass 2: round-robin parked/stationary vehicles
	for (int step = 0; step < sz && sentCount < 28; step++) {
		int i = (int)((vehScanCursor + (uint32)step) % (uint32)sz);
		CVehicle *veh = pool->GetSlot(i);
		if (!veh) continue;

		uint8 remoteDriver = 0;
		if (IsDrivenByRemotePlayer(veh, remoteDriver)) continue;

		MPVehicleNetEntry *entry = FindVehEntry(veh);
		bool iOwn = false;
		if (isHost) {
			if ((veh->GetPosition() - localPos).MagnitudeSqr2D() <= SQR(135.0f) || veh->VehicleCreatedBy == MISSION_VEHICLE || IsNearAnyPlayer2D(veh->GetPosition(), 135.0f))
				iOwn = true;
		} else if (entry && entry->ownerPeer == (uint8)localPeerId) {
			iOwn = true;
		}
		if (!iOwn) continue;

		if (!entry) {
			int32 nid = AssignOrGetVehNetId(veh, (uint8)localPeerId);
			entry = FindVehEntryByNetId(nid);
		}
		if (!entry) continue;
		int eIdx = (int)(entry - vehMap);
		if (eIdx >= 0 && eIdx < MP_MAX_VEH_MAP && sentSlot[eIdx]) continue;

		if (entry->driverPeer == (uint8)localPeerId && veh->pDriver != localPed)
			entry->driverPeer = 0;

		SendVehicleSyncEntry(entry, veh, localPed, nowMs);
		if (eIdx >= 0 && eIdx < MP_MAX_VEH_MAP) sentSlot[eIdx] = true;
		sentCount++;

		if (!isHost && entry->releaseOwnerAtMs != 0 && nowMs > entry->releaseOwnerAtMs) {
			entry->ownerPeer = 1;
			entry->releaseOwnerAtMs = 0;
		}
	}
	vehScanCursor = (vehScanCursor + 9) % (uint32)sz;
}

void CMPManager::HandleVehicleSyncPacket(int fromPeerId, const uint8 *data, int len)
{
	MPBufReader r(data + 1, len - 1);
	int32 netId = r.Read<int32>();
	int16 modelIdx = r.Read<int16>();
	uint16 flags = r.Read<uint16>();
	if (!r.ok || netId <= 0)
		return;

	if (flags & MP_VFLAG_REMOVED) {
		MPVehicleNetEntry *e = FindVehEntryByNetId(netId);
		if (e) {
			if (e->veh && IsPoolVehicleValid(e->veh) && !IsVehicleOccupiedByPlayer(e->veh)) {
				CleanupEntryNpcDriver(*e, e->veh);
				CWorld::Remove(e->veh);
				delete e->veh;
				memset(e, 0, sizeof(*e));
			} else if (!e->veh) {
				memset(e, 0, sizeof(*e));
			}
		}
		return;
	}

	uint8 driverPeer = r.Read<uint8>();
	uint8 col1 = r.Read<uint8>();
	uint8 col2 = r.Read<uint8>();
	uint8 bombType = r.Read<uint8>();

	CVector pos;
	pos.x = r.Read<float>(); pos.y = r.Read<float>(); pos.z = r.Read<float>();
	float q[4];
	q[0] = r.Read<float>(); q[1] = r.Read<float>(); q[2] = r.Read<float>(); q[3] = r.Read<float>();
	CVector vel, turn;
	vel.x = r.Read<float>(); vel.y = r.Read<float>(); vel.z = r.Read<float>();
	turn.x = r.Read<float>(); turn.y = r.Read<float>(); turn.z = r.Read<float>();
	float steer = r.Read<float>();
	float gas = r.Read<float>();
	float brake = r.Read<float>();
	float hp = r.Read<float>();
	if (!r.ok)
		return;
	uint16 npcDriverMi = (r.pos + 2 <= len - 1) ? r.Read<uint16>() : 0;

	CPlayerPed *localPed = FindPlayerPed();
	CVehicle *localDrivenVeh = (localPed && localPed->bInVehicle && localPed->m_pMyVehicle && localPed->m_pMyVehicle->pDriver == localPed)
		? localPed->m_pMyVehicle : nil;

	MPVehicleNetEntry *entry = FindVehEntryByNetId(netId);
	CVehicle *veh = entry && IsPoolVehicleValid(entry->veh) ? entry->veh : nil;

	if (!veh) {
		CVector localPos = FindPlayerCentreOfWorld(CWorld::PlayerInFocus);
		if ((pos - localPos).MagnitudeSqr2D() > SQR(220.0f) && driverPeer == 0 && !(flags & MP_VFLAG_IS_MISSION))
			return;
		veh = SpawnVehicleLocal(modelIdx, pos, 0.0f, (uint8)fromPeerId);
		if (!veh)
			return;
		veh->VehicleCreatedBy = MISSION_VEHICLE;
		if (entry) {
			entry->veh = veh;
		} else {
			for (int i = 0; i < MP_MAX_VEH_MAP; i++) {
				if (!vehMap[i].used) {
					entry = &vehMap[i];
					memset(entry, 0, sizeof(*entry));
					entry->used = true;
					entry->veh = veh;
					entry->netId = netId;
					break;
				}
			}
		}
		if (!entry) return;
		entry->prevPos = pos;
		memcpy(entry->prevQuat, q, sizeof(q));
		veh->SetPosition(pos);
		MatrixFromQuat(q, veh->GetMatrix());
		veh->GetMatrix().UpdateRW();
		veh->UpdateRwFrame();
	}

	if (veh == localDrivenVeh)
		return;

	entry->modelIndex = modelIdx;
	entry->ownerPeer = (uint8)fromPeerId;
	entry->driverPeer = driverPeer;
	entry->npcDriverModel = npcDriverMi;
	entry->lastRxMs = CTimer::GetTimeInMilliseconds();
	entry->prevPos = veh->GetPosition();
	QuatFromMatrix(veh->GetMatrix(), entry->prevQuat);
	entry->targetPos = pos;
	entry->targetVel = vel;
	entry->targetTurn = turn;
	memcpy(entry->targetQuat, q, sizeof(q));
	entry->targetSteer = steer;
	entry->targetGas = gas;
	entry->targetBrake = brake;
	entry->targetHealth = hp;
	entry->targetFlags = flags;
	entry->col1 = col1;
	entry->col2 = col2;
	entry->bombType = bombType;
	entry->hasTarget = true;

	if (veh->m_currentColour1 != col1 || veh->m_currentColour2 != col2) {
		veh->m_currentColour1 = col1;
		veh->m_currentColour2 = col2;
	}
	if (veh->IsCar()) {
		CAutomobile *ac = (CAutomobile *)veh;
		if (ac->m_bombType != (bombType & 7))
			ac->m_bombType = bombType & 7;
	}
}

void CMPManager::InterpolateRemoteVehicles(uint32 nowMs)
{
	CPlayerPed *localPed = FindPlayerPed();
	CVehicle *localVeh = (localPed && localPed->bInVehicle) ? localPed->m_pMyVehicle : nil;

	for (int i = 0; i < MP_MAX_VEH_MAP; i++) {
		MPVehicleNetEntry &e = vehMap[i];
		if (!e.used || !e.veh || !IsPoolVehicleValid(e.veh))
			continue;
		CVehicle *veh = e.veh;
		if ((localVeh == veh && veh->pDriver == localPed) || (e.ownerPeer == (uint8)localPeerId && e.driverPeer == (uint8)localPeerId)) {
			CleanupEntryNpcDriver(e, veh);
			continue;
		}
		if (!e.hasTarget)
			continue;

		uint32 age = nowMs - e.lastRxMs;
		uint32 expireMs = isHost ? 12000u : 5500u;
		if (age > expireMs) {
			e.hasTarget = false;
			if (!isHost && !IsVehicleOccupiedByPlayer(veh)) {
				CleanupEntryNpcDriver(e, veh);
				CWorld::Remove(veh);
				delete veh;
				memset(&e, 0, sizeof(e));
			}
			continue;
		}

		float dtExtrap = Min((float)age * 0.001f, 0.12f);
		CVector predPos = e.targetPos + e.targetVel * (dtExtrap * 50.0f);
		CVector curPos = veh->GetPosition();
		float distSq = (predPos - curPos).MagnitudeSqr();

		if (distSq > SQR(14.0f)) {
			veh->SetPosition(predPos);
		} else {
			float blend = (e.driverPeer != 0) ? 0.44f : 0.30f;
			veh->SetPosition(curPos + (predPos - curPos) * blend);
		}

		float curQ[4], smoothQ[4];
		QuatFromMatrix(veh->GetMatrix(), curQ);
		SlerpQuat(curQ, e.targetQuat, 0.42f, smoothQ);
		MatrixFromQuat(smoothQ, veh->GetMatrix());
		veh->GetMatrix().UpdateRW();
		veh->UpdateRwFrame();

		veh->m_vecMoveSpeed = e.targetVel;
		veh->m_vecTurnSpeed = e.targetTurn;
		veh->m_fSteerAngle = e.targetSteer;
		veh->m_fGasPedal = e.targetGas;
		veh->m_fBrakePedal = e.targetBrake;
		veh->m_fHealth = e.targetHealth;
		veh->bEngineOn = !!(e.targetFlags & MP_VFLAG_ENGINE_ON);
		veh->m_bSirenOrAlarm = !!(e.targetFlags & MP_VFLAG_SIREN_ON);
		veh->bLightsOn = !!(e.targetFlags & MP_VFLAG_LIGHTS_ON);
		veh->bIsHandbrakeOn = !!(e.targetFlags & MP_VFLAG_HANDBRAKE);
		veh->m_nCarHornTimer = (e.targetFlags & MP_VFLAG_HORN) ? 1 : 0;
		veh->AutoPilot.m_nCarMission = MISSION_NONE;
		veh->SetStatus((e.targetFlags & MP_VFLAG_WRECKED) ? STATUS_WRECKED : STATUS_PHYSICS);
		if (veh->IsCar() && !veh->bIsHandbrakeOn && veh->m_fBrakePedal <= 0.05f) {
			CAutomobile *car = (CAutomobile *)veh;
			for (int w = 0; w < 4; w++) {
				if (car->m_aWheelState[w] == WHEEL_STATE_FIXED || car->m_aWheelState[w] == WHEEL_STATE_SKIDDING)
					car->m_aWheelState[w] = WHEEL_STATE_NORMAL;
			}
		}

		if ((e.targetFlags & MP_VFLAG_WRECKED) && veh->GetStatus() != STATUS_WRECKED)
			veh->BlowUpCar(nil);

		// Synced visual NPC driver for Host traffic cars
		bool localInteracting = localPed && localPed->m_pMyVehicle == veh;
		if (e.npcDriverModel > 0 && e.driverPeer == 0 && !localInteracting && !(e.targetFlags & MP_VFLAG_WRECKED)) {
			if (e.npcDriverPed && (!IsPoolPedValidLocal(e.npcDriverPed) || !e.npcDriverPed->bInVehicle || veh->pDriver != e.npcDriverPed)) {
				CleanupEntryNpcDriver(e, veh);
			}
			if (!e.npcDriverPed && !veh->pDriver) {
				int32 npcMi = (int32)e.npcDriverModel;
				CBaseModelInfo *pmi = (npcMi >= 0 && npcMi <= MI_LAST_PED) ? CModelInfo::GetModelInfo(npcMi) : nil;
				if (!pmi || pmi->GetModelType() != MITYPE_PED) npcMi = MI_MALE01;
				CStreaming::RequestModel(npcMi, STREAMFLAGS_DEPENDENCY | STREAMFLAGS_DONT_REMOVE);
				CStreaming::LoadAllRequestedModels(false);
				if (CStreaming::ms_aInfoForModel[npcMi].m_loadState == STREAMSTATE_LOADED) {
					CCivilianPed *npc = new CCivilianPed(PEDTYPE_CIVMALE, (uint32)npcMi);
					if (npc) {
						npc->CharCreatedBy = MISSION_CHAR;
						npc->bRespondsToThreats = false;
						npc->bStreamingDontDelete = true;
						npc->bRenderPedInCar = !veh->bIsBus;
						npc->bUsesCollision = false;
						npc->SetPosition(veh->GetPosition());
						CWorld::Add(npc);
						veh->SetDriver(npc);
						npc->m_pMyVehicle = veh;
						npc->bInVehicle = true;
						npc->bChangedSeat = false;
						npc->SetPedState(PED_DRIVING);
						npc->m_pVehicleAnim = CAnimManager::BlendAnimation(npc->GetClump(), ASSOCGRP_STD, veh->GetDriverAnim(), 100.0f);
						npc->StopNonPartialAnims();
						npc->RemoveWeaponWhenEnteringVehicle();
						npc->SetPedPositionInCar();
						npc->UpdateRwFrame();
						e.npcDriverPed = npc;
					}
				}
			}
			if (e.npcDriverPed && IsPoolPedValidLocal(e.npcDriverPed) && e.npcDriverPed->bInVehicle) {
				e.npcDriverPed->SetPedPositionInCar();
				e.npcDriverPed->UpdateRwFrame();
			}
		} else if (e.npcDriverPed) {
			if (!localInteracting || (e.npcDriverPed->bInVehicle && e.npcDriverPed->m_pMyVehicle == veh && e.driverPeer != 0)) {
				CleanupEntryNpcDriver(e, veh);
			} else if (!e.npcDriverPed->bInVehicle) {
				e.npcDriverPed->CharCreatedBy = RANDOM_CHAR;
				e.npcDriverPed->bStreamingDontDelete = false;
				e.npcDriverPed = nil;
			}
		}

		if (localVeh == veh && localPed)
			localPed->SetPedPositionInCar();
	}
}

static bool FindFreePassengerSeat(CVehicle *veh, int &outSeatIdx, int32 &outDoor)
{
	if (!veh || veh->IsBoat() || veh->m_vehType == VEHICLE_TYPE_BIKE)
		return false;
	struct SeatCand { int seat; int32 door; };
	static const SeatCand cands[3] = {
		{ 0, CAR_DOOR_RF },
		{ 2, CAR_DOOR_RR },
		{ 1, CAR_DOOR_LR }
	};
	for (int i = 0; i < 3; i++) {
		int s = cands[i].seat;
		if (s < (int)veh->m_nNumMaxPassengers && veh->pPassengers[s] == nil) {
			outSeatIdx = s;
			outDoor = cands[i].door;
			return true;
		}
	}
	return false;
}

bool CMPManager::OnLocalEnterVehicleAttempt(CPlayerPed *ped, CVehicle *veh, bool forcePassenger)
{
	if (!ped || !veh)
		return false;

	bool hasRemoteDriver = false;
	for (int i = 0; i < MP_MAX_PEERS; i++) {
		if (peers[i].active && peers[i].peerId != localPeerId && peers[i].ped && peers[i].ped == veh->pDriver) {
			hasRemoteDriver = true;
			break;
		}
	}
	MPVehicleNetEntry *entry = FindVehEntry(veh);
	if (entry && entry->driverPeer != 0 && entry->driverPeer != (uint8)localPeerId && (CTimer::GetTimeInMilliseconds() - entry->lastRxMs) < 2500)
		hasRemoteDriver = true;

	if (forcePassenger || hasRemoteDriver) {
		int seatIdx = -1;
		int32 door = CAR_DOOR_RF;
		if (!FindFreePassengerSeat(veh, seatIdx, door)) {
			return hasRemoteDriver || forcePassenger;
		}
		ped->m_vehDoor = (uint16)door;
		ped->SetObjective(OBJECTIVE_ENTER_CAR_AS_PASSENGER, veh);

		if (active && entry) {
			uint8 pkt[16];
			MPBufWriter w(pkt, sizeof(pkt));
			w.Write<uint8>(PKT_VEHICLE_ENTER);
			w.Write<uint8>((uint8)localPeerId);
			w.Write<int32>(entry->netId);
			w.Write<int8>((int8)seatIdx);
			if (w.ok) QueuePacket(1, 0, pkt, w.pos);
		}
		return true;
	}

	if (active) {
		int32 nid = AssignOrGetVehNetId(veh, (uint8)localPeerId);
		if (MPVehicleNetEntry *e = FindVehEntryByNetId(nid)) {
			e->ownerPeer = (uint8)localPeerId;
			e->driverPeer = (uint8)localPeerId;
			e->releaseOwnerAtMs = CTimer::GetTimeInMilliseconds() + 5000;
		}
		uint8 pkt[16];
		MPBufWriter w(pkt, sizeof(pkt));
		w.Write<uint8>(PKT_VEHICLE_ENTER);
		w.Write<uint8>((uint8)localPeerId);
		w.Write<int32>(nid);
		w.Write<int8>((int8)-1);
		if (w.ok) QueuePacket(1, 0, pkt, w.pos);
	}
	return false;
}

void CMPManager::RequestPassengerEnter()
{
	CPlayerPed *ped = FindPlayerPed();
	if (!ped || ped->bInVehicle || ped->m_nPedState == PED_DEAD)
		return;
	CVehicle *bestVeh = nil;
	float bestDistSq = SQR(10.0f);
	CPool<CVehicle, CAutomobile> *pool = CPools::GetVehiclePool();
	for (int i = 0; i < pool->GetSize(); i++) {
		CVehicle *v = pool->GetSlot(i);
		if (!v || v->GetStatus() == STATUS_WRECKED)
			continue;
		float d = (v->GetPosition() - ped->GetPosition()).MagnitudeSqr();
		if (d < bestDistSq) {
			bestDistSq = d;
			bestVeh = v;
		}
	}
	if (bestVeh)
		OnLocalEnterVehicleAttempt(ped, bestVeh, true);
}

void CMPManager::HandleVehicleEnterPacket(int fromPeerId, const uint8 *data, int len)
{
	MPBufReader r(data + 1, len - 1);
	uint8 peerId = r.Read<uint8>();
	int32 netId = r.Read<int32>();
	int8 seatIdx = r.Read<int8>();
	if (!r.ok) return;
	(void)fromPeerId;

	MPRemotePlayer *rp = GetPeerSlot(peerId);
	if (rp) {
		rp->vehNetId = netId;
		rp->seatIdx = seatIdx;
	}
	if (MPVehicleNetEntry *e = FindVehEntryByNetId(netId)) {
		if (seatIdx == -1) {
			e->driverPeer = peerId;
			e->ownerPeer = peerId;
			if (e->veh && IsPoolVehicleValid(e->veh)) {
				e->veh->AutoPilot.m_nCarMission = MISSION_NONE;
				e->veh->SetStatus(STATUS_PHYSICS);
				CleanupEntryNpcDriver(*e, e->veh);
				if (e->veh->pDriver && e->veh->pDriver != FindPlayerPed() && !IsRemotePlayerPed(e->veh->pDriver)) {
					CPed *npc = e->veh->pDriver;
					e->veh->RemoveDriver();
					npc->RemoveInCarAnims();
					npc->bInVehicle = false;
					npc->m_pMyVehicle = nil;
					CWorld::Remove(npc);
					delete npc;
				}
			}
		}
	}
}

void CMPManager::HandleVehicleExitPacket(int fromPeerId, const uint8 *data, int len)
{
	MPBufReader r(data + 1, len - 1);
	uint8 peerId = r.Read<uint8>();
	int32 netId = r.Read<int32>();
	if (!r.ok) return;
	(void)fromPeerId;

	MPRemotePlayer *rp = GetPeerSlot(peerId);
	if (rp && rp->vehNetId == netId) {
		rp->vehNetId = 0;
		rp->seatIdx = -2;
	}
	if (MPVehicleNetEntry *e = FindVehEntryByNetId(netId)) {
		if (e->driverPeer == peerId)
			e->driverPeer = 0;
	}
}

void CMPManager::ProcessPassengerDriveBy(CVehicle *veh)
{
	if (!veh)
		return;
	CPlayerPed *localPed = FindPlayerPed();
	if (!localPed || !localPed->bInVehicle || localPed->m_pMyVehicle != veh || veh->pDriver == localPed)
		return;

	bool isPassenger = false;
	int seatSlot = 0;
	for (int s = 0; s < 4; s++) {
		if (veh->pPassengers[s] == localPed) { isPassenger = true; seatSlot = s; break; }
	}
	if (!isPassenger)
		return;

	localPed->SetPedPositionInCar();

	CWeapon *weapon = localPed->GetWeapon();
	if (weapon->m_eWeaponType != WEAPONTYPE_UZI && weapon->m_eWeaponType != WEAPONTYPE_COLT45)
		return;
	weapon->Update(localPed->m_audioEntityId);

	bool lookLeft = CPad::GetPad(0)->GetLookLeft() || TheCamera.Cams[TheCamera.ActiveCam].LookingLeft;
	bool lookRight = CPad::GetPad(0)->GetLookRight() || TheCamera.Cams[TheCamera.ActiveCam].LookingRight;
	bool firePressed = CPad::GetPad(0)->GetCarGunFired() || CPad::GetPad(0)->GetWeapon();
	if (!lookLeft && !lookRight && firePressed) {
		if (seatSlot == 0 || seatSlot == 2) lookRight = true;
		else lookLeft = true;
	}

	CAnimBlendAssociation *anim = nil;
	if (lookLeft || lookRight) {
		if (lookLeft) {
			anim = RpAnimBlendClumpGetAssociation(localPed->GetClump(), ANIM_STD_CAR_DRIVEBY_RIGHT);
			if (anim) anim->blendDelta = -1000.0f;
			anim = RpAnimBlendClumpGetAssociation(localPed->GetClump(), ANIM_STD_CAR_DRIVEBY_LEFT);
			if (!anim || anim->blendDelta < 0.0f)
				CAnimManager::AddAnimation(localPed->GetClump(), ASSOCGRP_STD, ANIM_STD_CAR_DRIVEBY_LEFT);
			else
				anim->SetRun();
		} else {
			anim = RpAnimBlendClumpGetAssociation(localPed->GetClump(), ANIM_STD_CAR_DRIVEBY_LEFT);
			if (anim) anim->blendDelta = -1000.0f;
			anim = RpAnimBlendClumpGetAssociation(localPed->GetClump(), ANIM_STD_CAR_DRIVEBY_RIGHT);
			if (!anim || anim->blendDelta < 0.0f)
				CAnimManager::AddAnimation(localPed->GetClump(), ASSOCGRP_STD, ANIM_STD_CAR_DRIVEBY_RIGHT);
			else
				anim->SetRun();
		}
		if (firePressed && CTimer::GetTimeInMilliseconds() > weapon->m_nTimer && veh->IsCar()) {
			CVector fireOrigin = localPed->GetPosition() + CVector(0.0f, 0.0f, 0.45f);
			CVector fireDir = lookLeft ? (-veh->GetRight()) : veh->GetRight();
			fireDir.Normalise();
			weapon->FireFromCar((CAutomobile *)veh, lookLeft);
			weapon->m_nTimer = CTimer::GetTimeInMilliseconds() + 85;
			if (active)
				OnShotFired(WEAPONTYPE_UZI_DRIVEBY, fireOrigin, fireDir, nil, 20.0f, true);
		}
	} else {
		weapon->Reload();
		anim = RpAnimBlendClumpGetAssociation(localPed->GetClump(), ANIM_STD_CAR_DRIVEBY_LEFT);
		if (anim) anim->blendDelta = -1000.0f;
		anim = RpAnimBlendClumpGetAssociation(localPed->GetClump(), ANIM_STD_CAR_DRIVEBY_RIGHT);
		if (anim) anim->blendDelta = -1000.0f;
	}
}

bool MP_OnLocalEnterVehicleAttempt(CPlayerPed *ped, CVehicle *veh, bool forcePassenger)
{
	return gMP.OnLocalEnterVehicleAttempt(ped, veh, forcePassenger);
}

void MP_ProcessPassengerDriveBy(CVehicle *veh)
{
	gMP.ProcessPassengerDriveBy(veh);
}

bool MP_IsRemoteControlledVehicle(const CVehicle *veh)
{
	if (!gMP.active || !veh)
		return false;
	CPlayerPed *localPed = FindPlayerPed();
	if (localPed && localPed->bInVehicle && localPed->m_pMyVehicle == veh && veh->pDriver == localPed)
		return false;
	MPVehicleNetEntry *e = gMP.FindVehEntry(const_cast<CVehicle *>(veh));
	if (!e || !e->used)
		return false;
	return e->hasTarget || e->ownerPeer != (uint8)gMP.localPeerId;
}

void MP_OnVehicleDestroyed(CVehicle *veh)
{
	if (!gMP.active || gMP.suppressLocalHooks || !veh)
		return;
	if (MPVehicleNetEntry *e = gMP.FindVehEntry(veh))
		e->targetFlags |= MP_VFLAG_WRECKED;
}

#endif // MULTIPLAYER_COOP
