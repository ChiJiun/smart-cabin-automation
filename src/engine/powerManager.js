'use strict';

const { getType, drawFor } = require('./deviceTypes');

/**
 * Load management (Behavior 5).
 *
 * Input : devices with `mode` and requested `level` already derived.
 * Output: per device `effectiveLevel`, `drawW`, `powerState`, `powerReason`;
 *         and a power summary.
 *
 * Rules
 *  1. During a collision incident every P2/P3 device is forced off (EMERGENCY_RESERVE).
 *  2. If demand > capacity, shed in a fixed order until demand <= capacity:
 *       devices sorted by priority (P3 first), then shedOrder (ascending), then config order.
 *       P3              -> switched off completely (SHED)
 *       P2 adjustable   -> one level at a time down to 0 (REDUCED, then SHED)
 *       P2 simple       -> switched off (SHED)
 *       P1 adjustable   -> one level at a time down to its minimum level (REDUCED)
 *       P1 simple, P0   -> never shed
 *  3. If demand still exceeds capacity -> CRITICAL_POWER.
 *  4. A shed device that has not been powered since the user switched it on is DEFERRED.
 *
 * The allocation is recomputed from the requested state on every change, so restoring
 * happens automatically (in reverse shedding order) as soon as there is headroom.
 */
function allocatePower(devices, { capacityW, highLoadPct, emergency }) {
  for (const d of devices) {
    d.effectiveLevel = d.level;
    d.drawW = drawFor(d, d.mode, d.level);
    d.powerState = 'NORMAL';
    d.powerReason = null;
  }

  if (emergency) {
    for (const d of devices) {
      if (d.priority >= 2 && d.drawW > 0) {
        d.drawW = 0;
        d.powerState = 'SHED';
        d.powerReason = 'EMERGENCY_RESERVE';
      }
    }
  }

  const sum = () => devices.reduce((acc, d) => acc + d.drawW, 0);
  const requestedW = sum();
  let demand = requestedW;

  const candidates = devices
    .map((d, index) => ({ d, index }))
    .filter(({ d }) => d.priority >= 1 && d.drawW > 0 && d.powerState === 'NORMAL')
    .sort((a, b) => b.d.priority - a.d.priority || a.d.shedOrder - b.d.shedOrder || a.index - b.index)
    .map(({ d }) => d);

  const shedSteps = [];
  for (const d of candidates) {
    if (demand <= capacityW) break;
    const t = getType(d.type);
    if (d.priority === 3 || (!t.adjustable && d.priority === 2)) {
      demand -= d.drawW;
      shedSteps.push({ id: d.id, from: d.effectiveLevel, to: 0 });
      d.drawW = 0;
      d.powerState = 'SHED';
      d.powerReason = 'OVERLOAD';
      continue;
    }
    if (!t.adjustable) continue; // P1 simple device: never shed
    const floor = d.priority === 1 ? Math.max(t.minLevel, 1) : 0;
    while (demand > capacityW && d.effectiveLevel > floor) {
      const before = d.drawW;
      d.effectiveLevel -= 1;
      d.drawW = d.effectiveLevel > 0 ? drawFor(d, d.mode, d.effectiveLevel) : 0; // level 0 = fully off
      demand -= before - d.drawW;
      d.powerState = d.effectiveLevel > 0 ? 'REDUCED' : 'SHED';
      d.powerReason = 'OVERLOAD';
    }
    if (d.powerState !== 'NORMAL') shedSteps.push({ id: d.id, from: d.level, to: d.effectiveLevel });
  }

  for (const d of devices) {
    if (d.powerState === 'SHED' && d.powerReason === 'OVERLOAD' && !d.poweredSinceOn) {
      d.powerState = 'DEFERRED';
    }
    if (d.drawW > 0) d.poweredSinceOn = true;
  }

  const critical = demand > capacityW;
  const loadPct = capacityW > 0 ? (demand / capacityW) * 100 : Infinity;
  let status;
  if (critical) status = 'CRITICAL_POWER';
  else if (requestedW > capacityW) status = 'OVERLOAD';
  else if (loadPct >= highLoadPct) status = 'HIGH_LOAD';
  else status = 'NORMAL';

  return {
    capacityW,
    requestedW,
    demandW: demand,
    loadPct: Math.round(loadPct * 10) / 10,
    status,
    shedSteps,
  };
}

module.exports = { allocatePower };
