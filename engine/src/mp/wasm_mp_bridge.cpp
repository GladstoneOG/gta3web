#include "common.h"
#include "mp_core.h"
#include "World.h"
#include "Pools.h"
#include "PlayerPed.h"
#include "PlayerInfo.h"
#include "Vehicle.h"
#include "Wanted.h"
#include "Pad.h"
#include "crossplatform.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define MP_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
extern "C" void EmscriptenRequestRestart(bool wantToLoad);
#else
#define MP_EXPORT extern "C"
#endif

#ifdef MULTIPLAYER_COOP

MP_EXPORT void mp_init(int localPeerId, int isHost)
{
	MP_Init(localPeerId, isHost);
}

MP_EXPORT void mp_shutdown()
{
	MP_Shutdown();
}

MP_EXPORT void mp_set_player_info(int peerId, const char *name, int modelIndex)
{
	gMP.SetPlayerInfo(peerId, name, modelIndex);
}

MP_EXPORT int mp_get_local_player_state(float *outFloats, int *outInts)
{
	if (gGameState != GS_PLAYING_GAME || CPools::GetPedPool() == nil) {
		if (outFloats) memset(outFloats, 0, sizeof(float) * 9);
		if (outInts) memset(outInts, 0, sizeof(int) * 8);
		return 0;
	}
	CPlayerPed *ped = FindPlayerPed();
	if (!ped) return 0;

	CVector pos = ped->GetPosition();
	if (outFloats) {
		outFloats[0] = pos.x;
		outFloats[1] = pos.y;
		outFloats[2] = pos.z;
		outFloats[3] = ped->m_fRotationCur;
		outFloats[4] = ped->m_fHealth;
		outFloats[5] = ped->m_fArmour;
		outFloats[6] = ped->m_vecMoveSpeed.x;
		outFloats[7] = ped->m_vecMoveSpeed.y;
		outFloats[8] = ped->m_vecMoveSpeed.z;
	}
	if (outInts) {
		outInts[0] = CWorld::Players[CWorld::PlayerInFocus].m_nMoney;
		outInts[1] = (int)ped->m_modelIndex;
		outInts[2] = ped->bInVehicle ? 1 : 0;
		outInts[3] = (ped->bInVehicle && ped->m_pMyVehicle) ? gMP.AssignOrGetVehNetId(ped->m_pMyVehicle, (uint8)gMP.localPeerId) : 0;
		int seat = -2;
		if (ped->bInVehicle && ped->m_pMyVehicle) {
			if (ped->m_pMyVehicle->pDriver == ped) seat = -1;
			else {
				for (int s = 0; s < 4; s++) {
					if (ped->m_pMyVehicle->pPassengers[s] == ped) { seat = s; break; }
				}
			}
		}
		outInts[4] = seat;
		outInts[5] = ped->m_pWanted ? ped->m_pWanted->GetWantedLevel() : 0;
		outInts[6] = (int)ped->GetWeapon()->m_eWeaponType;
		outInts[7] = ped->DyingOrDead() ? 1 : 0;
	}
	return 1;
}

MP_EXPORT void mp_apply_remote_player(int peerId, const uint8 *stateBuf, int len)
{
	gMP.PushPacket(peerId, stateBuf, len);
}

MP_EXPORT void mp_push_net_packet(int fromPeerId, const uint8 *data, int len)
{
	gMP.PushPacket(fromPeerId, data, len);
}

MP_EXPORT int mp_poll_net_packet(int *outChannel, int *outTargetPeer, uint8 *outBuf, int maxLen)
{
	return gMP.PollPacket(outChannel, outTargetPeer, outBuf, maxLen);
}

MP_EXPORT void mp_exec_cheat(int cheatId, int param1, int param2)
{
	gMP.ExecCheat(cheatId, param1, param2, false);
}

MP_EXPORT int mp_spawn_vehicle(int modelIndex, float aheadDist)
{
	return gMP.SpawnVehicleAhead(modelIndex, aheadDist, true) ? 1 : 0;
}

MP_EXPORT void mp_spawn_pickup(int pickupKind, int weaponOrAmount)
{
	gMP.SpawnPickupAhead(pickupKind, weaponOrAmount, true);
}

MP_EXPORT void mp_set_open_islands(int open)
{
	gMP.SetOpenIslands(open, false);
}

MP_EXPORT int mp_export_save_state(uint8 **outPtr)
{
	return gMP.ExportSave(outPtr);
}

MP_EXPORT int mp_import_save_state(const uint8 *data, int len)
{
	return gMP.ImportSave(data, len);
}

MP_EXPORT void mp_trigger_restart(int newGame)
{
	(void)newGame;
	if (gGameState != GS_PLAYING_GAME || CPools::GetPedPool() == nil)
		return;
#ifdef __EMSCRIPTEN__
	EmscriptenRequestRestart(false);
#endif
}

MP_EXPORT void mp_set_ui_pause_block(int block)
{
	gMP.SetUiPauseBlock(block != 0);
}

MP_EXPORT int mp_get_hud_state(char *outJsonBuf, int maxLen)
{
	return gMP.GetHudJson(outJsonBuf, maxLen);
}

MP_EXPORT int mp_set_frontend_setting(const char *key, float val)
{
	return gMP.SetFrontendSetting(key, val);
}

MP_EXPORT int mp_get_frontend_settings(char *outJsonBuf, int maxLen)
{
	return gMP.GetFrontendSettingsJson(outJsonBuf, maxLen);
}

#endif // MULTIPLAYER_COOP
