// src/state.js
// Zentrale Game-State-Logik + Laden der datengetriebenen Configs (skills/eras/buildings)
// Fokus: server-authoritative, map/placement basiert (sichtbares Wachstum), tick-ready
//
// Erwartete Dateien im Repo-Root (oder /data):
// - skills.json
// - eras.json
// - buildings.json
//
// Dieses Modul macht KEIN WebSocket. Es liefert nur State + Funktionen.

const fs = require("fs");
const path = require("path");

// -----------------------------
// Config Loader (robust)
// -----------------------------
function readJsonFirstExisting(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      }
    } catch (e) {
      // ignore and try next
    }
  }
  return null;
}

function loadConfigs() {
  const root = process.cwd();
  const candidates = {
    skills: [
      path.join(root, "skills.json"),
      path.join(root, "data", "skills.json"),
      path.join(__dirname, "..", "skills.json"),
      path.join(__dirname, "..", "data", "skills.json"),
    ],
    eras: [
      path.join(root, "eras.json"),
      path.join(root, "data", "eras.json"),
      path.join(__dirname, "..", "eras.json"),
      path.join(__dirname, "..", "data", "eras.json"),
    ],
    buildings: [
      path.join(root, "buildings.json"),
      path.join(root, "data", "buildings.json"),
      path.join(__dirname, "..", "buildings.json"),
      path.join(__dirname, "..", "data", "buildings.json"),
    ],
  };

  const skillsRaw = readJsonFirstExisting(candidates.skills);
  const erasRaw = readJsonFirstExisting(candidates.eras);
  const buildingsRaw = readJsonFirstExisting(candidates.buildings);

  const skills = normalizeSkills(skillsRaw);
  const eras = normalizeEras(erasRaw);
  const buildings = normalizeBuildings(buildingsRaw);

  return { skills, eras, buildings };
}

function normalizeSkills(raw) {
  // Unterstützt: { skills: [...] } oder direkt [...]
  const list = Array.isArray(raw) ? raw : raw?.skills;
  if (!Array.isArray(list)) return [];

  return list
    .filter((s) => s && s.id)
    .map((s) => ({
      id: String(s.id),
      name: String(s.name || s.id),
      branch: String(s.branch || "misc"),
      tier: Number.isFinite(s.tier) ? s.tier : 1,
      cost: Number.isFinite(s.cost) ? s.cost : 1,
      requires: Array.isArray(s.requires) ? s.requires.map(String) : [],
      effect: s.effect && typeof s.effect === "object" ? s.effect : {},
      icon: String(s.icon || "✨"),
      ui: s.ui && typeof s.ui === "object" ? s.ui : {},
      unlocks: s.unlocks && typeof s.unlocks === "object" ? s.unlocks : {},
      desc: String(s.desc || ""),
    }));
}

function normalizeEras(raw) {
  const list = Array.isArray(raw) ? raw : raw?.eras;
  if (!Array.isArray(list)) return [{ id: "proto", name: "Primitive Epoche", unlock: {} }];

  return list
    .filter((e) => e && e.id)
    .map((e) => ({
      id: String(e.id),
      name: String(e.name || e.id),
      unlock: e.unlock && typeof e.unlock === "object" ? e.unlock : {},
      description: String(e.description || ""),
      theme: String(e.theme || ""),
      color: String(e.color || "#00d4ff"),
      visuals: e.visuals && typeof e.visuals === "object" ? e.visuals : {},
    }));
}

function normalizeBuildings(raw) {
  // Unterstützt: { buildings: { ... } } oder direkt { ... }
  const obj = raw?.buildings && typeof raw.buildings === "object" ? raw.buildings : raw;
  if (!obj || typeof obj !== "object") return {};

  const out = {};
  for (const [id, b] of Object.entries(obj)) {
    if (!b) continue;
    out[String(id)] = {
      id: String(id),
      name: String(b.name || id),
      icon: String(b.icon || "🏗️"),
      era: String(b.era || "proto"),
      footprint: {
        w: Number.isFinite(b.footprint?.w) ? b.footprint.w : 1,
        h: Number.isFinite(b.footprint?.h) ? b.footprint.h : 1,
      },
      cost: {
        energie: Number.isFinite(b.cost?.energie) ? b.cost.energie : 0,
        nahrung: Number.isFinite(b.cost?.nahrung) ? b.cost.nahrung : 0,
        forschung: Number.isFinite(b.cost?.forschung) ? b.cost.forschung : 0,
      },
      produces: normalizeResourceBag(b.produces),
      maintenance: normalizeResourceBag(b.maintenance),
      tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
      visual: String(b.visual || ""),
      description: String(b.description || ""),
      // optional gameplay
      maxCount: Number.isFinite(b.maxCount) ? b.maxCount : null,
      buildTimeTicks: Number.isFinite(b.buildTimeTicks) ? b.buildTimeTicks : 0, // 0 = instant queue only through challenges later
      type: String(b.type || "production"), // production/defense/housing/utility
    };
  }
  return out;
}

