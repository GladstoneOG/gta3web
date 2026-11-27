#pragma once

#include <stdint.h>

#ifdef MULTIPLAYER_COOP

#include "WeaponType.h"

class CPed;
class CPlayerPed;
class CVehicle;
class CEntity;

#define MP_MAX_PEERS 4
#define MP_NAME_LEN 32
#define MP_MAX_PKT_BYTES 512
#define MP_OUTBOX_CAP 512
#define MP_MAX_VEH_MAP 256
#define MP_MAX_PED_MAP 256

enum eMpPacketType : uint8 {
	PKT_PLAYER_STATE     = 0x01,
	PKT_PLAYER_IDENTITY  = 0x02,
	PKT_VEHICLE_SYNC     = 0x03,
	PKT_VEHICLE_ENTER    = 0x04,
	PKT_VEHICLE_EXIT     = 0x05,
	PKT_SHOT_EVENT       = 0x06,
	PKT_GARAGE_EVENT     = 0x07,
	PKT_PED_SYNC         = 0x08,
	PKT_WORLD_SYNC       = 0x09,
	PKT_MISSION_SYNC     = 0x0A,
	PKT_CHAT_OR_PAGER    = 0x0B,
	PKT_SPAWN_REQ        = 0x0C,
	PKT_RC_EVENT         = 0x0D,
	PKT_PICKUP_EVENT     = 0x0E,
	PKT_DAMAGE_EVENT     = 0x0F,
	PKT_EXPLOSION_EVENT  = 0x10
};

enum eMpPlayerFlags : uint16 {
	MP_PFLAG_IN_VEHICLE  = 1 << 0,
	MP_PFLAG_FIRING      = 1 << 1,
	MP_PFLAG_SPRINTING   = 1 << 2,
	MP_PFLAG_DUCKING     = 1 << 3,
	MP_PFLAG_JUMPING     = 1 << 4,
	MP_PFLAG_DEAD        = 1 << 5,
	MP_PFLAG_DRIVEBY_L   = 1 << 6,
	MP_PFLAG_DRIVEBY_R   = 1 << 7,
	MP_PFLAG_AIMING      = 1 << 8,
	MP_PFLAG_ENTERING_VEH = 1 << 9,
	MP_PFLAG_EXITING_VEH  = 1 << 10,
	MP_PFLAG_ATTACKING    = 1 << 11
};

enum eMpVehicleFlags : uint16 {
	MP_VFLAG_ENGINE_ON   = 1 << 0,
	MP_VFLAG_SIREN_ON    = 1 << 1,
	MP_VFLAG_LIGHTS_ON   = 1 << 2,
	MP_VFLAG_LOCKED      = 1 << 3,
	MP_VFLAG_IS_RC       = 1 << 4,
	MP_VFLAG_IS_MISSION  = 1 << 5,
	MP_VFLAG_WRECKED     = 1 << 6,
	MP_VFLAG_REMOVED     = 1 << 7,
	MP_VFLAG_HANDBRAKE   = 1 << 8,
	MP_VFLAG_HORN        = 1 << 9
};

enum eMpGarageAction : uint8 {
	MP_GARAGE_RESPRAY    = 0,
	MP_GARAGE_BOMB1      = 1,
	MP_GARAGE_BOMB2      = 2,
	MP_GARAGE_BOMB3      = 3,
	MP_GARAGE_DETONATE   = 4,
	MP_GARAGE_CRUSH      = 5
};

struct MPRemotePlayer {
	bool active;
	int peerId;
	char name[MP_NAME_LEN];
	int32 modelIndex;
	int32 pendingModelIndex;
	CVector pos;
	CVector prevPos;
	CVector targetPos;
	CVector vel;
	float heading;
	float prevHeading;
	float targetHeading;
	uint8 health;
	uint8 armor;
	uint8 weapon;
	uint8 animState;
	float moveSpeed;
	uint16 flags;
	int32 vehNetId;
	int8 seatIdx; // -1 = driver, 0..3 = passenger, -2 = none
	uint8 pedState;
	uint8 vehDoorCode;
	int16 vehAnimId;
	float vehAnimTime;
	int32 lastDoorVehId;
	uint8 lastDoorCode;
	uint32 lastRxMs;
	uint32 lastUpdateMs;
	CPed *ped;
	int32 radarBlipHandle;
	int16 lastCombatAnimId;
};

