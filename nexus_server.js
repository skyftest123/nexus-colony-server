// nexus_server.js
// Kompletter Server (WebSocket + HTTP) für Nexus Colony
// - Lobbies (create/join/reconnect)
// - Tick loop (schneller, default 1500ms; via TICK_MS env anpassbar)
// - Server-authoritative Grid-Placement (place_building / upgrade_building / demolish_building)
// - Era unlock (unlock_era -> next era)
// - Skill system server-authoritative (skill_unlock)
// - Persistence via Redis (wenn REDIS_URL gesetzt) für:
//    * Lobby snapshots (damit Refresh -> wieder rein)
//    * Player progress (skillPoints/skills/era)
// - HTTP health + simple landing (Render braucht offenen Port)
//
// Voraussetzungen im Repo:
// - package.json mit "start": "node nexus_server.js"
// - src/db.js (optional; wenn nicht vorhanden, nutzt der Server direkten redis Client)
// - src/state.js (von dir bereits erstellt)
// - skills.json / eras.json / buildings.json im Repo Root (oder /data)
//
// WICHTIG: Deine UI muss auf wss://nexus-colony.onrender.com connecten.
// Wenn du UI auf forbar.de hostest, verbindet sie trotzdem korrekt zu Render (wss).

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { hasResources } = require("./src/game_rules");
const { EXPEDITION_TYPES, getAvailableExpeditions, createExpedition, resolveExpedition } = require("./src/expeditions");
const { generateDailyQuests, getDayKey, updateQuestProgress } = require("./src/daily_quests");


// --- Config ---
const PORT = Number(process.env.PORT || 3000);
const TICK_MS = Number(process.env.TICK_MS || 4000); // 4s — bewusstes Tempo
const SNAPSHOT_EVERY_TICKS = Number(process.env.SNAPSHOT_EVERY_TICKS || 3);
const LOBBY_TTL_SECONDS = Number(process.env.LOBBY_TTL_SECONDS || 60 * 60 * 12); // 12h
const MAX_PLAYERS_PER_LOBBY = Number(process.env.MAX_PLAYERS_PER_LOBBY || 4);

// --- State module ---
const {
  loadConfigs,
  createInitialState,
  tick: tickState,
  canPlaceBuilding,
  placeBuilding,
  removeBuilding,
  upgradeBuilding,
  canUnlockNextEra,
  unlockNextEra,
} = require("./src/state");

// =====================================
// Redis (optional, for persistence)
// =====================================
let redis = null;
let redisReady = false;

async function initRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    // Prefer local db.js if user created one
    // If it exports { redis } or { client }, use it.
    try {
      const db = require("./src/db");
      if (db?.redis) redis = db.redis;
      else if (db?.client) redis = db.client;
    } catch (_) {
      // ignore, fallback below
    }

    if (!redis) {
      const { createClient } = require("redis");
      redis = createClient({ url });
      redis.on("error", () => {});
      await redis.connect();
    } else {
      // If external db.js gave a client, attempt connect if needed
      if (typeof redis.connect === "function") {
        try {
          await redis.connect();
        } catch (_) {
          // might already be connected
        }
      }
    }

    redisReady = true;
    console.log("Redis connected");
    return redis;
  } catch (e) {
    console.log("Redis not available, running in-memory only");
    redis = null;
    redisReady = false;
    return null;
  }
}

function kLobby(lobbyId) {
  return `nexus:lobby:${String(lobbyId).toUpperCase()}`;
}
function kPlayer(playerId) {
  return `nexus:player:${String(playerId)}`;
}
function kPlayerLobbies(playerId) {
  return `nexus:player_lobbies:${String(playerId)}`; // set of lobbyIds
}

// =====================================
// Configs (skills/eras/buildings)
// =====================================
const PRESTIGE_SHOP = {
  prod_boost: {
    id: "prod_boost",
    name: "Produktionsschub",
    maxLevel: 5,
    cost: (lvl) => 2 + lvl,        // 2,3,4,5,6
    effect: (state, lvl) => {
      state.prestigeShop.prodMult = 1 + lvl * 0.05; // +5% pro Level
    },
  },
  upkeep_reduction: {
    id: "upkeep_reduction",
    name: "Wartungsoptimierung",
    maxLevel: 4,
    cost: (lvl) => 3 + lvl,        // 3,4,5,6
    effect: (state, lvl) => {
      state.prestigeShop.upkeepMult = 1 - lvl * 0.08; // −8% pro Level
    },
  },
  event_resilience: {
    id: "event_resilience",
    name: "Krisenresistenz",
    maxLevel: 3,
    cost: (lvl) => 4 + lvl * 2,    // 4,6,8
    effect: (state, lvl) => {
      state.prestigeShop.eventResist = 1 - lvl * 0.12; // −12% Event-Schaden
    },
  },
};

const CONFIG = loadConfigs();
const SKILL_INDEX = new Map(CONFIG.skills.map((s) => [s.id, s]));

function normalizeResourceKey(key) {
  const map = {
    energy: "energie",
    food: "nahrung",
    research: "forschung",
    stability: "stabilitaet",
    population: "bevoelkerung",
  };
  return map[String(key)] || String(key);
}

function buildEmptySkillModifiers() {
  return {
    resourceEfficiencyMult: 1,
    energyProdMult: 1,
    foodProdMult: 1,
    researchProdMult: 1,
    maintenanceCostMult: 1,
    foodConsumptionMult: 1,
    stabilityLossEventsMult: 1,
    stabilityGainFlat: 0,
    populationGrowthMult: 1,
    resourceFloorFood: 0,
    resourceFloorEnergy: 0,
    stabilityFloor: 0,
    resourceFlat: {},
  };
}

function applySkillModifier(mods, key, op, value) {
  if (!Number.isFinite(value)) return;
  switch (key) {
    case "resource_efficiency_mult":
      if (op === "mul") mods.resourceEfficiencyMult *= value;
      break;
    case "energy_prod_mult":
      if (op === "mul") mods.energyProdMult *= value;
      break;
    case "food_consumption_mult":
      if (op === "mul") mods.foodConsumptionMult *= value;
      break;
    case "research_speed_mult":
      if (op === "mul") mods.researchProdMult *= value;
      break;
    case "maintenance_cost_mult":
      if (op === "mul") mods.maintenanceCostMult *= value;
      break;
    case "stability_loss_events_mult":
      if (op === "mul") mods.stabilityLossEventsMult *= value;
      break;
    case "stability_gain_flat":
      if (op === "add") mods.stabilityGainFlat += value;
      break;
    case "population_growth_mult":
      if (op === "mul") mods.populationGrowthMult *= value;
      break;
    case "resource_floor_food":
      if (op === "set_min") mods.resourceFloorFood = Math.max(mods.resourceFloorFood, value);
      break;
    case "resource_floor_energy":
      if (op === "set_min") mods.resourceFloorEnergy = Math.max(mods.resourceFloorEnergy, value);
      break;
    case "stability_floor":
      if (op === "set_min") mods.stabilityFloor = Math.max(mods.stabilityFloor, value);
      break;
    case "income_energy_flat":
      if (op === "add") {
        const keyName = normalizeResourceKey("energy");
        mods.resourceFlat[keyName] = (mods.resourceFlat[keyName] || 0) + value;
      }
      break;
    default:
      break;
  }
}

function computeSkillModifiersForLobby(lobby) {
  const mods = buildEmptySkillModifiers();
  for (const p of lobby.players.values()) {
    const skillIds = Array.isArray(p.skills) ? p.skills : [];
    for (const id of skillIds) {
      const skill = SKILL_INDEX.get(id);
      if (!skill || !Array.isArray(skill.effects)) continue;
      for (const effect of skill.effects) {
        if (effect?.type !== "modifier") continue;
        const key = String(effect.key || "");
        const op = String(effect.op || "");
        const value = Number(effect.value);
        applySkillModifier(mods, key, op, value);
      }
    }
  }
  return mods;
}