function normalizeResourceBag(bag) {
  if (!bag || typeof bag !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(bag)) {
    const n = Number(v);
    if (Number.isFinite(n) && n !== 0) out[String(k)] = n;
  }
  return out;
}

// -----------------------------
// Map / Placement
// -----------------------------
function generateDefaultPaths(width, height) {
  const blocked = new Set();
  const midY = Math.floor(height / 2);
  for (let x = 0; x < width; x++) blocked.add(`${x},${midY}`);
  // kleine Ausbuchtung (damit es nicht stumpf aussieht)
  blocked.add(`2,${Math.max(0, midY - 1)}`);
  blocked.add(`${Math.max(0, width - 3)},${Math.min(height - 1, midY + 1)}`);
  return Array.from(blocked);
}

function createEmptyMap(width = 12, height = 8) {
  return {
    width,
    height,
    blockedPaths: generateDefaultPaths(width, height),
    // Instances = sichtbare Gebäude auf dem Grid
    // { id, type, x, y, w, h, level, hp, builtAtTick }
    instances: [],
    // optional: tiles meta später
  };
}

function isInsideMap(map, x, y, w, h) {
  return x >= 0 && y >= 0 && x + w <= map.width && y + h <= map.height;
}

function rectOverlaps(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function isBlockedByPath(map, x, y, w, h) {
  const blocked = new Set(map.blockedPaths || []);
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (blocked.has(`${xx},${yy}`)) return true;
    }
  }
  return false;
}

function isColliding(map, x, y, w, h) {
  for (const inst of map.instances) {
    if (rectOverlaps(x, y, w, h, inst.x, inst.y, inst.w, inst.h)) return true;
  }
  return false;
}

function canPlaceBuilding(state, buildingId, x, y) {
  const cfg = state.config;
  const b = cfg.buildings[buildingId];
  if (!b) return { ok: false, reason: "Unknown building" };

  // era gating: building.era muss <= aktuelle era index
  if (!isBuildingUnlockedForEra(cfg.eras, state.era, b.era)) {
    return { ok: false, reason: "LockedByEra" };
  }

  const w = b.footprint.w;
  const h = b.footprint.h;

  if (!isInsideMap(state.map, x, y, w, h)) return { ok: false, reason: "OutOfBounds" };
  if (isBlockedByPath(state.map, x, y, w, h)) return { ok: false, reason: "OnPath" };
  if (isColliding(state.map, x, y, w, h)) return { ok: false, reason: "Collision" };

  // maxCount optional
  if (typeof b.maxCount === "number") {
    const count = countBuildings(state, buildingId);
    if (count >= b.maxCount) return { ok: false, reason: "MaxCount" };
  }

  return { ok: true };
}

