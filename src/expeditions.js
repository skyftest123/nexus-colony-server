// expeditions.js — Expedition system for Nexus Colony

const EXPEDITION_TYPES = {
  mineral_survey: {
    id: "mineral_survey",
    name: "Mineralerkundung",
    icon: "⛏️",
    desc: "Erkundung reicher Mineralvorkommen in der Nähe.",
    durationTicks: 8,
    risk: 0,
    reward: () => ({
      energie: 150 + Math.floor(Math.random() * 150),
    }),
    rewardDesc: "+150–300 Energie",
    minEra: 0,
  },
  food_expedition: {
    id: "food_expedition",
    name: "Nahrungsexpedition",
    icon: "🌿",
    desc: "Sammelteam erkundet fruchtbare Gebiete.",
    durationTicks: 5,
    risk: 0,
    reward: () => ({
      nahrung: 150 + Math.floor(Math.random() * 100),
    }),
    rewardDesc: "+150–250 Nahrung",
    minEra: 0,
  },
  research_mission: {
    id: "research_mission",
    name: "Forschungsmission",
    icon: "🔬",
    desc: "Wissenschaftler untersuchen mysteriöse Artefakte.",
    durationTicks: 14,
    risk: 0,
    reward: () => ({
      skillPoints: 2 + Math.floor(Math.random() * 3),
    }),
    rewardDesc: "+2–4 Skillpunkte",
    minEra: 1,
  },
  rescue_mission: {
    id: "rescue_mission",
    name: "Rettungsmission",
    icon: "🚁",
    desc: "Befreie gestrandete Siedler aus dem Ödland.",
    durationTicks: 15,
    risk: 0.15,
    reward: () => ({
      bevoelkerung: 50 + Math.floor(Math.random() * 60),
      stabilitaet: 5 + Math.floor(Math.random() * 10),
    }),
    rewardDesc: "+50–110 Bevölkerung, +5–15 Stabilität",
    minEra: 1,
  },
  trading_caravan: {
    id: "trading_caravan",
    name: "Handelskarawane",
    icon: "🐪",
    desc: "Händler bringen Waren aus fernen Siedlungen.",
    durationTicks: 10,
    risk: 0.05,
    reward: () => ({
      energie: 80 + Math.floor(Math.random() * 60),
      nahrung: 100 + Math.floor(Math.random() * 80),
      forschung: 20 + Math.floor(Math.random() * 30),
    }),
    rewardDesc: "Gemischte Ressourcen",
    minEra: 1,
  },
  danger_zone: {
    id: "danger_zone",
    name: "Gefahrenzone",
    icon: "💀",
    desc: "Hochriskanter Einsatz in feindlichem Gebiet. Großes Risiko, großer Gewinn!",
    durationTicks: 6,
    risk: 0.4,
    reward: () => ({
      energie: 300 + Math.floor(Math.random() * 200),
      nahrung: 200 + Math.floor(Math.random() * 150),
      prestigeShards: 2 + Math.floor(Math.random() * 3),
    }),
    rewardDesc: "+300–500 Energie, +200–350 Nahrung, +2–5 Shards",
    minEra: 2,
  },
  ancient_ruins: {
    id: "ancient_ruins",
    name: "Antike Ruinen",
    icon: "🏺",
    desc: "Erforsche uralte Zivilisationsreste. Langsam, aber enorm wertvoll.",
    durationTicks: 22,
    risk: 0.1,
    reward: () => ({
      skillPoints: 5 + Math.floor(Math.random() * 6),
      prestigeShards: 3 + Math.floor(Math.random() * 4),
    }),
    rewardDesc: "+5–11 Skillpunkte, +3–7 Shards",
    minEra: 2,
  },
  satellite_launch: {
    id: "satellite_launch",
    name: "Satellitenstart",
    icon: "🛰️",
    desc: "Orbitalaufklärung für die nächste Epoche.",
    durationTicks: 20,
    risk: 0.2,
    reward: () => ({
      forschung: 500 + Math.floor(Math.random() * 300),
      skillPoints: 3 + Math.floor(Math.random() * 3),
    }),
    rewardDesc: "+500–800 Forschung, +3–6 SP",
    minEra: 3,
  },
  quantum_dive: {
    id: "quantum_dive",
    name: "Quantentauchgang",
    icon: "🌌",
    desc: "Erkundung der Quantenrealität. Nur für fortgeschrittene Kolonien.",
    durationTicks: 30,
    risk: 0.25,
    reward: () => ({
      skillPoints: 8 + Math.floor(Math.random() * 8),
      prestigeShards: 8 + Math.floor(Math.random() * 7),
      energie: 800 + Math.floor(Math.random() * 400),
    }),
    rewardDesc: "+8–16 SP, +8–15 Shards, massive Energie",
    minEra: 4,
  },
};

function getAvailableExpeditions(eraIndex, hasTrader = false) {
  return Object.values(EXPEDITION_TYPES).filter(e => {
    if (e.minEra > eraIndex) return false;
    // danger_zone and rare expeditions need trader role
    if (e.id === "quantum_dive" && !hasTrader && eraIndex < 4) return false;
    return true;
  });
}

function createExpedition(typeId, playerId, tick, pioneerBonus = 1) {
  const cfg = EXPEDITION_TYPES[typeId];
  if (!cfg) return null;
  const duration = Math.max(3, Math.round(cfg.durationTicks / pioneerBonus));
  return {
    id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type: typeId,
    sentAtTick: tick,
    returnsAtTick: tick + duration,
    sentBy: playerId,
    status: "active", // active | success | failed | claimed
    risk: cfg.risk,
  };
}

function resolveExpedition(expedition) {
  const cfg = EXPEDITION_TYPES[expedition.type];
  if (!cfg) return { ok: false };
  // risk check
  if (cfg.risk > 0 && Math.random() < cfg.risk) {
    return { ok: false, failed: true };
  }
  return { ok: true, reward: cfg.reward() };
}

module.exports = { EXPEDITION_TYPES, getAvailableExpeditions, createExpedition, resolveExpedition };