const MILESTONES = [
  { id: "pop_25", label: "Bevölkerung 25", kind: "resource", key: "bevoelkerung", target: 25, reward: { skillPoints: 1 } },
  { id: "food_300", label: "Nahrung 300", kind: "resource", key: "nahrung", target: 300, reward: { skillPoints: 1 } },
  { id: "energy_250", label: "Energie 250", kind: "resource", key: "energie", target: 250, reward: { skillPoints: 1 } },
  { id: "research_40", label: "Forschung 40", kind: "resource", key: "forschung", target: 40, reward: { skillPoints: 1 } },
  { id: "build_10", label: "10 Gebäude gebaut", kind: "lifetime", key: "buildingsPlaced", target: 10, reward: { skillPoints: 1 } },
  { id: "auto_repair", label: "Automatisierung: Auto-Reparatur", kind: "lifetime", key: "buildingsPlaced", target: 20, reward: { skillPoints: 2, automation: { autoRepair: true } } },
  { id: "upgrade_5", label: "5 Upgrades", kind: "lifetime", key: "buildingsUpgraded", target: 5, reward: { skillPoints: 1 } },
  { id: "stability_90", label: "Stabilität 90 halten", kind: "resource", key: "stabilitaet", target: 90, reward: { skillPoints: 1 } },
  { id: "era_ancient", label: "Epoche Antike erreicht", kind: "era", key: "ancient", target: 1, reward: { skillPoints: 2, prestigeShards: 1 } },
  { id: "pop_120", label: "Bevölkerung 120", kind: "resource", key: "bevoelkerung", target: 120, reward: { skillPoints: 2 } },
  { id: "food_1200", label: "Nahrung 1200", kind: "resource", key: "nahrung", target: 1200, reward: { skillPoints: 2, prestigeShards: 1 } },
  { id: "energy_900", label: "Energie 900", kind: "resource", key: "energie", target: 900, reward: { skillPoints: 2 } },
  { id: "research_250", label: "Forschung 250", kind: "resource", key: "forschung", target: 250, reward: { skillPoints: 2, prestigeShards: 1 } },
  { id: "build_40", label: "40 Gebäude gebaut", kind: "lifetime", key: "buildingsPlaced", target: 40, reward: { skillPoints: 3 } },
  { id: "upgrade_20", label: "20 Upgrades", kind: "lifetime", key: "buildingsUpgraded", target: 20, reward: { skillPoints: 3 } },
  { id: "era_industrial", label: "Industriezeitalter erreicht", kind: "era", key: "industrial", target: 1, reward: { skillPoints: 4, prestigeShards: 2 } },
];

function getMilestoneProgress(state, progress, milestone) {
  if (milestone.kind === "resource") {
    const current = Number(state?.resources?.[milestone.key] || 0);
    return { current, target: milestone.target };
  }
  if (milestone.kind === "lifetime") {
    const current = Number(progress?.lifetime?.[milestone.key] || 0);
    return { current, target: milestone.target };
  }
  if (milestone.kind === "era") {
    const currentIdx = eraIndexById(state?.era);
    const targetIdx = eraIndexById(milestone.key);
    return { current: currentIdx >= targetIdx ? milestone.target : 0, target: milestone.target };
  }
  return { current: 0, target: milestone.target || 1 };
}

function getMilestoneStatusList(state, progress) {
  const unlocked = new Set(Array.isArray(progress?.milestones) ? progress.milestones : []);
  return MILESTONES.map((m) => {
    const { current, target } = getMilestoneProgress(state, progress, m);
    return {
      id: m.id,
      label: m.label,
      current,
      target,
      done: unlocked.has(m.id) || current >= target,
      reward: m.reward || {},
    };
  });
}

async function evaluateMilestones(lobby, playerId, progress) {
  const unlocked = new Set(Array.isArray(progress.milestones) ? progress.milestones : []);
  const newlyUnlocked = [];
  for (const m of MILESTONES) {
    if (unlocked.has(m.id)) continue;
    const { current, target } = getMilestoneProgress(lobby.state, progress, m);
    if (current >= target) {
      unlocked.add(m.id);
      newlyUnlocked.push(m);
    }
  }

  if (newlyUnlocked.length === 0) return { changed: false, newlyUnlocked: [] };

  progress.milestones = Array.from(unlocked);
  for (const m of newlyUnlocked) {
    if (Number.isFinite(m.reward?.skillPoints)) {
      grantSkillPoints(progress, m.reward.skillPoints);
    }
    if (Number.isFinite(m.reward?.prestigeShards)) {
      progress.prestigeShards = (progress.prestigeShards || 0) + m.reward.prestigeShards;
    }
    if (m.reward?.automation && typeof m.reward.automation === "object") {
      progress.automation ||= {};
      for (const [k, v] of Object.entries(m.reward.automation)) {
        if (v === true) progress.automation[k] = true;
      }
    }
  }

  await savePlayerProgress(playerId, progress);
  return { changed: true, newlyUnlocked };
}

// =====================================
// In-memory runtime lobbies (authoritative)
// =====================================
const lobbies = new Map(); // lobbyId -> Lobby

function generateLobbyCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function eraIndexById(eraId) {
  const id = String(eraId || "proto");
  const idx = CONFIG.eras.findIndex(e => String(e.id) === id);
  return idx >= 0 ? idx : 0;
}

function calcPrestigeMult(level) {
  const lvl = Math.max(0, Math.floor(Number(level || 0)));
  // linear + cap (einfach, stabil, kein Exploit)
  const mult = 1 + lvl * 0.06;     // +6% pro Prestige
  return Math.min(2.5, mult);      // max 2.5x
}

function grantSkillPoints(prog, amount) {
  const add = Math.max(0, Math.floor(Number(amount || 0)));
  if (!add) return prog;
  prog.skillPoints = Math.max(0, Math.floor(Number(prog.skillPoints || 0))) + add;
  return prog;
}

function spendResources(resources, cost) {
  for (const [k, v] of Object.entries(cost || {})) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    resources[k] = (resources[k] || 0) - n;
  }
}

function computeRepairCost(missing) {
  return {
    energie: Math.ceil(missing * 0.3),
    nahrung: Math.ceil(missing * 0.15),
  };
}

function applyOfflineProgress(state, seconds, tickMs) {
  const dtTick = Math.max(0.5, tickMs / 1000);
  const maxTicks = 240;
  const ticks = Math.min(Math.floor(seconds / dtTick), maxTicks);
  for (let i = 0; i < ticks; i++) {
    tickState(state, dtTick);
  }
  const remaining = seconds - ticks * dtTick;
  if (remaining > 0.1) {
    tickState(state, remaining);
  }
  return ticks;
}

async function handleChallengeResolve(ws, data) {
  const lr = requireLobby(ws);
  if (!lr.ok) return safeSend(ws, { type: "error", message: lr.err });

  const lobby = lr.lobby;
  const playerId = ws.playerId;

  const result = data.result;
  if (!result || !result.ok) {
    return safeSend(ws, {
      type: "notification",
      severity: "warning",
      message: "Challenge fehlgeschlagen",
    });
  }

  const reward = result.reward || {};
  const prog = await getPlayerProgress(playerId);

  // ---- Skillpunkte
  if (Number.isFinite(reward.skillPoints)) {
    grantSkillPoints(prog, reward.skillPoints);
  }

  // ---- Prestige-Shards
  if (Number.isFinite(reward.prestigeShards)) {
    prog.prestigeShards = (prog.prestigeShards || 0) + reward.prestigeShards;
  }

  // ---- Ressourcen
  if (reward.resources && typeof reward.resources === "object") {
    for (const [k, v] of Object.entries(reward.resources)) {
      const n = Number(v);
      if (Number.isFinite(n)) {
        lobby.state.resources[k] = (lobby.state.resources[k] || 0) + n;
      }
    }
  }

  await savePlayerProgress(playerId, prog);

  lobby.broadcast({
    type: "notification",
    severity: "success",
    message: `🏆 Challenge abgeschlossen (+${reward.skillPoints || 0} SP)`,
  });

  await saveLobbySnapshot(lobby.id, lobby);
  await lobby.broadcastState();
}



// =====================================
// Player progress (persisted in Redis)
// =====================================
async function getPlayerProgress(playerId) {
  const fallback = {
    skillPoints: 0,
    skills: [],
    era: "proto",
    prestigeLevel: 0,
    prestigeShards: 0,
    prestigeMult: 1,
    prestigeShop: {
      prod_boost: 0,
      upkeep_reduction: 0,
      event_resilience: 0,
    },
    milestones: [],
    automation: {
      autoRepair: false,
    },
    lastSeenAt: 0,
    lastDailyRewardAt: 0,
    lifetime: {
      buildingsPlaced: 0,
      buildingsUpgraded: 0,
      buildingsDemolished: 0,
      erasUnlocked: 0,
    },
  };

  if (!redisReady) return fallback;

  try {
    const raw = await redis.get(kPlayer(playerId));
    if (!raw) {
      await redis.set(kPlayer(playerId), JSON.stringify(fallback), { EX: LOBBY_TTL_SECONDS });
      return fallback;
    }
    const parsed = JSON.parse(raw);
    return {
      ...fallback,
      ...parsed,
      lifetime: { ...fallback.lifetime, ...(parsed.lifetime || {}) },
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      automation: { ...fallback.automation, ...(parsed.automation || {}) },
    };
  } catch (_) {
    return fallback;
  }
}

async function savePlayerProgress(playerId, progress) {
  if (!redisReady) return;
  try {
    await redis.set(kPlayer(playerId), JSON.stringify(progress), { EX: LOBBY_TTL_SECONDS });
  } catch (_) {}
}

async function addLobbyToPlayerIndex(playerId, lobbyId) {
  if (!redisReady) return;
  try {
    await redis.sAdd(kPlayerLobbies(playerId), String(lobbyId).toUpperCase());
    await redis.expire(kPlayerLobbies(playerId), LOBBY_TTL_SECONDS);
  } catch (_) {}
}

async function removeLobbyFromPlayerIndex(playerId, lobbyId) {
  if (!redisReady) return;
  try {
    await redis.sRem(kPlayerLobbies(playerId), String(lobbyId).toUpperCase());
  } catch (_) {}
}

