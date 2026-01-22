// src/challenges.js
// Server-authoritative challenge manager for build/upgrade/demolish.
// - Prevent "cancel -> free build" by requiring a resolved challenge.
// - Challenges expire; server can apply penalties (resource loss) if needed.

function makeId(prefix = "ch") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function nowTick(gameState) {
  return gameState?.currentTick || 0;
}

function ensureBuckets(gameState) {
  if (!gameState.activeChallenges) {
    gameState.activeChallenges = { builds: {}, upgrades: {}, demolish: {} };
  } else {
    gameState.activeChallenges.builds ||= {};
    gameState.activeChallenges.upgrades ||= {};
    gameState.activeChallenges.demolish ||= {};
  }
}

function createChallenge(gameState, kind, payload) {
  ensureBuckets(gameState);

  const id = makeId(kind[0] || "c");
  const tick = nowTick(gameState);

  const ch = {
    challengeId: id,
    kind, // "build"|"upgrade"|"demolish"
    playerId: payload.playerId,
    buildingType: payload.buildingType,
    difficulty: payload.difficulty || 1,
    expiresAtTick: payload.expiresAtTick || (tick + 8),
    createdAtTick: tick,
    // optional:
    costPaid: payload.costPaid || null,
    targetInstanceId: payload.targetInstanceId || null,
    placement: payload.placement || null, // {x,y}
  };

  const bucket =
    kind === "build" ? gameState.activeChallenges.builds :
    kind === "upgrade" ? gameState.activeChallenges.upgrades :
    gameState.activeChallenges.demolish;

  bucket[id] = ch;

  return ch;
}

function getChallenge(gameState, kind, challengeId) {
  ensureBuckets(gameState);
  const bucket =
    kind === "build" ? gameState.activeChallenges.builds :
    kind === "upgrade" ? gameState.activeChallenges.upgrades :
    gameState.activeChallenges.demolish;

  return bucket[challengeId] || null;
}

function deleteChallenge(gameState, kind, challengeId) {
  ensureBuckets(gameState);
  const bucket =
    kind === "build" ? gameState.activeChallenges.builds :
    kind === "upgrade" ? gameState.activeChallenges.upgrades :
    gameState.activeChallenges.demolish;

  if (bucket[challengeId]) delete bucket[challengeId];
}

function isExpired(gameState, ch) {
  return nowTick(gameState) > (ch.expiresAtTick || 0);
}

/**
 * Validate a client-reported result.
 * IMPORTANT: server still decides pass/fail using difficulty and reported score.
 *
 * result: { score:number, success?:boolean, meta?:any }
 * policy: define thresholds so it’s not too fast/too slow.
 */
function evaluateResult(ch, result) {
  const score = Number(result?.score || 0);

  // Difficulty scaling (tunable):
  // diff 1 -> need 6
  // diff 5 -> need 16
  // diff 10 -> need 28
  const need = 4 + ch.difficulty * 2.4;

  const passed = score >= need;

  return {
    passed,
    score,
    need: Math.ceil(need),
  };
}

/**
 * Expire challenges for all buckets.
 * Returns array of expired challenges (so caller can notify players).
 */
function expireChallenges(gameState) {
  ensureBuckets(gameState);
  const expired = [];
  const tick = nowTick(gameState);

  const expireBucket = (bucket, kind) => {
    for (const [id, ch] of Object.entries(bucket)) {
      if (tick > ch.expiresAtTick) {
        expired.push(ch);
        delete bucket[id];
      }
    }
  };

  expireBucket(gameState.activeChallenges.builds, "build");
  expireBucket(gameState.activeChallenges.upgrades, "upgrade");
  expireBucket(gameState.activeChallenges.demolish, "demolish");

  return expired;
}

module.exports = {
  createChallenge,
  getChallenge,
  deleteChallenge,
  isExpired,
  evaluateResult,
  expireChallenges,
};