struct MPVehicleNetEntry {
	bool used;
	CVehicle *veh;
	CPed *npcDriverPed;
	int32 netId;
	int16 modelIndex;
	uint16 npcDriverModel;
	uint8 ownerPeer;
	uint8 driverPeer;
	uint32 lastTxMs;
	uint32 lastRxMs;
	uint32 releaseOwnerAtMs;
	CVector prevPos;
	CVector targetPos;
	CVector targetVel;
	CVector targetTurn;
	float targetQuat[4];
	float prevQuat[4];
	float targetSteer;
	float targetGas;
	float targetBrake;
	float targetHealth;
	uint16 targetFlags;
	uint8 col1;
	uint8 col2;
	uint8 bombType;
	bool hasTarget;
};

struct MPPedNetEntry {
	bool used;
	CPed *ped;
	int32 netId;
	uint8 ownerPeer;
	uint32 lastRxMs;
	CVector pos;
	CVector targetPos;
	CVector targetVel;
	float heading;
	float targetHeading;
	uint8 targetHealth;
	uint8 targetWeapon;
	uint8 targetAnim;
	uint8 targetFlags;
	uint8 lastHealth;
	uint8 prevFlags;
	bool hasTarget;
};

struct MPQueuedPacket {
	uint8 channel;    // 0 = fast unreliable, 1 = reliable
	uint8 targetPeer; // 0 = broadcast, 1..4 = unicast
	uint16 len;
	uint8 data[MP_MAX_PKT_BYTES];
};

struct MPBufWriter {
	uint8 *buf;
	int cap;
	int pos;
	bool ok;
	MPBufWriter(uint8 *b, int c) : buf(b), cap(c), pos(0), ok(true) {}
	template<typename T>
	void Write(const T &v) {
		if (pos + (int)sizeof(T) > cap) { ok = false; return; }
		memcpy(buf + pos, &v, sizeof(T));
		pos += (int)sizeof(T);
	}
	void WriteBytes(const void *p, int n) {
		if (pos + n > cap) { ok = false; return; }
		memcpy(buf + pos, p, n);
		pos += n;
	}
};

struct MPBufReader {
	const uint8 *buf;
	int len;
	int pos;
	bool ok;
	MPBufReader(const uint8 *b, int l) : buf(b), len(l), pos(0), ok(true) {}
	template<typename T>
	T Read() {
		T v;
		memset(&v, 0, sizeof(T));
		if (pos + (int)sizeof(T) > len) { ok = false; return v; }
		memcpy(&v, buf + pos, sizeof(T));
		pos += (int)sizeof(T);
		return v;
	}
	void ReadBytes(void *dst, int n) {
		if (pos + n > len) { ok = false; return; }
		memcpy(dst, buf + pos, n);
		pos += n;
	}
};

class CMPManager {
public:
	bool active;
	bool isHost;
	int localPeerId;
	char localName[MP_NAME_LEN];
	int32 localPreferredModel;
	bool openIslands;
	bool uiPauseBlock;
	uint32 nextNetId;
	uint32 lastStateTxMs;
	uint32 lastVehTxMs;
	uint32 lastPedTxMs;
	uint32 lastWorldTxMs;
	uint32 lastMissionTxMs;
	uint32 lastPurgeMs;
	uint32 vehScanCursor;
	uint32 pedScanCursor;
	uint32 spawnFocusIdx;
	char lastPagerMsg[128];

	MPRemotePlayer peers[MP_MAX_PEERS];
	MPVehicleNetEntry vehMap[MP_MAX_VEH_MAP];
	MPPedNetEntry pedMap[MP_MAX_PED_MAP];