// =====================================
// Lobby persistence (snapshot)
// =====================================
async function loadLobbySnapshot(lobbyId) {
  if (!redisReady) return null;
  try {
    const raw = await redis.get(kLobby(lobbyId));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.state?.prestige) {
      data.state.prestige = data.state.prestige;
    }
    // Ensure config stays current (don't persist config)
    if (data?.state) {
      data.state.config = CONFIG;
    }
    return data;
  } catch (_) {
    return null;
  }
}

async function saveLobbySnapshot(lobbyId, lobbyObj) {
  if (!redisReady) return;
  try {
    // Persist minimal state (no sockets)
    const snapshot = {
      lobbyId,
      createdAt: lobbyObj.createdAt,
      tick: lobbyObj.state.tick,
      era: lobbyObj.state.era,
      resources: lobbyObj.state.resources,
      map: lobbyObj.state.map,
      stats: lobbyObj.state.stats,
      prestige: lobbyObj.state.prestige,
      prestigeShop: lobbyObj.state.prestigeShop,
      activeEvent: lobbyObj.state.activeEvent,
      special: lobbyObj.state.special,
      specialBuff: lobbyObj.state.specialBuff,
      _expeditions: lobbyObj.expeditions || [],
      _dailyQuests: lobbyObj.dailyQuests || [],
      _dailyStats: lobbyObj.dailyStats || {},
      // lightweight roster for UI list
      players: Array.from(lobbyObj.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        joinedAt: p.joinedAt,
        online: Boolean(p.ws && p.ws.readyState === WebSocket.OPEN),
      })),
    };

    await redis.set(kLobby(lobbyId), JSON.stringify(snapshot), { EX: LOBBY_TTL_SECONDS });
  } catch (_) {}
}

// =====================================
// Lobby class
// =====================================
// =====================================
// Role system (8 roles, real unique bonuses)
// =====================================
const ROLE_DEFINITIONS = {
  engineer:    { name: "Ingenieur",   icon: "⚙️",  desc: "Energieproduktion +15%, Gebäude-Reparatur kostet 20% weniger" },
  researcher:  { name: "Forscher",    icon: "🔬",  desc: "Forschungsproduktion +20%, Expeditionsdauer -10%" },
  logistician: { name: "Logistiker",  icon: "📦",  desc: "Nahrungsproduktion +15%, Wartungskosten -10%" },
  diplomat:    { name: "Diplomat",    icon: "🕊️",  desc: "Stabilitätsproduktion +20%, Krisen-Schaden -15%" },
  military:    { name: "Militär",     icon: "⚔️",  desc: "Krisen-Resistenz +20%, Stabilität verliert langsamer" },
  medic:       { name: "Mediziner",   icon: "🏥",  desc: "Bevölkerungswachstum +25%, Krisen-Erholung verdoppelt" },
  trader:      { name: "Händler",     icon: "🐪",  desc: "Alle Handelsrouten +30% Ertrag, seltene Expeditionen verfügbar" },
  pioneer:     { name: "Pionier",     icon: "🗺️",  desc: "Expeditionsdauer -25%, Expedition-Belohnungen +20%" },
};

function computeRoleBonuses(lobby) {
  const bonuses = {
    energyMult: 1,
    foodMult: 1,
    researchMult: 1,
    stabilityMult: 1,
    populationMult: 1,
    crisisResistBonus: 0,       // flat reduction of crisis damage
    maintenanceMult: 1,
    expeditionDurationMult: 1,  // <1 = faster
    expeditionRewardMult: 1,
    hasTrader: false,
    hasMilitary: false,
    hasMedic: false,
  };

  for (const p of lobby.players.values()) {
    switch (p.role) {
      case "engineer":
        bonuses.energyMult += 0.15;
        break;
      case "researcher":
        bonuses.researchMult += 0.20;
        bonuses.expeditionDurationMult *= 0.90;
        break;
      case "logistician":
        bonuses.foodMult += 0.15;
        bonuses.maintenanceMult *= 0.90;
        break;
      case "diplomat":
        bonuses.stabilityMult += 0.20;
        bonuses.crisisResistBonus += 0.15;
        break;
      case "military":
        bonuses.crisisResistBonus += 0.20;
        bonuses.hasMilitary = true;
        break;
      case "medic":
        bonuses.populationMult += 0.25;
        bonuses.hasMedic = true;
        break;
      case "trader":
        bonuses.hasTrader = true;
        bonuses.expeditionRewardMult += 0.30;
        break;
      case "pioneer":
        bonuses.expeditionDurationMult *= 0.75;
        bonuses.expeditionRewardMult += 0.20;
        break;
    }
  }

  // Team Synergy: more distinct online roles = bonus for everyone
  const onlineRoles = new Set();
  for (const p of lobby.players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN && p.role) onlineRoles.add(p.role);
  }
  const synergyLevel = onlineRoles.size;
  // 2 roles = +5%, 3 roles = +12%, 4+ roles = +22%
  const synergyMult = synergyLevel >= 4 ? 1.22 : synergyLevel >= 3 ? 1.12 : synergyLevel >= 2 ? 1.05 : 1.0;
  bonuses.synergyMult = synergyMult;
  bonuses.synergyLevel = synergyLevel;

  // Apply synergy to all production multipliers
  if (synergyMult > 1) {
    bonuses.energyMult *= synergyMult;
    bonuses.foodMult *= synergyMult;
    bonuses.researchMult *= synergyMult;
    bonuses.stabilityMult *= synergyMult;
    bonuses.populationMult *= synergyMult;
  }

  // Cap multipliers to prevent runaway
  bonuses.energyMult = Math.min(2.0, bonuses.energyMult);
  bonuses.foodMult = Math.min(2.0, bonuses.foodMult);
  bonuses.researchMult = Math.min(2.0, bonuses.researchMult);
  bonuses.stabilityMult = Math.min(2.0, bonuses.stabilityMult);
  bonuses.populationMult = Math.min(2.0, bonuses.populationMult);
  bonuses.crisisResistBonus = Math.min(0.60, bonuses.crisisResistBonus);
  bonuses.expeditionDurationMult = Math.max(0.4, bonuses.expeditionDurationMult);
  bonuses.expeditionRewardMult = Math.min(2.0, bonuses.expeditionRewardMult);
  bonuses.maintenanceMult = Math.max(0.5, bonuses.maintenanceMult);

  return bonuses;
}


class Lobby {
  constructor(lobbyId, seededState = null) {
    this.id = String(lobbyId).toUpperCase();
    this.players = new Map();
    this.maxPlayers = MAX_PLAYERS_PER_LOBBY;
    this.createdAt = Date.now();

    this.state = seededState || createInitialState();
    this.state.config = CONFIG;

    // Expedition & daily quest state
    const today = getDayKey();
    this.expeditions = seededState?._expeditions || [];
    this.dailyQuests = seededState?._dailyQuests || generateDailyQuests(today, 0);
    this.dailyStats = seededState?._dailyStats || {
      dailyBuilds: 0,
      dailyUpgrades: 0,
      dailyCrisesSurvived: 0,
      dailyExpeditions: 0,
      currentPlayerCount: 0,
      lastResetDay: today,
    };

    this._tickInterval = null;
    this._lastSnapshotTick = 0;
    this._recentBuilds = [];   // for hot streak detection
    this._prevSynergyLevel = 0;
    this._resourceMilestones = new Set(); // already celebrated
    this._tickStart();
  }

  _tickStart() {
    this._tickInterval = setInterval(() => this.processTick(), TICK_MS);
  }

  _tickStop() {
    if (this._tickInterval) clearInterval(this._tickInterval);
    this._tickInterval = null;
  }

