# Sungrow Residential Hybrid Protocol V1.1.11 – 0.5.131

This build updates the Sungrow Residential Hybrid inverter template to the V1.1.11 protocol uploaded for the SH/RS/RT/T and MG RL hybrid inverter family.

## Implemented control path

- Signed control alias: `aliases.ctrl.powerSetpointW`
- Positive value: discharge battery
- Negative value: charge battery
- `0`: stop charge/discharge
- EMS mode selection: register 13050 -> protocol address 13049, value `3` (External EMS)
- Charge/discharge command: register 13051 -> protocol address 13050
  - `0xAA` / `170`: charge
  - `0xBB` / `187`: discharge
  - `0xCC` / `204`: stop
- Charge/discharge power: register 13052 -> protocol address 13051, W
- Wide-range power helper: register 33148 -> protocol address 33147, 0.01 kW
- External EMS heartbeat: register 13080 -> protocol address 13079, fixed value `20`, refreshed on a stable ~10 s cadence

## Reliability changes

- Legacy counter heartbeat values are no longer used for the residential hybrid template.
- Control writes use External EMS mode (`3`) instead of compulsory mode (`2`).
- Heartbeat can be written after the EMS mode + command block so the inverter is already in an external-scheduling mode before accepting the heartbeat.
- Fast polling contains only live RO operating values; RW setting registers are kept out of the fast poll loop.
- Optional helper write failures do not abort the primary setpoint command unless the transport link itself is broken.

## Protocol additions

- `PVPowerLimitation` for register 13018 / protocol address 13017.
- Device type labels for MG8RL and MG10RL.
- ioBroker state `common.states` is now populated from template `states` definitions.
