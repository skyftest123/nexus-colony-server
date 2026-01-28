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
const WebSocket = require("ws");

// --- Config ---
const PORT = Number(process.env.PORT || 3000);
const TICK_MS = Number(process.env.TICK_MS || 1500); // schneller als vorher
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
const CONFIG = loadConfigs();
const SKILL_INDEX = new Map(CONFIG.skills.map((s) => [s.id, s]));

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
    // Ensure config stays current (don’t persist config)
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
class Lobby {
  constructor(lobbyId, seededState = null) {
    this.id = String(lobbyId).toUpperCase();
    this.players = new Map(); // playerId -> {id,name,role,ws,joinedAt,lastSeenTick}
    this.maxPlayers = MAX_PLAYERS_PER_LOBBY;
    this.createdAt = Date.now();

    this.state = seededState || createInitialState();
    // Always keep config reference fresh
    this.state.config = CONFIG;

    this._tickInterval = null;
    this._lastSnapshotTick = 0;
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

    // If exists -> reconnect socket
    if (this.players.has(id)) {
      const p = this.players.get(id);
      p.ws = ws;
      p.name = playerName || p.name;
      p.role = role || p.role;
      p.lastSeenTick = this.state.tick;
      return { ok: true, reconnect: true };
    }

    if (this.players.size >= this.maxPlayers) return { ok: false, message: "Lobby voll" };

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
    const id = String(playerId);
    const p = this.players.get(id);
    if (p) {
      // Keep entry but mark offline? For reconnect + lobby list UX:
      // We keep player record but remove ws to avoid memory leak.
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
    // do not send config heavy objects
    delete stateCopy.config;

    for (const p of this.players.values()) {
      if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;

      const prog = await getPlayerProgress(p.id);

      p.ws.send(
        JSON.stringify({
          type: "update_state",
          state: {
            currentTick: stateCopy.tick,
            tick: stateCopy.tick,
            era: stateCopy.era,
            difficultyMultiplier: stateCopy.difficulty,
            resources: stateCopy.resources,
            ressourcen: stateCopy.resources, // legacy key for UI compatibility
            map: stateCopy.map,
            stats: stateCopy.stats,
          },
          players: this.getPlayersList(),
          progress: prog,
          eras: CONFIG.eras,
        })
      );
    }
  }

  async processTick() {
    // no instant "event spam": we don't inject events here yet
    const dt = TICK_MS / 1000;
    tickState(this.state, dt);


    // small “always something happens”: if resources increased, UI can pulse; client already does
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
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // Simple landing
  res.writeHead(200, { "Content-Type": "text/plain" });
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

    case "leave_lobby":
      return handleLeaveLobby(ws);

    case "list_my_colonies":
      return handleListMyColonies(ws, data);

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

    default:
      safeSend(ws, { type: "error", message: "Unbekannter Nachrichtentyp: " + type });
      return;
  }
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
  await savePlayerProgress(playerId, prog);

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
  // SP gibt es nicht fürs Bauen (sonst farmbar) – nur über Challenges/Meilensteine
  await savePlayerProgress(ws.playerId, prog);


  lobby.broadcast({ type: "notification", severity: "success", message: `🏗️ Gebäude platziert: ${buildingId}` });

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
  // SP gibt es nicht fürs Upgraden (sonst farmbar) – nur über Challenges/Meilensteine
  await savePlayerProgress(ws.playerId, prog);


  lobby.broadcast({ type: "notification", severity: "success", message: `⬆️ Upgrade erfolgreich (Level ${res.newLevel})` });

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

  safeSend(ws, {
    type: "skill_unlocked",
    skillId,
    remainingPoints: prog.skillPoints,
    skills: prog.skills,
  });

  // also broadcast state update if in lobby
  const lr = requireLobby(ws);
  if (lr.ok) {
    await lr.lobby.broadcastState();
  }
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