  getPlayersList() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      online: Boolean(p.ws && p.ws.readyState === WebSocket.OPEN),
    }));
  }

  addOrReconnectPlayer(playerId, playerName, role, ws) {
    const id = String(playerId);

    if (this.players.has(id)) {
      const p = this.players.get(id);
      p.ws = ws;
      p.name = playerName || p.name;
      p.role = role || p.role;
      p.lastSeenTick = this.state.tick;
      return { ok: true, reconnect: true };
    }

    if (this.players.size >= this.maxPlayers) {
      return { ok: false, message: "Lobby voll" };
    }

    this.players.set(id, {
      id,
      name: playerName || "Commander",
      role: role || "engineer",
      ws,
      joinedAt: Date.now(),
      lastSeenTick: this.state.tick,
    });

    return { ok: true, reconnect: false };
  }

  removePlayer(playerId) {
    const p = this.players.get(String(playerId));
    if (p) {
      p.ws = null;
      p.lastSeenTick = this.state.tick;
    }
  }

  broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(payload);
      }
    }
  }

  async broadcastState() {
    const stateCopy = JSON.parse(JSON.stringify(this.state));
    delete stateCopy.config;

    for (const p of this.players.values()) {
      if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;

      const prog = await getPlayerProgress(p.id);
      const automation = prog.automation || {};
      const player = this.players.get(p.id);
      if (player) {
        player.automation = automation;
      }
      const milestoneList = getMilestoneStatusList(stateCopy, prog);
      const pendingMilestones = milestoneList
        .filter((m) => !m.done)
        .sort((a, b) => (a.target - a.current) - (b.target - b.current))
        .slice(0, 4);
      const displayMilestones = pendingMilestones.length > 0 ? pendingMilestones : milestoneList.slice(-4);

      const eraIdx = eraIndexById(stateCopy.era);
      const roleBonuses = this.state.roleBonuses || {};
      const availableExpeditions = getAvailableExpeditions(eraIdx, roleBonuses.hasTrader || false);

      // daily quest reset check
      const today = getDayKey();
      if (this.dailyStats.lastResetDay !== today) {
        this.dailyStats = { dailyBuilds: 0, dailyUpgrades: 0, dailyCrisesSurvived: 0, dailyExpeditions: 0, currentPlayerCount: this.players.size, lastResetDay: today };
        this.dailyQuests = generateDailyQuests(today, eraIdx);
      }
      this.dailyStats.currentPlayerCount = Array.from(this.players.values()).filter(pl => pl.ws && pl.ws.readyState === WebSocket.OPEN).length;
      updateQuestProgress(this.dailyQuests, this.state, this.dailyStats);

      // Re-check after await — player may have disconnected during async getPlayerProgress
      if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;

      p.ws.send(
        JSON.stringify({
          type: "update_state",
          state: {
            currentTick: stateCopy.tick,
            tick: stateCopy.tick,
            era: stateCopy.era,
            difficultyMultiplier: stateCopy.difficulty,
            resources: stateCopy.resources,
            ressourcen: stateCopy.resources,
            map: stateCopy.map,
            stats: stateCopy.stats,
            activeEvents: stateCopy.activeEvent ? [stateCopy.activeEvent] : [],
            special: stateCopy.special,
            specialBuff: stateCopy.specialBuff,
            roleBonuses: this.state.roleBonuses || {},
            enemies: stateCopy.enemies || [],
            lastTickNotes: stateCopy.lastTickNotes || [],
          },
          players: this.getPlayersList(),
          progress: prog,
          eras: CONFIG.eras,
          milestones: displayMilestones,
          expeditions: this.expeditions,
          availableExpeditions,
          dailyQuests: this.dailyQuests,
          roleDefinitions: ROLE_DEFINITIONS,
        })
      );
    }
  }
  
  async processTick() {
    // no instant "event spam": we don't inject events here yet
    const dt = TICK_MS / 1000;
    this.state.roleBonuses = computeRoleBonuses(this);
    this.state.skillModifiers = computeSkillModifiersForLobby(this);
    tickState(this.state, dt);

    const automationEnabled = Array.from(this.players.values()).some((p) => p.automation?.autoRepair);
    if (automationEnabled && this.state.tick % 3 === 0) {
      const instances = Array.isArray(this.state.map?.instances) ? this.state.map.instances : [];
      let repaired = 0;
      for (const inst of instances) {
        if (repaired >= 3) break;
        const missing = 100 - (inst.condition ?? 100);
        if (missing < 20) continue;
        const cost = computeRepairCost(missing);
        if (!hasResources(this.state.resources, cost)) break;
        spendResources(this.state.resources, cost);
        inst.condition = 100;
        repaired += 1;
      }
      if (repaired > 0) {
        this.broadcast({
          type: "notification",
          severity: "info",
          message: `🤖 Auto-Reparatur durchgeführt (${repaired} Gebäude).`,
        });
      }
    }

    if (this.state.tick % 4 === 0) {
      for (const p of this.players.values()) {
        const prog = await getPlayerProgress(p.id);
        const res = await evaluateMilestones(this, p.id, prog);
        if (res.changed) {
          for (const m of res.newlyUnlocked) {
            this.broadcast({
              type: "notification",
              severity: "success",
              message: `🎯 Ziel erreicht: ${m.label} (+${m.reward?.skillPoints || 0} SP)`,
            });
          }
        }
      }
    }


    // ── Team Synergy Change Broadcast ──────────────────────────
    const curSynergy = this.state.roleBonuses?.synergyLevel || 0;
    if (curSynergy !== this._prevSynergyLevel) {
      const prev = this._prevSynergyLevel;
      this._prevSynergyLevel = curSynergy;
      if (curSynergy > prev && curSynergy >= 2) {
        const msg = curSynergy >= 4
          ? "🌟 VOLLE SYNERGIE! Alle Rollen aktiv → +22% auf alles!"
          : curSynergy >= 3
          ? "⚡ Team-Synergie! 3 Rollen online → +12% auf alles!"
          : "🤝 Team komplett! 2 Rollen online → +5% auf alles!";
        this.broadcast({ type: "team_synergy", level: curSynergy, message: msg });
      }
    }

    // ── Glücksfall (Lucky Drop) — 0.5% chance per tick ────────
    if (Math.random() < 0.005) {
      const eraIdx = eraIndexById(this.state.era);
      const dropTable = [
        { resource: "energie",     amount: Math.floor((60  + Math.random() * 140) * (1 + eraIdx * 0.5)) },
        { resource: "nahrung",     amount: Math.floor((50  + Math.random() * 100) * (1 + eraIdx * 0.4)) },
        { resource: "forschung",   amount: Math.floor((15  + Math.random() * 50)  * (1 + eraIdx * 0.6)) },
        { resource: "stabilitaet", amount: Math.min(25, Math.floor(8 + Math.random() * 17)) },
      ];
      const drop = dropTable[Math.floor(Math.random() * dropTable.length)];
      const r = this.state.resources;
      r[drop.resource] = Math.min((r[drop.resource] || 0) + drop.amount, drop.resource === "stabilitaet" ? 100 : 999999);
      this.broadcast({ type: "lucky_drop", resource: drop.resource, amount: drop.amount });
    }

    // ── Resource Milestone Celebrations ───────────────────────
    const milestoneChecks = [
      { key: "energie",     val: 500,   msg: "⚡ 500 Energie!",       icon: "⚡" },
      { key: "energie",     val: 2000,  msg: "⚡ 2000 Energie!",      icon: "⚡" },
      { key: "energie",     val: 10000, msg: "⚡ 10.000 Energie!",    icon: "⚡" },
      { key: "nahrung",     val: 500,   msg: "🌾 500 Nahrung!",       icon: "🌾" },
      { key: "nahrung",     val: 2000,  msg: "🌾 2000 Nahrung!",      icon: "🌾" },
      { key: "bevoelkerung",val: 100,   msg: "👥 100 Einwohner!",     icon: "👥" },
      { key: "bevoelkerung",val: 500,   msg: "👥 500 Einwohner!",     icon: "👥" },
      { key: "bevoelkerung",val: 1000,  msg: "👥 1000 Einwohner!",    icon: "👥" },
      { key: "forschung",   val: 300,   msg: "🧠 300 Forschung!",     icon: "🧠" },
      { key: "forschung",   val: 1000,  msg: "🧠 1000 Forschung!",    icon: "🧠" },
      { key: "stabilitaet", val: 90,    msg: "🛡️ Stabilität 90+!",    icon: "🛡️" },
    ];
    const res = this.state.resources;
    for (const mc of milestoneChecks) {
      const mKey = `${mc.key}_${mc.val}`;
      if (!this._resourceMilestones.has(mKey) && (res[mc.key] || 0) >= mc.val) {
        this._resourceMilestones.add(mKey);
        this.broadcast({ type: "resource_milestone", message: mc.msg, icon: mc.icon, value: mc.val });
      }
    }

    // Auto-resolve completed expeditions
    const tick = this.state.tick;
    const roleBonuses = this.state.roleBonuses || {};
    const activeExpeditions = this.expeditions.filter(e => e.status === "active");
    for (const exp of activeExpeditions) {
      if (tick >= exp.returnsAtTick) {
        const result = resolveExpedition(exp);
        if (result.ok) {
          exp.status = "success";
          // Scale reward by role bonuses
          const rewardMult = roleBonuses.expeditionRewardMult || 1;
          const reward = result.reward || {};
          for (const [k, v] of Object.entries(reward)) {
            const scaled = Math.round(Number(v) * rewardMult);
            if (k === "skillPoints") {
              // give to all players equally
              for (const p of this.players.values()) {
                getPlayerProgress(p.id).then(prog => {
                  grantSkillPoints(prog, scaled);
                  return savePlayerProgress(p.id, prog);
                }).catch(() => {});
              }
            } else if (k === "prestigeShards") {
              for (const p of this.players.values()) {
                getPlayerProgress(p.id).then(prog => {
                  prog.prestigeShards = (prog.prestigeShards || 0) + scaled;
                  return savePlayerProgress(p.id, prog);
                }).catch(() => {});
              }
            } else {
              this.state.resources[k] = (this.state.resources[k] || 0) + scaled;
            }
          }
          exp.resolvedReward = reward;
          const rewardStr = Object.entries(reward).map(([k, v]) => `+${Math.round(Number(v) * rewardMult)} ${k}`).join(", ");
          this.broadcast({ type: "notification", severity: "success", message: `🗺️ Expedition zurück: ${exp.type} — ${rewardStr}` });
        } else {
          exp.status = "failed";
          this.broadcast({ type: "notification", severity: "warning", message: `💀 Expedition gescheitert: ${exp.type}` });
        }
      }
    }
    // Clean up old resolved expeditions (keep last 10)
    this.expeditions = this.expeditions.filter(e => e.status === "active" || e.status === "success" || e.status === "failed").slice(-20);

    // Track crisis survived for daily quests
    if (this.state._prevHadCrisis && !this.state.activeEvent) {
      this.dailyStats.dailyCrisesSurvived = (this.dailyStats.dailyCrisesSurvived || 0) + 1;
    }
    this.state._prevHadCrisis = !!this.state.activeEvent;

    // small "always something happens": if resources increased, UI can pulse; client already does
    // server sends tick notes for notifications (starvation/blackout_pressure etc)
    if (Array.isArray(this.state.lastTickNotes) && this.state.lastTickNotes.length > 0) {
      for (const n of this.state.lastTickNotes) {
        this.broadcast({
          type: "notification",
          severity: n.type === "starvation" ? "critical" : "warning",
          message: n.msg || "Tick Hinweis",
        });
      }
    }

    // snapshot periodically
    if (redisReady && (this.state.tick - this._lastSnapshotTick >= SNAPSHOT_EVERY_TICKS)) {
      this._lastSnapshotTick = this.state.tick;
      await saveLobbySnapshot(this.id, this);
    }

    // broadcast every tick (tick is fast; still ok for small lobbies)
    await this.broadcastState();

    // If everyone offline and redis is on, we can keep ticking (so lobbies "laufen weiter")
    // If redis is off, still keep ticking as long as server runs.
  }
}