	MPQueuedPacket outbox[MP_OUTBOX_CAP];
	int outHead;
	int outTail;

	bool suppressLocalHooks;

	CMPManager();
	void Init(int peerId, bool host);
	void Shutdown();
	void OnWorldReset();

	void QueuePacket(int channel, int targetPeer, const uint8 *data, int len);
	void PushPacket(int fromPeerId, const uint8 *data, int len);
	int PollPacket(int *outChannel, int *outTargetPeer, uint8 *outBuf, int maxLen);

	void SetPlayerInfo(int peerId, const char *name, int modelIndex);
	bool ApplyPedSkin(CPed *ped, int modelIndex, bool preserveAnimGrp);

	void TickBeforeGame();
	void TickAfterGame();
	void RenderNameTags();

	// Vehicles (mp_vehicles.cpp)
	int32 AssignOrGetVehNetId(CVehicle *veh, uint8 ownerPeer);
	CVehicle *FindVehByNetId(int32 netId);
	MPVehicleNetEntry *FindVehEntry(CVehicle *veh);
	MPVehicleNetEntry *FindVehEntryByNetId(int32 netId);
	void CleanupStaleVehicles();
	void TickVehiclesAfterGame(uint32 nowMs);
	void InterpolateRemoteVehicles(uint32 nowMs);
	void HandleVehicleSyncPacket(int fromPeerId, const uint8 *data, int len);
	void HandleVehicleEnterPacket(int fromPeerId, const uint8 *data, int len);
	void HandleVehicleExitPacket(int fromPeerId, const uint8 *data, int len);
	bool OnLocalEnterVehicleAttempt(CPlayerPed *ped, CVehicle *veh, bool forcePassenger);
	void RequestPassengerEnter();
	void ProcessPassengerDriveBy(CVehicle *veh);

	// Peds & Shooting (mp_peds.cpp)
	void CleanupStalePeds();
	void SendLocalPlayerState(uint32 nowMs);
	void TickRemotePlayers(uint32 nowMs);
	void TickRemotePlayersAfter(uint32 nowMs);
	void InterpolateSyncedPeds(uint32 nowMs);
	void HandlePlayerStatePacket(int fromPeerId, const uint8 *data, int len);
	void HandlePlayerIdentityPacket(int fromPeerId, const uint8 *data, int len);
	void HandleShotEventPacket(int fromPeerId, const uint8 *data, int len);
	void HandleDamageEventPacket(int fromPeerId, const uint8 *data, int len);
	void HandleExplosionEventPacket(int fromPeerId, const uint8 *data, int len);
	void HandlePedSyncPacket(int fromPeerId, const uint8 *data, int len);
	void TickPedsAfterGame(uint32 nowMs);
	void OnShotFired(eWeaponType weapon, const CVector &origin, const CVector &dir, CEntity *hitEnt, float dmg, bool isDriveBy, uint8 shotKind = 0, float power = 0.0f);
	void OnPedDamaged(CPed *victim, CEntity *attacker, eWeaponType method, float damage, int pedPiece, uint8 direction);
	void OnVehicleDamaged(CVehicle *veh, CEntity *attacker, eWeaponType weapon, float damage);
	void OnExplosion(CEntity *culprit, int expType, const CVector &pos);
	int FindPeerIdByPed(const CPed *ped) const;
	int32 FindSyncedPedNetIdByPtr(const CPed *ped) const;
	bool IsRemotePlayerPed(const CPed *ped) const;
	bool IsSyncedPed(const CPed *ped) const;
	bool IsSyncedVehicle(const CVehicle *veh) const;
	bool IsVehicleOccupiedByPlayer(const CVehicle *veh) const;
	void PurgeUnsyncedClientEntities();
	MPRemotePlayer *GetPeerSlot(int peerId);

