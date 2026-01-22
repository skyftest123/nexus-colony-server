// src/game_rules.js
// Central game rules / balancing helpers.
// - Costs + spam tax
// - Era unlock checks
// - Skill checks
// - Placement decisions (delegates to map.js)
// This file is pure logic so it can be unit-tested later.

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function getEraIndex(eras, eraId) {
  return (eras || []).findIndex((e) => e.id === eraId);
}

/**
 * Determine whether a building is allowed in current era.
 * buildingDef can have: { eraMin?: string } or { eras?: ["proto","industrial"] }
 */
function isBuildingUnlockedForEra(buildingType, buildingDefs, currentEra) {
  const def = buildingDefs?.[buildingType];
  if (!def) return false;

  if (Array.isArray(def.eras) && def.eras.length > 0) {
    return def.eras.includes(currentEra);
  }
  if (def.eraMin && def.eraOrder) {
    // optional future format
    return true;
  }
  // if no restriction -> allowed
  return true;
}

/**
 * Compute build costs with spam tax + role reduction + skill reduction.
 *
 * state.spamTax[buildingType] is the "spam level"
 * roleReduction: 0..1
 * spamTaxReduction: 0..1 (skill)
 */
function computeBuildCost({ baseCost, spamLevel = 0, roleReduction = 0, spamTaxReduction = 0 }) {
  const baseE = Number(baseCost?.energie || 0);
  const baseF = Number(baseCost?.nahrung || 0);

  const spamMultBase = 1 + spamLevel * 0.12;
  const spamMult = clamp(spamMultBase * (1 - spamTaxReduction), 1.0, 3.0);

  const finalE = Math.ceil(baseE * spamMult * (1 - roleReduction));
  const finalF = Math.ceil(baseF * spamMult * (1 - roleReduction));

  return { energie: finalE, nahrung: finalF, spamMult };
}

function hasResources(resources, cost) {
  return (resources.energie || 0) >= (cost.energie || 0) && (resources.nahrung || 0) >= (cost.nahrung || 0);
}

function spendResources(resources, cost) {
  resources.energie = (resources.energie || 0) - (cost.energie || 0);
  resources.nahrung = (resources.nahrung || 0) - (cost.nahrung || 0);
}

function refundResources(resources, cost, refundFactor = 0.5) {
  const e = Math.floor((cost.energie || 0) * refundFactor);
  const f = Math.floor((cost.nahrung || 0) * refundFactor);
  resources.energie = (resources.energie || 0) + e;
  resources.nahrung = (resources.nahrung || 0) + f;
  return { energie: e, nahrung: f };
}

/**
 * Era unlock check. eras entry can include unlock requirements like:
 * { pop, food, energy, research, labs, stability }
 */
function canUnlockEra(gameState, eras, targetEraId) {
  const current = gameState.era || "proto";
  const ci = getEraIndex(eras, current);
  const ti = getEraIndex(eras, targetEraId);
  if (ti < 0) return { ok: false, reason: "UNKNOWN_ERA" };
  if (ti !== ci + 1) return { ok: false, reason: "NOT_NEXT_ERA" };

  const req = eras[ti].unlock || {};
  const r = gameState.ressourcen || {};
  const b = gameState.gebaeude || {};

  if (req.pop && (r.bevoelkerung || 0) < req.pop) return { ok: false, reason: "REQ_POP" };
  if (req.food && (r.nahrung || 0) < req.food) return { ok: false, reason: "REQ_FOOD" };
  if (req.energy && (r.energie || 0) < req.energy) return { ok: false, reason: "REQ_ENERGY" };
  if (req.research && (r.forschung || 0) < req.research) return { ok: false, reason: "REQ_RESEARCH" };
  if (req.labs && (b.forschungslabor || 0) < req.labs) return { ok: false, reason: "REQ_LABS" };
  if (req.stability && (r.stabilitaet || 0) < req.stability) return { ok: false, reason: "REQ_STABILITY" };

  return { ok: true };
}

/**
 * Challenge difficulty helper:
 * scale by spamLevel and era (later also by building size/level)
 */
function computeChallengeDifficulty({ spamLevel = 0, currentEra = "proto", kind = "build" }) {
  let d = 2 + spamLevel;
  if (currentEra !== "proto") d += 1;
  if (kind === "upgrade") d += 1;
  if (kind === "demolish") d += 2;
  return clamp(d, 1, 10);
}

/**
 * Upgrade pricing (server-side). Tweakable.
 * Cost increases per level; upgrades are intentionally meaningful.
 */
function computeUpgradeCost({ baseCost, currentLevel = 1 }) {
  // L1->L2 : 1.2x base, L2->L3 : 1.5x base, L3->L4 : 1.9x base ...
  const mult = 1 + (currentLevel - 1) * 0.35;
  return {
    energie: Math.ceil((baseCost?.energie || 0) * mult),
    nahrung: Math.ceil((baseCost?.nahrung || 0) * mult),
  };
}

/**
 * Demolish cost (so demolish is not free; prevents spam/exploits)
 */
function computeDemolishCost({ baseCost, currentLevel = 1 }) {
  const mult = 0.25 + (currentLevel - 1) * 0.08;
  return {
    energie: Math.ceil((baseCost?.energie || 0) * mult),
    nahrung: Math.ceil((baseCost?.nahrung || 0) * mult),
  };
}

/**
 * Skill unlock validation
 * skillsJson: { nodes: {id:{cost,requires}} }
 */
function canUnlockSkill(progress, skillsJson, skillId) {
  const node = skillsJson?.nodes?.[skillId] || null;
  if (!node) return { ok: false, reason: "UNKNOWN_SKILL" };

  const owned = new Set(progress.skills || []);
  if (owned.has(skillId)) return { ok: false, reason: "ALREADY_OWNED" };

  const req = node.requires || [];
  for (const r of req) if (!owned.has(r)) return { ok: false, reason: "MISSING_PREREQ" };

  const cost = Number(node.cost || 0);
  if ((progress.skillPoints || 0) < cost) return { ok: false, reason: "NO_POINTS" };

  return { ok: true, cost };
}

module.exports = {
  computeBuildCost,
  hasResources,
  spendResources,
  refundResources,
  canUnlockEra,
  computeChallengeDifficulty,
  computeUpgradeCost,
  computeDemolishCost,
  isBuildingUnlockedForEra,
  canUnlockSkill,
};