// =====================================
// HTTP server (Render needs port bound)
// =====================================
const server = http.createServer(async (req, res) => {
  const urlPath = String(req.url || "").split("?")[0];
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (urlPath === "/favicon.ico") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (urlPath === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain", ...corsHeaders });
    res.end("ok");
    return;
  }

  const dataMap = {
    "/skills.json": "skills.json",
    "/eras.json": "eras.json",
    "/buildings.json": "buildings.json",
    "/data/skills.json": "skills.json",
    "/data/eras.json": "eras.json",
    "/data/buildings.json": "buildings.json",
  };
  const dataFile = dataMap[urlPath];
  if (dataFile) {
    const filePath = path.join(__dirname, "data", dataFile);
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
      res.end(raw);
    } catch (_) {
      res.writeHead(404, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: "Not found" }));
    }
    return;
  }

  // Simple landing
  res.writeHead(200, { "Content-Type": "text/plain", ...corsHeaders });
  res.end("Nexus Colony Server is running.\nWebSocket endpoint: /\n");
});

// =====================================
// WebSocket server
// =====================================
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", async (buf) => {
    let data = null;
    try {
      data = JSON.parse(buf.toString("utf8"));
    } catch (_) {
      safeSend(ws, { type: "error", message: "Ungültige Nachricht (JSON)" });
      return;
    }
    await handleMessage(ws, data);
  });

  ws.on("close", async () => {
    try {
      const lobbyId = ws.lobbyId;
      const playerId = ws.playerId;
      if (lobbyId && lobbies.has(lobbyId)) {
        const lobby = lobbies.get(lobbyId);
        lobby.removePlayer(playerId);
        if (playerId) {
          const prog = await getPlayerProgress(playerId);
          prog.lastSeenAt = Date.now();
          await savePlayerProgress(playerId, prog);
        }
        await saveLobbySnapshot(lobbyId, lobby);
      }
    } catch (_) {}
  });
});

// ping/pong keepalive
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {}
  });
}, 30000);

// =====================================
// Protocol handlers
// =====================================
async function handleMessage(ws, data) {
  const type = String(data.type || "");

  switch (type) {
    case "create_lobby":
      return handleCreateLobby(ws, data);

    case "join_lobby":
      return handleJoinLobby(ws, data);

    case "reconnect_lobby":
      return handleReconnectLobby(ws, data);

    case "prestige_buy":
      return handlePrestigeBuy(ws, data);
      
    case "leave_lobby":
      return handleLeaveLobby(ws);

    case "list_my_colonies":
      return handleListMyColonies(ws, data);

    case "repair_building":
      return handleRepairBuilding(ws, data);

    case "use_special":
      return handleUseSpecial(ws);
      
    // Placement building on grid
    case "place_building":
      return handlePlaceBuilding(ws, data);

    // Upgrade by instanceId
    case "upgrade_building":
      return handleUpgradeBuilding(ws, data);

    // Demolish by instanceId
    case "demolish_building":
      return handleDemolishBuilding(ws, data);

    // Era unlock (next era)
    case "unlock_era":
      return handleUnlockEra(ws, data);

    // Skill
    case "skill_unlock":
      return handleSkillUnlock(ws, data);

    // Backward compatibility with your previous UI buttons:
    case "build":
      // UI may only send buildingType; without x,y -> we auto-place at first free spot.
      return handleBuildLegacy(ws, data);

    case "challenge_resolve":
      return handleChallengeResolve(ws, data);

    case "send_expedition":
      return handleSendExpedition(ws, data);

    case "claim_daily_quest":
      return handleClaimDailyQuest(ws, data);

    case "gamble_bonus":
      return handleGambleBonus(ws, data);

    default:
      safeSend(ws, { type: "error", message: "Unbekannter Nachrichtentyp: " + type });
      return;
  }
}

async function handleGambleBonus(ws, data) {
  const p = getPlayerByWs(ws);
  if (!p?.lobbyId) return;
  const lobby = lobbies.get(p.lobbyId);
  if (!lobby?.state) return;

  const outcome = String(data.outcome || "win");
  const BONUS = {
    jackpot: { energie: 30, nahrung: 30, forschung: 15 },
    win:     { energie: 12, nahrung: 12, forschung: 5  },
  };
  const rewards = BONUS[outcome] || BONUS.win;
  const r = lobby.state.resources;
  if (r) {
    r.energie    = (r.energie    || 0) + (rewards.energie    || 0);
    r.nahrung    = (r.nahrung    || 0) + (rewards.nahrung    || 0);
    r.forschung  = (r.forschung  || 0) + (rewards.forschung  || 0);
  }
  // Don't broadcastState here — will happen on next tick
}

async function handlePrestigeBuy(ws, data) {
  const lr = requireLobby(ws);
  if (!lr.ok) return safeSend(ws, { type: "error", message: lr.err });
  const lobby = lr.lobby;

  const itemId = String(data.itemId || "");
  const item = PRESTIGE_SHOP[itemId];
  if (!item) return safeSend(ws, { type: "error", message: "Unbekanntes Prestige-Item" });

  const prog = await getPlayerProgress(ws.playerId);
  prog.prestigeShop ||= {};
  const curLvl = Number(prog.prestigeShop[itemId] || 0);

  if (curLvl >= item.maxLevel) {
    return safeSend(ws, { type: "notification", severity: "info", message: "Max-Level erreicht" });
  }

  const cost = item.cost(curLvl);
  if ((prog.prestigeShards || 0) < cost) {
    return safeSend(ws, { type: "notification", severity: "warning", message: "Nicht genug Shards" });
  }

  prog.prestigeShards -= cost;
  prog.prestigeShop[itemId] = curLvl + 1;

  await savePlayerProgress(ws.playerId, prog);

  // Re-apply shop effects to state
  lobby.state.prestigeShop ||= {};
  item.effect(lobby.state, prog.prestigeShop[itemId]);

  lobby.broadcast({
    type: "notification",
    severity: "success",
    message: `✨ Prestige gekauft: ${item.name} (Level ${prog.prestigeShop[itemId]})`,
  });

  await saveLobbySnapshot(lobby.id, lobby);
  await lobby.broadcastState();
}

async function handleUseSpecial(ws) {
  const lr = requireLobby(ws);
  if (!lr.ok) return safeSend(ws, { type: "error", message: lr.err });
  const lobby = lr.lobby;
  const tick = Number(lobby.state.tick || 0);

  lobby.state.special ||= { cooldownUntilTick: 0 };
  if (tick < lobby.state.special.cooldownUntilTick) {
    return safeSend(ws, {
      type: "notification",
      severity: "warning",
      message: `Spezialaktion lädt noch (${lobby.state.special.cooldownUntilTick - tick} Ticks).`,
    });
  }

  const eraIdx = eraIndexById(lobby.state.era);

  if (lobby.state.activeEvent) {
    const cost = {
      energie: 30 + eraIdx * 35,
      nahrung: 20 + eraIdx * 25,
    };
    if (!hasResources(lobby.state.resources, cost)) {
      return safeSend(ws, {
        type: "notification",
        severity: "warning",
        message: "Nicht genug Ressourcen für Krisen-Notfallmaßnahme.",
      });
    }
    spendResources(lobby.state.resources, cost);
    const cleared = lobby.state.activeEvent.type;
    lobby.state.activeEvent = null;
    lobby.state.special.cooldownUntilTick = tick + 18;
    lobby.broadcast({
      type: "notification",
      severity: "success",
      message: `🛡️ Krise neutralisiert (${cleared}).`,
    });
  } else {
    const cost = {
      energie: 45 + eraIdx * 40,
      nahrung: 30 + eraIdx * 30,
    };
    if (!hasResources(lobby.state.resources, cost)) {
      return safeSend(ws, {
        type: "notification",
        severity: "warning",
        message: "Nicht genug Ressourcen für Overdrive.",
      });
    }
    spendResources(lobby.state.resources, cost);
    lobby.state.specialBuff = {
      endsAtTick: tick + 24,
      prodMult: 1.2 + eraIdx * 0.05,
    };
    lobby.state.special.cooldownUntilTick = tick + 32;
    lobby.broadcast({
      type: "notification",
      severity: "success",
      message: "⚡ Overdrive aktiviert: Produktion erhöht!",
    });
  }

  await saveLobbySnapshot(lobby.id, lobby);
  await lobby.broadcastState();
}

