// src/protocol.js
// Lightweight protocol/router for your WebSocket messages.
// Goal: move the big switch/case out of nexus_server.js without rewriting game logic.
// Works with sync + async handlers.

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function send(ws, payload) {
  try {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify(payload));
  } catch {
    // ignore
  }
}

/**
 * createProtocol({ routes, onError })
 * routes: { [type: string]: async (ws, data) => void }
 */
function createProtocol({ routes, onError } = {}) {
  if (!routes) routes = {};

  return async function onWsMessage(ws, rawMessage) {
    const data = typeof rawMessage === "string" ? safeJsonParse(rawMessage) : safeJsonParse(rawMessage.toString());
    if (!data || typeof data.type !== "string") {
      send(ws, { type: "error", message: "Ungültige Nachricht" });
      return;
    }

    const handler = routes[data.type];
    if (!handler) {
      send(ws, { type: "error", message: "Unbekannter Nachrichtentyp" });
      return;
    }

    try {
      await handler(ws, data);
    } catch (err) {
      if (typeof onError === "function") onError(err, ws, data);
      send(ws, { type: "error", message: "Serverfehler" });
    }
  };
}

/**
 * Helper: build common routes with minimal code in nexus_server.js.
 * You pass your existing handler functions in.
 */
function buildRoutes(handlers) {
  // handlers = { handleCreateLobby, handleJoinLobby, ... }
  // Returns routes map to pass into createProtocol.
  const r = {};
  for (const [k, fn] of Object.entries(handlers || {})) {
    if (typeof fn !== "function") continue;

    // Expect handler name like handleCreateLobby -> type "create_lobby"
    // If you prefer explicit mapping, skip this and define routes manually.
    if (k === "handleCreateLobby") r["create_lobby"] = fn;
    else if (k === "handleJoinLobby") r["join_lobby"] = fn;
    else if (k === "handleLeaveLobby") r["leave_lobby"] = (ws) => fn(ws);
    else if (k === "handleListLobbies") r["list_lobbies"] = fn;
    else if (k === "handleSpecialAction") r["special_action"] = (ws) => fn(ws);
    else if (k === "handleCastVote") r["cast_vote"] = fn;
    else if (k === "handleBuildRequest") r["build"] = fn;
    else if (k === "handleSubmitBuildResult") r["submit_build_result"] = fn;
    else if (k === "handleStartUpgrade") r["start_upgrade"] = fn;
    else if (k === "handleSubmitUpgradeResult") r["submit_upgrade_result"] = fn;
    else if (k === "handleStartDemolish") r["start_demolish"] = fn;
    else if (k === "handleSubmitDemolishResult") r["submit_demolish_result"] = fn;
    else if (k === "handleUnlockEra") r["unlock_era"] = fn;
    else if (k === "handleSkillUnlock") r["skill_unlock"] = fn;
    else if (k === "handleSkillRespec") r["skill_respec"] = (ws) => fn(ws);
  }

  // small utility route
  r["ping"] = async (ws) => send(ws, { type: "pong", t: Date.now() });

  return r;
}

module.exports = {
  createProtocol,
  buildRoutes,
  send,
};