function placeBuilding(state, playerId, buildingId, x, y) {
  const cfg = state.config;
  const b = cfg.buildings[buildingId];
  if (!b) return { ok: false, reason: "Unknown building" };

  const check = canPlaceBuilding(state, buildingId, x, y);
  if (!check.ok) return check;

  // Ressourcen prüfen/abziehen
  const cost = b.cost || {};
  if (!hasResources(state.resources, cost)) return { ok: false, reason: "NotEnoughResources", cost };
  applyResources(state.resources, invertBag(cost));

  const id = `inst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  state.map.instances.push({
    id,
    type: buildingId,
    x,
    y,
    w: b.footprint.w,
    h: b.footprint.h,
    level: 1,
    hp: 100,
    builtAtTick: state.tick,
    byPlayerId: playerId || null,
  });

  state.stats.buildingsPlaced = (state.stats.buildingsPlaced || 0) + 1;
  return { ok: true, instanceId: id };
}

function removeBuilding(state, instanceId) {
  const idx = state.map.instances.findIndex((i) => i.id === instanceId);
  if (idx === -1) return { ok: false, reason: "NotFound" };
  state.map.instances.splice(idx, 1);
  state.stats.buildingsDemolished = (state.stats.buildingsDemolished || 0) + 1;
  return { ok: true };
}

function upgradeBuilding(state, instanceId) {
  const inst = state.map.instances.find((i) => i.id === instanceId);
  if (!inst) return { ok: false, reason: "NotFound" };

  // Upgrade-Kosten: simple scaling (kann später durch Skills ersetzt/verbessert werden)
  const b = state.config.buildings[inst.type];
  if (!b) return { ok: false, reason: "UnknownBuilding" };

  const lvl = inst.level || 1;
  const mult = 1 + lvl * 0.35;
  const cost = {
    energie: Math.ceil((b.cost?.energie || 0) * mult),
    nahrung: Math.ceil((b.cost?.nahrung || 0) * mult),
    forschung: Math.ceil((b.cost?.forschung || 0) * Math.max(0.5, lvl * 0.2)),
  };

  if (!hasResources(state.resources, cost)) return { ok: false, reason: "NotEnoughResources", cost };
  applyResources(state.resources, invertBag(cost));

  inst.level = lvl + 1;
  state.stats.buildingsUpgraded = (state.stats.buildingsUpgraded || 0) + 1;
  return { ok: true, newLevel: inst.level };
}

function countBuildings(state, buildingId) {
  return state.map.instances.filter((i) => i.type === buildingId).length;
}

function isBuildingUnlockedForEra(eras, currentEraId, buildingEraId) {
  const ci = eras.findIndex((e) => e.id === currentEraId);
  const bi = eras.findIndex((e) => e.id === buildingEraId);
  if (ci === -1 || bi === -1) return false;
  return bi <= ci;
}

// -----------------------------
// Era unlock
// -----------------------------
function canUnlockNextEra(state) {
  const eras = state.config.eras;
  const ci = eras.findIndex((e) => e.id === state.era);
  if (ci < 0) return { ok: false, reason: "UnknownEra" };
  if (ci >= eras.length - 1) return { ok: false, reason: "NoNextEra" };

  const next = eras[ci + 1];
  const req = next.unlock || {};
  const r = state.resources;

  if (Number.isFinite(req.pop) && r.bevoelkerung < req.pop) return { ok: false, reason: "ReqPop", need: req.pop };
  if (Number.isFinite(req.food) && r.nahrung < req.food) return { ok: false, reason: "ReqFood", need: req.food };
  if (Number.isFinite(req.energy) && r.energie < req.energy) return { ok: false, reason: "ReqEnergy", need: req.energy };
  if (Number.isFinite(req.research) && r.forschung < req.research) return { ok: false, reason: "ReqResearch", need: req.research };
  if (Number.isFinite(req.stability) && r.stabilitaet < req.stability) return { ok: false, reason: "ReqStability", need: req.stability };

  if (Number.isFinite(req.labs)) {
    // labs = count of a specific building type OR tag-based; hier: buildingId "forschungslabor" oder "workshop/factory" später
    const labCount =
      countBuildings(state, "forschungslabor") +
      countBuildings(state, "workshop") +
      countBuildings(state, "factory");
    if (labCount < req.labs) return { ok: false, reason: "ReqLabs", need: req.labs };
  }

  return { ok: true, nextEraId: next.id };
}

function unlockNextEra(state) {
  const chk = canUnlockNextEra(state);
  if (!chk.ok) return chk;

  const eras = state.config.eras;
  const ci = eras.findIndex((e) => e.id === state.era);
  const next = eras[ci + 1];

  // Optional: freikaufen kostet Ressourcen (damit es nicht „gratis“ ist)
  // Wenn du später andere Costs willst: hier ändern.
  const buyCost = {
    energie: Math.floor((next.unlock?.energy || 0) * 0.2),
    nahrung: Math.floor((next.unlock?.food || 0) * 0.2),
    forschung: Math.floor((next.unlock?.research || 0) * 0.2),
  };
  if (!hasResources(state.resources, buyCost)) {
    return { ok: false, reason: "NotEnoughToBuyEra", cost: buyCost };
  }
  applyResources(state.resources, invertBag(buyCost));

  state.era = next.id;
  state.stats.erasUnlocked = (state.stats.erasUnlocked || 0) + 1;
  return { ok: true, era: state.era, cost: buyCost };
}

// -----------------------------
// Tick / Economy (map.instances-based)
// -----------------------------
function computeProductionAndMaintenance(state) {
  const cfg = state.config;
  const r = state.resources;

  // Base drain (stability)
  r.stabilitaet = clamp(r.stabilitaet - 0.25, 0, 100);

  // Production & maintenance from placed buildings
  const instances = state.map.instances;

  for (const inst of instances) {
    const b = cfg.buildings[inst.type];
    if (!b) continue;

    const lvl = inst.level || 1;
    const levelMult = 1 + (lvl - 1) * 0.15;

    // produces (can include negatives)
    for (const [k, v] of Object.entries(b.produces || {})) {
      r[k] = (r[k] || 0) + v * levelMult;
    }

    // maintenance
    for (const [k, v] of Object.entries(b.maintenance || {})) {
      r[k] = (r[k] || 0) - v * (1 + (lvl - 1) * 0.12);
    }
  }

  // Population consumes food
  const pop = r.bevoelkerung || 0;
  const foodUse = pop * 0.45;
  r.nahrung = (r.nahrung || 0) - foodUse;

  // Starvation penalty
  if (r.nahrung < 0) {
    r.nahrung = 0;
    const deaths = Math.max(1, Math.floor(pop * 0.03));
    r.bevoelkerung = Math.max(1, pop - deaths);
    r.stabilitaet = clamp(r.stabilitaet - 10, 0, 100);
    state.lastTickNotes.push({
      type: "starvation",
      deaths,
      msg: `${deaths} verhungert (zu wenig Nahrung).`,
    });
  }

  // Energy floor
  if (r.energie < 0) {
    r.energie = 0;
    r.stabilitaet = clamp(r.stabilitaet - 6, 0, 100);
    state.lastTickNotes.push({
      type: "blackout_pressure",
      msg: `Energie auf 0 → Stabilität leidet.`,
    });
  }

  // Natural growth (wenn genug food + stability)
  if (r.nahrung > 40 && r.stabilitaet > 35) {
    const growth = Math.max(0, Math.floor(pop * 0.012));
    r.bevoelkerung = pop + growth;
  }

  // clamp important resources
  r.stabilitaet = clamp(r.stabilitaet, 0, 100);

  // Difficulty scaling (light)
  const t = state.tick;
  state.difficulty = 1 + Math.min(1.0, t / 1200) * 0.6;
}

function tick(state) {
  state.tick += 1;
  state.lastTickNotes = []; // reset notes for UI notifications
  computeProductionAndMaintenance(state);
  // events/enemies/challenges kommen in anderen Modulen (tick.js / challenges.js)
  return state;
}

// -----------------------------
// Helpers
// -----------------------------
function hasResources(res, cost) {
  if (!cost) return true;
  for (const [k, v] of Object.entries(cost)) {
    const need = Number(v);
    if (!Number.isFinite(need) || need <= 0) continue;
    if ((res[k] || 0) < need) return false;
  }
  return true;
}
function applyResources(res, delta) {
  for (const [k, v] of Object.entries(delta || {})) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) continue;
    res[k] = (res[k] || 0) + n;
  }
}
function invertBag(bag) {
  const out = {};
  for (const [k, v] of Object.entries(bag || {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n !== 0) out[k] = -n;
  }
  return out;
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// -----------------------------
// Create initial state
// -----------------------------
function createInitialState(opts = {}) {
  const config = loadConfigs();

  const state = {
    // config is kept in-memory so other modules can access it
    config,

    // timeline
    tick: 0,
    createdAt: Date.now(),
    difficulty: 1,

    // progression
    era: "proto",

    // core resources
    resources: {
      energie: 120,
      nahrung: 120,
      bevoelkerung: 12,
      forschung: 0,
      stabilitaet: 100,
    },

    // map-based colony
    map: createEmptyMap(opts.mapWidth || 12, opts.mapHeight || 8),

    // per-tick notes for UI (notifications)
    lastTickNotes: [],

    // stats
    stats: {
      buildingsPlaced: 0,
      buildingsUpgraded: 0,
      buildingsDemolished: 0,
      erasUnlocked: 0,
    },
  };

  // Start colony with a couple of proto buildings placed (visible immediately)
  // If those IDs don’t exist in buildings.json, we skip.
  const starter = [
    { id: "campfire", x: 1, y: 1 },
    { id: "hut", x: 3, y: 1 },
    { id: "hut", x: 4, y: 2 },
  ];
  for (const s of starter) {
    if (state.config.buildings[s.id]) {
      // ignore resource cost for starter placement
      const b = state.config.buildings[s.id];
      if (
        isInsideMap(state.map, s.x, s.y, b.footprint.w, b.footprint.h) &&
        !isBlockedByPath(state.map, s.x, s.y, b.footprint.w, b.footprint.h) &&
        !isColliding(state.map, s.x, s.y, b.footprint.w, b.footprint.h)
      ) {
        state.map.instances.push({
          id: `inst_seed_${s.id}_${Math.random().toString(36).slice(2, 6)}`,
          type: s.id,
          x: s.x,
          y: s.y,
          w: b.footprint.w,
          h: b.footprint.h,
          level: 1,
          hp: 100,
          builtAtTick: 0,
          byPlayerId: null,
        });
      }
    }
  }

  return state;
}

// -----------------------------
// Exports
// -----------------------------
module.exports = {
  loadConfigs,
  createInitialState,

  // tick
  tick,

  // map & placement
  canPlaceBuilding,
  placeBuilding,
  removeBuilding,
  upgradeBuilding,

  // era
  canUnlockNextEra,
  unlockNextEra,

  // helpers (optional)
  generateDefaultPaths,
};