// =====================================
// Lobby management
// =====================================
async function handleCreateLobby(ws, data) {
  const playerId = String(data.playerId || "");
  if (!playerId) return safeSend(ws, { type: "error", message: "playerId fehlt" });

  const playerName = String(data.playerName || "Commander");
  const role = String(data.role || "engineer");

  // create lobby
  const lobbyId = generateLobbyCode();
  const lobby = new Lobby(lobbyId);

  lobbies.set(lobbyId, lobby);

  ws.lobbyId = lobbyId;
  ws.playerId = playerId;

  lobby.addOrReconnectPlayer(playerId, playerName, role, ws);

  // ensure progress exists
  const prog = await getPlayerProgress(playerId);
  if (!prog.era) prog.era = "proto";
  const now = Date.now();
  if (now - (prog.lastDailyRewardAt || 0) > 1000 * 60 * 60 * 24) {
    prog.lastDailyRewardAt = now;
    grantSkillPoints(prog, 1);
    prog.prestigeShards = (prog.prestigeShards || 0) + 1;
    safeSend(ws, { type: "notification", severity: "success", message: "🎁 Tagesbonus: +1 SP, +1 Shard" });
  }
  prog.lastSeenAt = now;
  await savePlayerProgress(playerId, prog);
  const playerEntry = lobby.players.get(playerId);
  if (playerEntry) {
    playerEntry.skills = Array.isArray(prog.skills) ? prog.skills : [];
    playerEntry.automation = prog.automation || {};
  }
  lobby.state.skillModifiers = computeSkillModifiersForLobby(lobby);

  await addLobbyToPlayerIndex(playerId, lobbyId);

  safeSend(ws, { type: "lobby_created", lobbyId });

  // snapshot
  await saveLobbySnapshot(lobbyId, lobby);
  await lobby.broadcastState();
}

async function handleJoinLobby(ws, data) {
  const lobbyId = String(data.lobbyId || "").toUpperCase();
  const playerId = String(data.playerId || "");
  if (!lobbyId) return safeSend(ws, { type: "error", message: "lobbyId fehlt" });
  if (!playerId) return safeSend(ws, { type: "error", message: "playerId fehlt" });

  const playerName = String(data.playerName || "Commander");
  const role = String(data.role || "engineer");

  let lobby = lobbies.get(lobbyId);

  // if not in memory, try load from redis
  if (!lobby) {
    const snap = await loadLobbySnapshot(lobbyId);
    if (snap) {
      const seeded = createInitialState();
      seeded.config = CONFIG;

      // restore from snapshot
      seeded.tick = Number(snap.tick || 0);
      seeded.era = String(snap.era || "proto");
      seeded.resources = snap.resources || seeded.resources;
      seeded.map = snap.map || seeded.map;
      seeded.stats = snap.stats || seeded.stats;
      seeded.activeEvent = snap.activeEvent || seeded.activeEvent;
      seeded.special = snap.special || seeded.special;
      seeded.specialBuff = snap.specialBuff || seeded.specialBuff;
      seeded._expeditions = snap._expeditions || [];
      seeded._dailyQuests = snap._dailyQuests || null;
      seeded._dailyStats = snap._dailyStats || null;

      lobby = new Lobby(lobbyId, seeded);
      lobby.createdAt = snap.createdAt || lobby.createdAt;

      // rehydrate players roster (offline)
      if (Array.isArray(snap.players)) {
        for (const sp of snap.players) {
          lobby.players.set(String(sp.id), {
            id: String(sp.id),
            name: String(sp.name || "Commander"),
            role: String(sp.role || "engineer"),
            ws: null,
            joinedAt: sp.joinedAt || Date.now(),
            lastSeenTick: lobby.state.tick,
          });
        }
      }

      lobbies.set(lobbyId, lobby);
    }
  }

  if (!lobby) return safeSend(ws, { type: "error", message: "Lobby nicht gefunden" });

  ws.lobbyId = lobbyId;
  ws.playerId = playerId;

  const result = lobby.addOrReconnectPlayer(playerId, playerName, role, ws);
  // ensure prestige is present in lobby state (authoritative via player progress)
  const prog = await getPlayerProgress(playerId);
  const now = Date.now();
  lobby.state.roleBonuses = computeRoleBonuses(lobby);
  lobby.state.skillModifiers = computeSkillModifiersForLobby(lobby);
  const elapsedSec = Math.max(0, Math.min(60 * 60 * 4, (now - (prog.lastSeenAt || now)) / 1000));
  if (elapsedSec > 15) {
    const before = { ...lobby.state.resources };
    const ticksSimulated = applyOfflineProgress(lobby.state, elapsedSec, TICK_MS);
    const after = lobby.state.resources || {};
    const diffE = Math.max(0, Math.floor((after.energie || 0) - (before.energie || 0)));
    const diffF = Math.max(0, Math.floor((after.nahrung || 0) - (before.nahrung || 0)));
    const diffP = Math.max(0, Math.floor((after.bevoelkerung || 0) - (before.bevoelkerung || 0)));
    const diffR = Math.max(0, Math.floor((after.forschung || 0) - (before.forschung || 0)));
    safeSend(ws, {
      type: "notification",
      severity: "success",
      message: `⏳ Offline-Fortschritt: +${diffE} Energie, +${diffF} Nahrung, +${diffP} Bevölkerung, +${diffR} Forschung (${Math.floor(elapsedSec)}s, ${ticksSimulated} Ticks).`,
    });
  }

  if (now - (prog.lastDailyRewardAt || 0) > 1000 * 60 * 60 * 24) {
    prog.lastDailyRewardAt = now;
    grantSkillPoints(prog, 1);
    prog.prestigeShards = (prog.prestigeShards || 0) + 1;
    safeSend(ws, { type: "notification", severity: "success", message: "🎁 Tagesbonus: +1 SP, +1 Shard" });
  }
  prog.lastSeenAt = now;
  await savePlayerProgress(playerId, prog);
  if (!lobby.state.prestige) lobby.state.prestige = { level: 0, mult: 1 };

  // ---- apply prestige core bonus
  lobby.state.prestige = {
    level: prog.prestigeLevel || 0,
    mult: prog.prestigeMult || 1,
  };
  
  // ---- apply prestige shop effects
  lobby.state.prestigeShop ||= { prodMult: 1, upkeepMult: 1, eventResist: 1 };
  
  for (const [id, lvl] of Object.entries(prog.prestigeShop || {})) {
    const item = PRESTIGE_SHOP[id];
    if (item && lvl > 0) {
      item.effect(lobby.state, lvl);
    }
  }
  const playerEntry = lobby.players.get(playerId);
  if (playerEntry) {
    playerEntry.skills = Array.isArray(prog.skills) ? prog.skills : [];
    playerEntry.automation = prog.automation || {};
  }
  lobby.state.skillModifiers = computeSkillModifiersForLobby(lobby);
  if (!result.ok) return safeSend(ws, { type: "error", message: result.message || "Join fehlgeschlagen" });

  await addLobbyToPlayerIndex(playerId, lobbyId);

  safeSend(ws, { type: "lobby_joined", lobbyId });
  await saveLobbySnapshot(lobbyId, lobby);
  await lobby.broadcastState();
}

async function handleReconnectLobby(ws, data) {
  // same as join, but without role/name changes required
  return handleJoinLobby(ws, data);
}

async function handleLeaveLobby(ws) {
  const lobbyId = ws.lobbyId;
  const playerId = ws.playerId;
  if (!lobbyId || !playerId) return;

  const lobby = lobbies.get(lobbyId);
  if (lobby) {
    lobby.removePlayer(playerId);
    const prog = await getPlayerProgress(playerId);
    prog.lastSeenAt = Date.now();
    await savePlayerProgress(playerId, prog);
    await saveLobbySnapshot(lobbyId, lobby);
    await lobby.broadcastState();
  }

  ws.lobbyId = null;
  ws.playerId = null;
}

async function handleListMyColonies(ws, data) {
  const playerId = String(data.playerId || ws.playerId || "");
  if (!playerId) return safeSend(ws, { type: "error", message: "playerId fehlt" });

  if (!redisReady) {
    return safeSend(ws, {
      type: "my_colonies",
      colonies: [],
      note: "Redis nicht aktiv → keine Persistenz-Liste verfügbar.",
    });
  }

  try {
    const ids = await redis.sMembers(kPlayerLobbies(playerId));
    const colonies = [];
    for (const id of ids) {
      const snap = await loadLobbySnapshot(id);
      if (!snap) continue;
      colonies.push({
        lobbyId: String(id),
        tick: Number(snap.tick || 0),
        era: String(snap.era || "proto"),
        createdAt: snap.createdAt || null,
        players: Array.isArray(snap.players) ? snap.players : [],
        resources: snap.resources || null,
      });
    }

    // newest first
    colonies.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    safeSend(ws, { type: "my_colonies", colonies });
  } catch (_) {
    safeSend(ws, { type: "my_colonies", colonies: [] });
  }
}

