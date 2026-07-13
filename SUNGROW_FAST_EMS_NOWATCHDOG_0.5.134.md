# Sungrow Fast EMS no-watchdog fix – 0.5.134

This build is based on 0.5.133 and keeps the corrected Sungrow direction handling:

- `+W` / `dischargePowerW` => Sungrow command `0xBB` (discharge)
- `-W` / `chargePowerW` => Sungrow command `0xAA` (charge)
- `0 W` => Sungrow command `0xCC` (stop)

Changes in 0.5.134:

- Disabled Sungrow storage power setpoint keepalive/watchdog.
- Disabled restore-on-start for `sET_ACTIVE_POWER` to avoid stale commands after restart/reconnect.
- Disabled post-write repeats for Sungrow storage commands.
- Removed helper prewrites for command/power because the compound FC16 block already writes EMS mode.
- Kept External EMS heartbeat as the only cyclic write: register 13080, fixed value 20, approximately every 10 seconds.
- EMS power commands write only the control block `13050..13052` by FC16; no synchronous heartbeat write is appended to each EMS setpoint.
- Fast polling contains only critical live values; detailed registers refresh every 5 minutes.
- The command scheduler wakes every 250 ms, while the Modbus driver still enforces the Sungrow-safe 1000 ms minimum command spacing.

Recommended EMS mapping:

- Use only `aliases.ctrl.powerSetpointW`, or the dedicated split aliases `aliases.ctrl.chargePowerW` and `aliases.ctrl.dischargePowerW`.
- Do not map `eMS_MODE_SELECTION`, `cHARGE_DISCHARGE_COMMAND`, `cHARGE_DISCHARGE_POWER`, or `ExternalEMSHeartbeat` directly in EMS.
