// src/state.js
// Persist lobby states in Render Key Value (Redis) via src/db.js

const db = require("./db");

const LOBBY_SET_KEY = "nexus:lobbies"; // Set mit allen Lobby-Codes
const lobbyKey = (code) => `nexus:lobby:${String(code).toUpperCase()}`;

// Wie lange eine Lobby ohne Spieler "überleben" darf (Sekunden)
// Du kannst das später höher setzen; erstmal 2 Stunden.
const LOBBY_TTL_SECONDS = 60 * 60 * 2;

async function registerLobby(code) {
  code = String(code).toUpperCase();
  await db.sadd(LOBBY_SET_KEY, code);
}

async function unregisterLobby(code) {
  code = String(code).toUpperCase();
  await db.srem(LOBBY_SET_KEY, code);
  await db.del(lobbyKey(code));
}

async function saveLobby(code, payload) {
  code = String(code).toUpperCase();
  const data = {
    ...payload,
    _meta: {
      updatedAt: Date.now(),
    },
  };
  // TTL wird bei jedem Save erneuert (Lobby lebt weiter, wenn sie tickt)
  await db.setJSON(lobbyKey(code), data, LOBBY_TTL_SECONDS);
  await registerLobby(code);
}

async function loadLobby(code) {
  code = String(code).toUpperCase();
  return await db.getJSON(lobbyKey(code));
}

async function listLobbies() {
  const codes = await db.smembers(LOBBY_SET_KEY);
  if (!codes || codes.length === 0) return [];

  const result = [];
  for (const code of codes) {
    const data = await loadLobby(code);
    if (!data) continue;

    // Minimal-Info für spätere UI-Lobby-Liste
    result.push({
      code,
      updatedAt: data?._meta?.updatedAt ?? null,
      currentTick: data?.gameState?.currentTick ?? 0,
      era: data?.gameState?.era ?? "proto",
      players: data?.players ?? [],
    });
  }

  // Neueste zuerst
  result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return result;
}

module.exports = {
  registerLobby,
  unregisterLobby,
  saveLobby,
  loadLobby,
  listLobbies,
  LOBBY_TTL_SECONDS,
};