// =====================================
// Placement / building actions
// =====================================
function requireLobby(ws) {
  const lobbyId = ws.lobbyId;
  if (!lobbyId) return { ok: false, err: "Nicht in einer Lobby" };
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return { ok: false, err: "Lobby nicht gefunden" };
  return { ok: true, lobby };
}

async function handlePlaceBuilding(ws, data) {
  const lr = requireLobby(ws);
  if (!lr.ok) return safeSend(ws, { type: "error", message: lr.err });

  const lobby = lr.lobby;
  const buildingId = String(data.buildingId || data.buildingType || "");
  const x = Number(data.x);
  const y = Number(data.y);

  if (!buildingId) return safeSend(ws, { type: "error", message: "buildingId fehlt" });
  if (!Number.isFinite(x) || !Number.isFinite(y)) return safeSend(ws, { type: "error", message: "x/y fehlen" });

  // server-side validation
  const check = canPlaceBuilding(lobby.state, buildingId, x, y);
  if (!check.ok) {
    return safeSend(ws, {
      type: "notification",
      severity: "warning",
      message: "Platzierung nicht möglich: " + String(check.reason || "invalid"),
    });
  }

  const res = placeBuilding(lobby.state, ws.playerId, buildingId, x, y);
  if (!res.ok) {
    return safeSend(ws, {
      type: "notification",
      severity: "warning",
      message: "Bau fehlgeschlagen: " + String(res.reason || "unknown"),
    });
  }

  // progress reward (dopamin)
  const prog = await getPlayerProgress(ws.playerId);
  prog.lifetime.buildingsPlaced += 1;
  await savePlayerProgress(ws.playerId, prog);

  lobby.dailyStats.dailyBuilds = (lobby.dailyStats.dailyBuilds || 0) + 1;

  // Hot streak tracking
  const curTick = lobby.state.tick;
  lobby._recentBuilds = (lobby._recentBuilds || []).filter(t => t > curTick - 60);
  lobby._recentBuilds.push(curTick);
  if (lobby._recentBuilds.length >= 5 && !(lobby.state.specialBuff?.endsAtTick > curTick)) {
    const streakDur = 25;
    lobby.state.specialBuff = { endsAtTick: curTick + streakDur, prodMult: 1.30 };
    lobby.broadcast({ type: "hot_streak", message: "🔥 TEAM AUF FEUER! 5 schnelle Bauten → +30% für 25 Ticks!" });
    lobby._recentBuilds = [];
  }

  // Critical Build: 15% chance
  const isCritical = Math.random() < 0.15;
  const playerName = lobby.players.get(ws.playerId)?.name || "Jemand";
  if (isCritical) {
    const eraIdx = eraIndexById(lobby.state.era);
    const critBonus = {
      energie: Math.floor(40 + eraIdx * 25),
      nahrung: Math.floor(25 + eraIdx * 15),
    };
    for (const [k, v] of Object.entries(critBonus)) {
      lobby.state.resources[k] = (lobby.state.resources[k] || 0) + v;
    }
    lobby.broadcast({ type: "critical_build", buildingId, critBonus, playerId: ws.playerId, playerName });
  } else {
    lobby.broadcast({ type: "player_action", action: "build", buildingId, playerId: ws.playerId, playerName });
  }

  await saveLobbySnapshot(lobby.id, lobby);
  await lobby.broadcastState();
}

async function handleUpgradeBuilding(ws, data) {
  const lr = requireLobby(ws);
  if (!lr.ok) return safeSend(ws, { type: "error", message: lr.err });
  const lobby = lr.lobby;

  const instanceId = String(data.instanceId || "");
  if (!instanceId) return safeSend(ws, { type: "error", message: "instanceId fehlt" });

  const res = upgradeBuilding(lobby.state, instanceId);
  if (!res.ok) {
    return safeSend(ws, {
      type: "notification",
      severity: "warning",
      message: "Upgrade fehlgeschlagen: " + String(res.reason || "unknown"),
    });
  }

  const prog = await getPlayerProgress(ws.playerId);
  prog.lifetime.buildingsUpgraded += 1;
  await savePlayerProgress(ws.playerId, prog);

  lobby.dailyStats.dailyUpgrades = (lobby.dailyStats.dailyUpgrades || 0) + 1;
  const upgrPlayerName = lobby.players.get(ws.playerId)?.name || "Jemand";
  lobby.broadcast({ type: "player_action", action: "upgrade", level: res.newLevel, playerId: ws.playerId, playerName: upgrPlayerName });
  lobby.broadcast({ type: "notification", severity: "success", message: `⬆️ Upgrade erfolgreich (Level ${res.newLevel})` });

  await saveLobbySnapshot(lobby.id, lobby);
  await lobby.broadcastState();
}

async function handleRepairBuilding(ws, data) {
  const lr = requireLobby(ws);
  if (!lr.ok) return safeSend(ws, { type: "error", message: lr.err });
  const lobby = lr.lobby;

  const instanceId = String(data.instanceId || "");
  if (!instanceId) return safeSend(ws, { type: "error", message: "instanceId fehlt" });

  const inst = lobby.state.map.instances.find(i => i.id === instanceId);
  if (!inst) return safeSend(ws, { type: "error", message: "Gebäude nicht gefunden" });

  const missing = 100 - (inst.condition ?? 100);
  if (missing <= 0) {
    return safeSend(ws, {
      type: "notification",
      severity: "info",
      message: "Gebäude ist bereits in gutem Zustand",
    });
  }

  // Reparaturkosten (skalieren sanft)
  const cost = {
    energie: Math.ceil(missing * 0.3),
    nahrung: Math.ceil(missing * 0.15),
  };

  if (!hasResources(lobby.state.resources, cost)) {
    return safeSend(ws, {
      type: "notification",
      severity: "warning",
      message: "Nicht genug Ressourcen für Reparatur",
    });
  }

  // bezahlen + reparieren
  for (const [k, v] of Object.entries(cost)) {
    lobby.state.resources[k] -= v;
  }
  inst.condition = 100;
  delete inst._warnedLowCondition;

  lobby.broadcast({
    type: "notification",
    severity: "success",
    message: `🛠️ Gebäude repariert`,
  });

  await saveLobbySnapshot(lobby.id, lobby);
  await lobby.broadcastState();
}


async function handleDemolishBuilding(ws, data) {
  const lr = requireLobby(ws);
  if (!lr.ok) return safeSend(ws, { type: "error", message: lr.err });
  const lobby = lr.lobby;

  const instanceId = String(data.instanceId || "");
  if (!instanceId) return safeSend(ws, { type: "error", message: "instanceId fehlt" });

  const res = removeBuilding(lobby.state, instanceId);
  if (!res.ok) {
    return safeSend(ws, {
      type: "notification",
      severity: "warning",
      message: "Abriss fehlgeschlagen: " + String(res.reason || "unknown"),
    });
  }

  const prog = await getPlayerProgress(ws.playerId);
  prog.lifetime.buildingsDemolished += 1;
  await savePlayerProgress(ws.playerId, prog);

  lobby.broadcast({ type: "notification", severity: "info", message: `🧨 Gebäude abgerissen` });

  await saveLobbySnapshot(lobby.id, lobby);
  await lobby.broadcastState();
}

// Legacy build (UI: "build" ohne x/y). Wir auto-placen auf erstem freien Spot.
async function handleBuildLegacy(ws, data) {
  const lr = requireLobby(ws);
  if (!lr.ok) return safeSend(ws, { type: "error", message: lr.err });
  const lobby = lr.lobby;

  const buildingId = String(data.buildingType || "");
  if (!buildingId) return safeSend(ws, { type: "error", message: "buildingType fehlt" });

  const spot = findFirstFreeSpot(lobby.state, buildingId);
  if (!spot) {
    return safeSend(ws, { type: "notification", severity: "warning", message: "Kein freier Platz auf der Karte." });
  }

  const res = placeBuilding(lobby.state, ws.playerId, buildingId, spot.x, spot.y);
  if (!res.ok) {
    return safeSend(ws, {
      type: "notification",
      severity: "warning",
      message: "Bau fehlgeschlagen: " + String(res.reason || "unknown"),
    });
  }

  const prog = await getPlayerProgress(ws.playerId);
  prog.lifetime.buildingsPlaced += 1;
  // SP gibt es nicht fürs Bauen (sonst farmbar) – nur über Challenges/Meilensteine
  await savePlayerProgress(ws.playerId, prog);


  lobby.broadcast({ type: "notification", severity: "success", message: `🏗️ ${buildingId} gebaut (auto-platziert)` });
  await saveLobbySnapshot(lobby.id, lobby);
  await lobby.broadcastState();
}

function findFirstFreeSpot(state, buildingId) {
  const b = CONFIG.buildings[buildingId];
  if (!b) return null;
  for (let y = 0; y < state.map.height; y++) {
    for (let x = 0; x < state.map.width; x++) {
      const chk = canPlaceBuilding(state, buildingId, x, y);
      if (chk.ok) return { x, y };
    }
  }
  return null;
}

