// daily_quests.js — Daily Quest system for Nexus Colony

const QUEST_TEMPLATES = [
  {
    id: "build_5",
    label: "Baumeister",
    desc: "Baue 5 Gebäude",
    icon: "🏗️",
    type: "build_count",
    target: 5,
    reward: { skillPoints: 3, prestigeShards: 0 },
  },
  {
    id: "build_10",
    label: "Stadtplaner",
    desc: "Baue 10 Gebäude",
    icon: "🏙️",
    type: "build_count",
    target: 10,
    reward: { skillPoints: 5, prestigeShards: 1 },
  },
  {
    id: "upgrade_3",
    label: "Optimierer",
    desc: "Upgrade 3 Gebäude",
    icon: "⬆️",
    type: "upgrade_count",
    target: 3,
    reward: { skillPoints: 2, prestigeShards: 0 },
  },
  {
    id: "upgrade_8",
    label: "Perfektion",
    desc: "Upgrade 8 Gebäude",
    icon: "💫",
    type: "upgrade_count",
    target: 8,
    reward: { skillPoints: 5, prestigeShards: 2 },
  },
  {
    id: "pop_100",
    label: "Bevölkerungsziel",
    desc: "Erreiche 100 Einwohner",
    icon: "👥",
    type: "reach_pop",
    target: 100,
    reward: { skillPoints: 2, prestigeShards: 0 },
  },
  {
    id: "pop_500",
    label: "Großstadtgründer",
    desc: "Erreiche 500 Einwohner",
    icon: "🌆",
    type: "reach_pop",
    target: 500,
    reward: { skillPoints: 5, prestigeShards: 2 },
  },
  {
    id: "energy_1000",
    label: "Energiefabrik",
    desc: "Sammle 1000 Energie",
    icon: "⚡",
    type: "reach_energy",
    target: 1000,
    reward: { skillPoints: 3, prestigeShards: 0 },
  },
  {
    id: "research_200",
    label: "Wissenschaftler",
    desc: "Sammle 200 Forschung",
    icon: "🧪",
    type: "reach_research",
    target: 200,
    reward: { skillPoints: 3, prestigeShards: 1 },
  },
  {
    id: "stability_80",
    label: "Friedliche Kolonie",
    desc: "Halte Stabilität über 80 für 20 Ticks",
    icon: "🕊️",
    type: "maintain_stability",
    target: 20,
    reward: { skillPoints: 4, prestigeShards: 1 },
  },
  {
    id: "survive_crisis",
    label: "Krisenmanager",
    desc: "Überlebe 2 Krisen",
    icon: "🛡️",
    type: "survive_crises",
    target: 2,
    reward: { skillPoints: 4, prestigeShards: 2 },
  },
  {
    id: "expedition_3",
    label: "Entdecker",
    desc: "Schicke 3 Expeditionen los",
    icon: "🗺️",
    type: "expedition_count",
    target: 3,
    reward: { skillPoints: 4, prestigeShards: 1 },
  },
  {
    id: "team_4",
    label: "Volle Besatzung",
    desc: "Spiele mit 4 Spielern gleichzeitig",
    icon: "🤝",
    type: "team_size",
    target: 4,
    reward: { skillPoints: 5, prestigeShards: 3 },
  },
];

function generateDailyQuests(dayKey, eraIndex = 0) {
  // Deterministic random based on day so all players get same quests
  const seed = dayKey.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const rng = mulberry32(seed);

  // Filter quests appropriate for era
  const available = QUEST_TEMPLATES.filter(q => {
    if (q.type === "expedition_count" && eraIndex < 1) return false;
    if (q.id === "stability_80" && eraIndex < 1) return false;
    if (q.id === "pop_500" && eraIndex < 2) return false;
    if (q.id === "research_200" && eraIndex < 1) return false;
    return true;
  });

  // Pick 3 random quests
  const shuffled = [...available].sort(() => rng() - 0.5);
  return shuffled.slice(0, 3).map(q => ({
    ...q,
    progress: 0,
    completed: false,
    claimed: false,
    dayKey,
  }));
}

function getDayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function updateQuestProgress(quests, state, lobbyStats) {
  const res = state.resources || {};
  for (const q of quests) {
    if (q.completed) continue;
    let current = 0;
    switch (q.type) {
      case "reach_pop":       current = res.bevoelkerung || 0; break;
      case "reach_energy":    current = res.energie || 0; break;
      case "reach_research":  current = res.forschung || 0; break;
      case "build_count":     current = lobbyStats.dailyBuilds || 0; break;
      case "upgrade_count":   current = lobbyStats.dailyUpgrades || 0; break;
      case "survive_crises":  current = lobbyStats.dailyCrisesSurvived || 0; break;
      case "expedition_count":current = lobbyStats.dailyExpeditions || 0; break;
      case "maintain_stability":
        if ((res.stabilitaet || 0) >= 80) current = (q.progress || 0) + 1;
        else current = 0;
        break;
      case "team_size":
        current = lobbyStats.currentPlayerCount || 0;
        break;
      default: current = q.progress || 0;
    }
    q.progress = current;
    if (current >= q.target) q.completed = true;
  }
  return quests;
}

// Simple deterministic RNG (mulberry32)
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

module.exports = { generateDailyQuests, getDayKey, updateQuestProgress, QUEST_TEMPLATES };
