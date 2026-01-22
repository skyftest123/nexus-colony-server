// src/map.js
// Server-side placement + map rules (grid, blocked paths, building instances)
//
// This module is intentionally data-driven:
// - Map knows: width/height, blocked cells, occupied cells, building instances
// - Validation: in bounds, not blocked, not occupied, (optional) footprint size
//
// UI can later render exact placements from "instances".

function key(x, y) {
  return `${x},${y}`;
}

function inBounds(map, x, y) {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

function makeSetFromArray(arr) {
  const s = new Set();
  for (const v of arr || []) s.add(String(v));
  return s;
}

function generateDefaultPaths(width, height) {
  // horizontal road at midY + a few extra blocked cells
  const blocked = new Set();
  const midY = Math.floor(height / 2);
  for (let x = 0; x < width; x++) blocked.add(key(x, midY));
  blocked.add(key(2, Math.max(0, midY - 1)));
  blocked.add(key(9, Math.min(height - 1, midY + 1)));
  return Array.from(blocked);
}

/**
 * Create a new map state object
 */
function createMap({ width = 12, height = 8, blockedCells = null } = {}) {
  const blocked = blockedCells ? blockedCells : generateDefaultPaths(width, height);
  return {
    width,
    height,
    blockedCells: blocked, // array of "x,y"
    // instances: { [id]: { id, type, x, y, w, h, level, hp, createdAtTick } }
    instances: {},
  };
}

/**
 * Rebuild a fast occupancy map (Set) from instances for validation.
 */
function buildOccupancySet(map) {
  const occ = new Set();
  for (const inst of Object.values(map.instances || {})) {
    const w = inst.w || 1;
    const h = inst.h || 1;
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) {
        occ.add(key(inst.x + dx, inst.y + dy));
      }
    }
  }
  return occ;
}

/**
 * Validate placement for a building footprint.
 * Returns { ok:boolean, reason?:string }
 */
function canPlace(map, { x, y, w = 1, h = 1 }) {
  if (!map) return { ok: false, reason: "NO_MAP" };
  if (!inBounds(map, x, y)) return { ok: false, reason: "OUT_OF_BOUNDS" };
  if (!inBounds(map, x + w - 1, y + h - 1)) return { ok: false, reason: "OUT_OF_BOUNDS" };

  const blocked = makeSetFromArray(map.blockedCells);
  const occ = buildOccupancySet(map);

  for (let dx = 0; dx < w; dx++) {
    for (let dy = 0; dy < h; dy++) {
      const k = key(x + dx, y + dy);
      if (blocked.has(k)) return { ok: false, reason: "BLOCKED_CELL" };
      if (occ.has(k)) return { ok: false, reason: "OCCUPIED" };
    }
  }
  return { ok: true };
}

/**
 * Place building instance on map.
 * buildingDef can optionally provide footprint size: { footprint:{w,h} }
 */
function placeInstance(map, { id, type, x, y, buildingDef, level = 1, createdAtTick = 0 }) {
  const w = buildingDef?.footprint?.w || 1;
  const h = buildingDef?.footprint?.h || 1;

  const check = canPlace(map, { x, y, w, h });
  if (!check.ok) return { ok: false, reason: check.reason };

  map.instances[id] = {
    id,
    type,
    x,
    y,
    w,
    h,
    level,
    hp: 100,
    createdAtTick,
  };

  return { ok: true, instance: map.instances[id] };
}

/**
 * Remove one instance
 */
function removeInstance(map, instanceId) {
  if (!map?.instances?.[instanceId]) return { ok: false, reason: "NOT_FOUND" };
  delete map.instances[instanceId];
  return { ok: true };
}

/**
 * Find instances by type
 */
function listInstancesByType(map, type) {
  const out = [];
  for (const inst of Object.values(map.instances || {})) {
    if (inst.type === type) out.push(inst);
  }
  return out;
}

/**
 * Upgrade instance level
 */
function upgradeInstance(map, instanceId) {
  const inst = map?.instances?.[instanceId];
  if (!inst) return { ok: false, reason: "NOT_FOUND" };
  inst.level = (inst.level || 1) + 1;
  return { ok: true, instance: inst };
}

/**
 * Pick a random buildable cell (used if client doesn’t provide x,y yet)
 */
function pickRandomBuildableCell(map, buildingDef) {
  const w = buildingDef?.footprint?.w || 1;
  const h = buildingDef?.footprint?.h || 1;

  // attempt random tries first
  for (let i = 0; i < 80; i++) {
    const x = Math.floor(Math.random() * map.width);
    const y = Math.floor(Math.random() * map.height);
    const check = canPlace(map, { x, y, w, h });
    if (check.ok) return { x, y };
  }

  // fallback: scan
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const check = canPlace(map, { x, y, w, h });
      if (check.ok) return { x, y };
    }
  }
  return null;
}

module.exports = {
  createMap,
  generateDefaultPaths,
  canPlace,
  placeInstance,
  removeInstance,
  listInstancesByType,
  upgradeInstance,
  pickRandomBuildableCell,
};