// =====================================
// Era unlock
// =====================================
async function handleUnlockEra(ws, data) {
  const lr = requireLobby(ws);
  if (!lr.ok) return safeSend(ws, { type: "error", message: lr.err });
  const lobby = lr.lobby;

  // UI sendet evtl eraId; wir schalten IMMER "next" frei serverseitig.
  const chk = canUnlockNextEra(lobby.state);
  if (!chk.ok) {
    return safeSend(ws, {
      type: "notification",
      severity: "warning",
      message: "Epoche nicht freischaltbar: " + String(chk.reason || "blocked"),
    });
  }

  const res = unlockNextEra(lobby.state);
  if (!res.ok) {
    return safeSend(ws, {
      type: "notification",
      severity: "warning",
      message: "Epoche-Freischaltung fehlgeschlagen: " + String(res.reason || "failed"),
    });
  }

  const prog = await getPlayerProgress(ws.playerId);

  // ---- Prestige Gain: abhängig von neuer Epoche
  // (Je weiter, desto mehr Shards. Sehr simpel und stabil.)
  const newEraId = lobby.state.era;
  const eraIdx = eraIndexById(newEraId);
  const gainedShards = Math.max(1, 1 + eraIdx); // proto->1, antique->2, ...

  prog.era = newEraId;
  prog.lifetime.erasUnlocked += 1;


  prog.prestigeShards = Number(prog.prestigeShards || 0) + gainedShards;

  // Jede Era-Freischaltung = 1 Prestige Level
  prog.prestigeLevel = Math.max(0, Math.floor(Number(prog.prestigeLevel || 0))) + 1;
  prog.prestigeMult = calcPrestigeMult(prog.prestigeLevel);

  await savePlayerProgress(ws.playerId, prog);

  // ---- RESET der Lobby-Map/State, aber in der NEUEN Epoche weiterspielen
  const oldW = Number(lobby.state?.map?.width || 12);
  const oldH = Number(lobby.state?.map?.height || 8);

  const fresh = createInitialState({ mapWidth: oldW, mapHeight: oldH });
  fresh.config = CONFIG;
  fresh.era = newEraId;

  // Prestige in den State schreiben, damit tick() es nutzen kann
  fresh.prestige = {
    level: prog.prestigeLevel,
    mult: prog.prestigeMult,
  };
  const startBoost = 1 + (fresh.prestige.level || 0) * 0.05;
  fresh.resources.energie = Math.floor((fresh.resources.energie || 0) * startBoost);
  fresh.resources.nahrung = Math.floor((fresh.resources.nahrung || 0) * startBoost);
  fresh.resources.bevoelkerung = Math.floor((fresh.resources.bevoelkerung || 0) * startBoost);
  // apply prestige shop effects after reset
  fresh.prestigeShop ||= { prodMult: 1, upkeepMult: 1, eventResist: 1 };
  
  for (const [id, lvl] of Object.entries(prog.prestigeShop || {})) {
    const item = PRESTIGE_SHOP[id];
    if (item && lvl > 0) {
      item.effect(fresh, lvl);
    }
  }

  lobby.state = fresh;


  lobby.broadcast({
    type: "notification",
    severity: "success",
    message: `🌟 Neue Epoche: ${lobby.state.era} — Prestige ${prog.prestigeLevel} (+${gainedShards} Shards, x${prog.prestigeMult.toFixed(2)})`,
  });


  await saveLobbySnapshot(lobby.id, lobby);
  await lobby.broadcastState();
}

// =====================================
// Skills
// =====================================
function hasSkill(progress, skillId) {
  return Array.isArray(progress.skills) && progress.skills.includes(skillId);
}
function canUnlockSkill(progress, skillId) {
  const s = SKILL_INDEX.get(skillId);
  if (!s) return { ok: false, reason: "UnknownSkill" };
  if (hasSkill(progress, skillId)) return { ok: false, reason: "AlreadyUnlocked" };
  if (Number(progress.skillPoints || 0) < Number(s.cost || 0)) return { ok: false, reason: "NotEnoughPoints" };
  for (const r of s.requires || []) {
    if (!hasSkill(progress, r)) return { ok: false, reason: "MissingPrereq", need: r };
  }
  return { ok: true };
}

async function handleSkillUnlock(ws, data) {
  const playerId = String(ws.playerId || data.playerId || "");
  if (!playerId) return safeSend(ws, { type: "error", message: "playerId fehlt" });

  const skillId = String(data.skillId || "");
  if (!skillId) return safeSend(ws, { type: "error", message: "skillId fehlt" });

  const prog = await getPlayerProgress(playerId);
  const chk = canUnlockSkill(prog, skillId);
  if (!chk.ok) {
    return safeSend(ws, {
      type: "notification",
      severity: "warning",
      message: "Skill nicht freischaltbar: " + String(chk.reason || "blocked"),
    });
  }

  const s = SKILL_INDEX.get(skillId);
  prog.skillPoints -= Number(s.cost || 0);
  prog.skills.push(skillId);

  await savePlayerProgress(playerId, prog);
  const lr = requireLobby(ws);
  if (lr.ok) {
    const playerEntry = lr.lobby.players.get(playerId);
    if (playerEntry) {
      playerEntry.skills = Array.isArray(prog.skills) ? prog.skills : [];
    }
    lr.lobby.state.skillModifiers = computeSkillModifiersForLobby(lr.lobby);
  }

  safeSend(ws, {
    type: "skill_unlocked",
    skillId,
    remainingPoints: prog.skillPoints,
    skills: prog.skills,
  });

  // also broadcast state update if in lobby
  if (lr.ok) {
    await lr.lobby.broadcastState();
  }
}

// =====================================
// Expedition handlers
// =====================================
async function handleSendExpedition(ws, data) {
  const lr = requireLobby(ws);
  if (!lr.ok) return safeSend(ws, { type: "error", message: lr.err });
  const lobby = lr.lobby;

  const typeId = String(data.expeditionType || "");
  if (!typeId) return safeSend(ws, { type: "error", message: "expeditionType fehlt" });

  const eraIdx = eraIndexById(lobby.state.era);
  const roleBonuses = lobby.state.roleBonuses || {};
  const available = getAvailableExpeditions(eraIdx, roleBonuses.hasTrader || false);
  const cfg = available.find(e => e.id === typeId);
  if (!cfg) return safeSend(ws, { type: "notification", severity: "warning", message: "Diese Expedition ist noch nicht verfügbar." });

  // Max 3 active expeditions at once
  const active = lobby.expeditions.filter(e => e.status === "active");
  if (active.length >= 3) {
    return safeSend(ws, { type: "notification", severity: "warning", message: "Maximal 3 gleichzeitige Expeditionen." });
  }

  const pioneerBonus = roleBonuses.expeditionDurationMult ? (1 / roleBonuses.expeditionDurationMult) : 1;
  const exp = createExpedition(typeId, ws.playerId, lobby.state.tick, pioneerBonus);
  if (!exp) return safeSend(ws, { type: "error", message: "Expedition konnte nicht erstellt werden." });

  lobby.expeditions.push(exp);
  lobby.dailyStats.dailyExpeditions = (lobby.dailyStats.dailyExpeditions || 0) + 1;

  lobby.broadcast({
    type: "notification",
    severity: "info",
    message: `🗺️ Expedition gestartet: ${cfg.name} (kehrt in ~${exp.returnsAtTick - lobby.state.tick} Ticks zurück)`,
  });

  await lobby.broadcastState();
}

// =====================================
// Daily quest claim handler
// =====================================
async function handleClaimDailyQuest(ws, data) {
  const lr = requireLobby(ws);
  if (!lr.ok) return safeSend(ws, { type: "error", message: lr.err });
  const lobby = lr.lobby;

  const questId = String(data.questId || "");
  const quest = lobby.dailyQuests.find(q => q.id === questId);
  if (!quest) return safeSend(ws, { type: "notification", severity: "warning", message: "Quest nicht gefunden." });
  if (!quest.completed) return safeSend(ws, { type: "notification", severity: "warning", message: "Quest noch nicht abgeschlossen." });
  if (quest.claimed) return safeSend(ws, { type: "notification", severity: "info", message: "Quest bereits eingelöst." });

  quest.claimed = true;

  const prog = await getPlayerProgress(ws.playerId);
  const reward = quest.reward || {};
  if (reward.skillPoints) grantSkillPoints(prog, reward.skillPoints);
  if (reward.prestigeShards) prog.prestigeShards = (prog.prestigeShards || 0) + reward.prestigeShards;
  await savePlayerProgress(ws.playerId, prog);

  lobby.broadcast({
    type: "notification",
    severity: "success",
    message: `🎯 Tagesquest abgeschlossen: ${quest.label} (+${reward.skillPoints || 0} SP${reward.prestigeShards ? ", +" + reward.prestigeShards + " Shards" : ""})`,
  });

  await lobby.broadcastState();
}

// =====================================
// Utility: safe send
// =====================================
function safeSend(ws, msg) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  } catch (_) {}
}

// =====================================
// Boot
// =====================================
(async () => {
  await initRedis();

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket ready at ws(s)://<host>/`);
  });
})();
