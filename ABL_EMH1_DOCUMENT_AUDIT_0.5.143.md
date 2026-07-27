# ABL eMH1 EVCC2/3 document audit - 0.5.143

Reference: ABL EVCC2/3 "API subset for external applications", document 05 0015 20 Rev. B.

## Confirmed communication parameters

- Modbus ASCII over RS485
- 38400 Bd, 8 data bits, even parity, 1 stop bit
- device address 1..16
- FC03 for reads and FC16 for single-register writes
- ABL response delimiter `>` is accepted (with `:` kept as a firmware-compatible fallback)

## Exact read requests

The 0.5.142 read-group correction remains in place and is confirmed by the document:

- `:010300010002F9` - device ID and firmware, R2 at 0x0001
- `:010300030001F8` - Modbus settings, R1 at 0x0003
- `:010300060002F4` - system flags, R2 at 0x0006
- `:0103002E0005C9` - state, PWM and phase currents, R5 at 0x002E

The former invalid merged request `:010300010003F8` is not generated.
Adaptive per-datapoint read splitting is disabled for this template so a valid ABL frame is never decomposed into unsupported requests.
The live R5 frame is marked as required; optional identity/config frames may be skipped temporarily without freezing the live charging values.

## Icmax write control

Register 0x0014 is written as one 16-bit register through FC16. The register contains PWM duty cycle in 0.1 percent steps.

Document examples are reproduced exactly:

- 10 A -> 16.6 % -> raw 0x00A6 -> `:0110001400010200A632`
- 16 A -> 26.6 % -> raw 0x010A
- 0 A / pause -> 100.0 % -> raw 0x03E8

The conversion truncates to 0.1 percent instead of rounding upward. Values below the IEC 61851 minimum of 6 A map to 100 percent pause instead of being forced to 6 A. The generated current limit therefore never exceeds the requested amperage.

## Normal run/stop behavior

Normal EOS charging release no longer uses register 0x0005 to jump the EVCC state machine between A1 and E0. Those commands are service-state transitions and A1 is only valid from E0/E2.

The stable aliases now use the documented Icmax behavior:

- `ctrl.run=false` / `ctrl.chargeEnable=false` -> 100 % PWM (no current allowed)
- `ctrl.run=true` / `ctrl.chargeEnable=true` -> restore the last EMS-commanded active PWM current, default 10 % = 6 A
- temporary charger-side derating/readback does not overwrite the stored EMS setpoint
- the raw `mODIFY_STATE` datapoint remains available for expert/service use only

## Current aliases

- L1/L2/L3 remain separate at 0.1 A resolution
- `r.currentA` and compatibility alias `r.currentTotalA` report the highest loaded phase
- `r.currentPhaseSumA` is retained only for diagnostics and estimated power
- PWM special values 0 %, 5 %, 97..100 % are not reported as a normal analogue charging current

## Write protection

- raw Icmax register accepts the documented 8..100 % range
- the normal EOS PWM alias uses only 10..96 % for analogue charging, plus 100 % for pause
- raw state modification accepts only the documented command values