	// World, Garages, RC, Rampages, Cheats, Pickups (mp_world.cpp)
	void TickWorldAfterGame(uint32 nowMs);
	void HandleGarageEventPacket(int fromPeerId, const uint8 *data, int len);
	void HandleWorldSyncPacket(int fromPeerId, const uint8 *data, int len);
	void HandleMissionSyncPacket(int fromPeerId, const uint8 *data, int len);
	void HandleSpawnReqPacket(int fromPeerId, const uint8 *data, int len);
	void HandleRcEventPacket(int fromPeerId, const uint8 *data, int len);
	void HandlePickupEventPacket(int fromPeerId, const uint8 *data, int len);
	void OnGarageAction(int garageIdx, uint8 action, CVehicle *veh, uint8 c1, uint8 c2, uint8 bombType);
	void OnRemoteCarEvent(uint8 action, const CVector &pos, float heading, int vehNetId);
	void OnPickupEvent(int slot, uint8 action, int mi, uint8 type, int qty, const CVector &pos);
	void ExecCheat(int cheatId, int p1, int p2, bool fromNetwork);
	CVehicle *SpawnVehicleLocal(int modelIndex, const CVector &pos, float heading, uint8 ownerPeer);
	CVehicle *SpawnVehicleAhead(int modelIndex, float aheadDist, bool broadcast);
	void SpawnPickupAhead(int pickupKind, int weaponOrAmount, bool broadcast);
	void SetOpenIslands(int open, bool fromNetwork);

	// Spatial helpers & Settings / Save bridges (mp_core.cpp)
	bool IsNearAnyPlayer2D(const CVector &pos, float maxDist) const;
	bool GetSpawnFocusCoors(CVector *outCoors);
	int GetHudJson(char *outBuf, int maxLen);
	int GetFrontendSettingsJson(char *outBuf, int maxLen);
	int SetFrontendSetting(const char *key, float val);
	void SetUiPauseBlock(bool block);
	int ExportSave(uint8 **outPtr);
	int ImportSave(const uint8 *data, int len);
};

extern CMPManager gMP;

// Hooks invoked from re3 subsystems (always declared; gated inside implementations)
void MP_Init(int localPeerId, int isHost);
void MP_Shutdown();
void MP_OnWorldReset();
void MP_TickBeforeGame();
void MP_TickAfterGame();
void MP_RenderNameTags();
bool MP_OnLocalEnterVehicleAttempt(CPlayerPed *ped, CVehicle *veh, bool forcePassenger);
void MP_ProcessPassengerDriveBy(CVehicle *veh);
void MP_OnGarageAction(int garageIdx, uint8 action, CVehicle *veh, uint8 c1, uint8 c2, uint8 bombType);
void MP_OnRemoteCarEvent(uint8 action, const CVector &pos, float heading, CVehicle *veh);
void MP_OnPickupEvent(int slot, uint8 action, int mi, uint8 type, int qty, const CVector &pos);
bool MP_IsClientSession();
bool MP_IsSyncedVehicle(const CVehicle *veh);
bool MP_IsSyncedPed(const CPed *ped);
bool MP_IsVehicleOccupiedByPlayer(const CVehicle *veh);
bool MP_IsNearAnyPlayer2D(const CVector &pos, float maxDist);
bool MP_GetSpawnFocusCoors(CVector *outCoors);
bool MP_IsRemotePlayerPed(const CPed *ped);
bool MP_IsRemoteControlledVehicle(const CVehicle *veh);
void MP_OnShotFired(eWeaponType weapon, const CVector &origin, const CVector &dir, CEntity *hitEnt, float dmg, bool isDriveBy, uint8 shotKind = 0, float power = 0.0f);
void MP_OnPedDamaged(CPed *victim, CEntity *attacker, eWeaponType method, float damage, int pedPiece, uint8 direction);
void MP_OnVehicleDamaged(CVehicle *veh, CEntity *attacker, eWeaponType weapon, float damage);
void MP_OnExplosion(CEntity *culprit, int expType, const CVector &pos);
bool MP_ShouldSuppressExplosionDamage(CEntity *victim, CEntity *attacker, eWeaponType method);
void MP_OnVehicleDestroyed(CVehicle *veh);

#endif // MULTIPLAYER_COOP
