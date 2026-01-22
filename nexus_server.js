// nexus_server.js (kompletter Server – ersetzt deinen aktuellen server.js)
// Basierend auf deiner bestehenden Struktur (Lobbies, Tick, Ressourcen, Gebäude, Events, Votes)
// + Part 2: server-authoritative Build/Upgrade/Demolish Challenges, Era-Unlock, Skill Tree (persistent wenn möglich)
// Hinweis: UI-Anpassungen kommen später. Der Server sendet bereits challenge-start Messages.

const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const db = require("./src/db");

const PORT = process.env.PORT || 3000;
const TICK_INTERVAL = 5000;

// ========================================
// PERSISTENTER PLAYER PROGRESS (Skill Tree / Era / Lifetime)
// ========================================
const PROGRESS_FILE = path.join(__dirname, "player_progress.json");
let PLAYER_PROGRESS = loadProgress();

function loadProgress() {
  try {
    if (!fs.existsSync(PROGRESS_FILE)) return {};
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveProgress() {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(PLAYER_PROGRESS, null, 2), "utf8");
  } catch {
    // Render kann read-only FS haben → dann bleibt es in-memory (läuft trotzdem)
  }
}
function getPlayerProgress(playerId) {
  if (!PLAYER_PROGRESS[playerId]) {
    PLAYER_PROGRESS[playerId] = {
      skillPoints: 0,
      skills: [],
      era: "proto",
      lifetime: {
        buildingsBuilt: 0,
        enemiesDefeated: 0,
        crisesResolved: 0,
      },
    };
  }
  return PLAYER_PROGRESS[playerId];
}

// ========================================
// LOBBY VERWALTUNG
// ========================================
const lobbies = new Map();

// ========================================
// ROLLEN
// ========================================
const ROLES = {
  engineer: {
    name: "Ingenieur",
    description: "Spezialist für Gebäude und Energie",
    bonuses: {
      buildCostReduction: 0.15,
      energieProduction: 1.2,
      maintenanceReduction: 0.25,
    },
    specialAction: "repair",
    cooldown: 10,
  },
  researcher: {
    name: "Forscher",
    description: "Entwickelt Technologien und Effizienz",
    bonuses: {
      researchSpeed: 2.0,
      eventMitigation: 0.3,
      bevoelkerungEfficiency: 1.15,
    },
    specialAction: "research",
    cooldown: 15,
  },
  logistician: {
    name: "Logistiker",
    description: "Optimiert Ressourcen und Produktion",
    bonuses: {
      resourceEfficiency: 1.25,
      storageBonus: 1.5,
      nahrungProduction: 1.3,
    },
    specialAction: "optimize",
    cooldown: 12,
  },
  diplomat: {
    name: "Diplomat",
    description: "Verwaltet Bevölkerung und Stabilität",
    bonuses: {
      stabilityBonus: 0.2,
      populationGrowth: 1.4,
      crisisResolution: 0.4,
    },
    specialAction: "negotiate",
    cooldown: 8,
  },
};

// ========================================
// GEBÄUDE
// ========================================
const BUILDINGS = {
  generator: {
    name: "Generator",
    cost: { energie: 0, nahrung: 50 },
    production: { energie: 10 },
    maintenance: { energie: 0, nahrung: 2 },
    buildTime: 3,
    maxCount: 20,
    stabilityImpact: -1,
  },
  farm: {
    name: "Farm",
    cost: { energie: 30, nahrung: 0 },
    production: { nahrung: 8 },
    maintenance: { energie: 1, nahrung: 0 },
    buildTime: 3,
    maxCount: 15,
    stabilityImpact: 0,
  },
  wohnmodul: {
    name: "Wohnmodul",
    cost: { energie: 40, nahrung: 60 },
    production: { bevoelkerung: 5 },
    maintenance: { energie: 2, nahrung: 3 },
    buildTime: 5,
    maxCount: 12,
    stabilityImpact: -2,
  },
  forschungslabor: {
    name: "Forschungslabor",
    cost: { energie: 80, nahrung: 40 },
    production: { forschung: 2 },
    maintenance: { energie: 5, nahrung: 2 },
    buildTime: 8,
    maxCount: 5,
    stabilityImpact: 1,
  },
  stabilisator: {
    name: "Stabilisator",
    cost: { energie: 60, nahrung: 50 },
    production: {},
    maintenance: { energie: 3, nahrung: 2 },
    buildTime: 6,
    maxCount: 8,
    stabilityImpact: 5,
    stabilityBonus: 3,
  },
  // Vorbereitung für Defense (UI später)
  defense_tower: {
    name: "Verteidigungsturm",
    cost: { energie: 120, nahrung: 80 },
    production: {},
    maintenance: { energie: 3, nahrung: 1 },
    buildTime: 6,
    maxCount: 12,
    stabilityImpact: 0,
  },
};

// ========================================
// EVENTS (Meteorschauer bewusst NICHT enthalten)
// ========================================
const EVENTS = {
  stromausfall: {
    name: "Stromausfall",
    description: "Ein Generator ist ausgefallen!",
    severity: "medium",
    trigger: { minBuildings: 5, chance: 0.15 },
    effects: {
      immediate: { energie: -50 },
      delayed: {
        tickDelay: 3,
        stabilitaet: -15,
        message: "Die Nachwirkungen des Stromausfalls belasten die Kolonie",
      },
    },
    duration: 2,
    requiresVote: false,
  },

  hungersnot: {
    name: "Hungersnot",
    description: "Ernteausfälle bedrohen die Nahrungsversorgung!",
    severity: "high",
    trigger: { minPopulation: 50, lowFood: true, chance: 0.12 },
    effects: {
      immediate: { nahrung: -80, stabilitaet: -20 },
      delayed: {
        tickDelay: 5,
        bevoelkerung: -10,
        message: "Mangelernährung fordert Opfer in der Bevölkerung",
      },
    },
    duration: 4,
    requiresVote: false,
    canBeMitigated: true,
  },

  aufstand: {
    name: "Aufstand",
    description: "Die Bevölkerung rebelliert gegen die Führung!",
    severity: "critical",
    trigger: { minPopulation: 40, lowStability: true, chance: 0.2 },
    effects: {
      immediate: { stabilitaet: -30, bevoelkerung: -5 },
      delayed: {
        tickDelay: 2,
        energie: -30,
        nahrung: -30,
        message: "Der Aufstand hat Infrastruktur beschädigt",
      },
    },
    duration: 3,
    requiresVote: true,
    voteOptions: ["gewalt", "verhandlung", "zugestaendnisse"],
  },

  technologiedurchbruch: {
    name: "Technologiedurchbruch",
    description: "Forscher haben eine wichtige Entdeckung gemacht!",
    severity: "positive",
    trigger: { minResearch: 50, chance: 0.18 },
    effects: {
      immediate: { forschung: 20, stabilitaet: 10 },
    },
    duration: 1,
    requiresVote: false,
  },

  uebervoelkerung: {
    name: "Übervölkerung",
    description: "Zu viele Menschen, zu wenig Raum!",
    severity: "high",
    trigger: { populationPerHousing: 8, chance: 0.25 },
    effects: {
      immediate: { stabilitaet: -25 },
      delayed: {
        tickDelay: 4,
        nahrung: -40,
        energie: -20,
        stabilitaet: -15,
        message: "Überbelegung führt zu Ressourcenproblemen",
      },
    },
    duration: 3,
    requiresVote: false,
    preventBuilding: "wohnmodul",
  },

  maschinenverschleiss: {
    name: "Maschinenverschleiß",
    description: "Alte Anlagen benötigen dringend Wartung!",
    severity: "medium",
    trigger: { oldBuildings: true, chance: 0.2 },
    effects: {
      immediate: {},
      maintenanceMultiplier: 2.0,
      productionMultiplier: 0.7,
    },
    duration: 5,
    requiresVote: false,
    canBeMitigated: true,
  },
};

// ========================================
// FORSCHUNG (bleibt wie gehabt)
// ========================================
const RESEARCH = {
  effizienz_1: { name: "Effizienztechnologie I", cost: 50, time: 10, effect: { productionBonus: 0.15 }, requires: [] },
  solar_upgrade: { name: "Solarzellenverbesserung", cost: 80, time: 15, effect: { energieBonus: 0.25 }, requires: ["effizienz_1"] },
  hydroponik: { name: "Hydroponische Landwirtschaft", cost: 100, time: 20, effect: { nahrungBonus: 0.3, maintenanceReduction: 0.1 }, requires: ["effizienz_1"] },
  sozialreform: { name: "Sozialreformen", cost: 120, time: 18, effect: { stabilityBonus: 20, populationEfficiency: 0.2 }, requires: [] },
  automation: { name: "Automatisierung", cost: 150, time: 25, effect: { maintenanceReduction: 0.3, productionBonus: 0.2 }, requires: ["effizienz_1", "solar_upgrade"] },
};

// ========================================
// EPOCHEN (kaufbar, nicht nach Jahren)
// ========================================
const ERAS = [
  { id: "proto", name: "Proto-Kolonie", unlock: {} },
  { id: "industrial", name: "Industrialisierung", unlock: { pop: 50, food: 500 } },
  { id: "electro", name: "Elektrifizierung", unlock: { energy: 1200 } },
  { id: "digital", name: "Digitale Ära", unlock: { research: 300 } },
  { id: "automation", name: "Automatisierung", unlock: { labs: 3, pop: 120 } },
  { id: "nexus", name: "Nexus-Zivilisation", unlock: { stability: 90, pop: 250 } },
];

// ========================================
// SKILL TREE (permanent)
// ========================================
const SKILLS = {
  // Energie
  basic_generator: { cost: 1, requires: [], effect: { energyProdMult: 1.05 }, name: "Grundoptimierung", desc: "+5% Energieproduktion" },
  overdrive: { cost: 3, requires: ["basic_generator"], effect: { energyClickBonus: 15 }, name: "Overdrive", desc: "Interaktionen geben +Energie (UI später)" },
  grid_stability: { cost: 4, requires: ["overdrive"], effect: { stabilityFloor: 10 }, name: "Netzstabilität", desc: "Stabilität fällt durch Energiekrisen nie unter 10" },

  // Bau/Ökonomie
  build_rush: { cost: 2, requires: [], effect: { buildTimeMult: 0.9 }, name: "Baulogistik", desc: "-10% Bauzeit" },
  cost_scaling: { cost: 4, requires: ["build_rush"], effect: { spamTaxReduction: 0.15 }, name: "Kostenbremse", desc: "reduziert Spam-Kostenanstieg" },

  // Defense
  early_warning: { cost: 2, requires: [], effect: { enemySpawnChanceMult: 0.9 }, name: "Frühwarnsystem", desc: "-10% Gegner-Spawns" },
};

// ========================================
// MAP / WEGE (nicht bebaubar; UI später)
// ========================================
function generateDefaultPaths(w, h) {
  const blocked = new Set();
  const midY = Math.floor(h / 2);
  for (let x = 0; x < w; x++) blocked.add(`${x},${midY}`);
  blocked.add(`2,${Math.max(0, midY - 1)}`);
  blocked.add(`9,${Math.min(h - 1, midY + 1)}`);
  return Array.from(blocked);
}

// ========================================
// LOBBY KLASSE
// ========================================
class Lobby {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.maxPlayers = 4;
    this.gameState = this.createInitialState();
    this.tickInterval = null;
    this.activeVotes = new Map();
    this.delayedEffects = [];
    this.startTicking();
  }

  createInitialState() {
    return {
      ressourcen: {
        energie: 150,
        nahrung: 150,
        bevoelkerung: 15,
        forschung: 0,
        stabilitaet: 100,
      },
      gebaeude: {
        generator: 2,
        farm: 2,
        wohnmodul: 1,
        forschungslabor: 0,
        stabilisator: 0,
        defense_tower: 0,
      },
      bauWarteschlange: [],
      currentTick: 0,
      startTime: Date.now(),
      activeEvent: null,
      eventHistory: [],
      completedResearch: [],
      activeResearch: null,
      roleActions: {},
      difficultyMultiplier: 1.0,
      statistics: {
        totalTicks: 0,
        eventsTriggered: 0,
        votesHeld: 0,
        buildingsBuilt: 0,
        populationPeak: 15,
      },

      era: "proto",

      buildingLevels: {
        generator: 1,
        farm: 1,
        wohnmodul: 1,
        forschungslabor: 1,
        stabilisator: 1,
        defense_tower: 1,
      },

      spamTax: {
        generator: 0,
        farm: 0,
        wohnmodul: 0,
        forschungslabor: 0,
        stabilisator: 0,
        defense_tower: 0,
      },

      activeChallenges: {
        builds: {},
        upgrades: {},
        demolish: {},
      },

      map: {
        width: 12,
        height: 8,
        blockedPaths: generateDefaultPaths(12, 8),
      },
      enemies: [],
      towers: {},
    };
  }

  addPlayer(playerId, playerName, role, ws) {
    if (this.players.size >= this.maxPlayers) return { success: false, message: "Lobby voll" };

    const existingRoles = Array.from(this.players.values()).map((p) => p.role);
    if (existingRoles.includes(role)) return { success: false, message: "Rolle bereits vergeben" };

    this.players.set(playerId, {
      id: playerId,
      name: playerName,
      role,
      ws,
      joinedAt: Date.now(),
      actionsUsed: 0,
      specialActionLastUsed: -999,
    });

    // Progress init
    getPlayerProgress(playerId);

    return { success: true };
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) this.players.delete(playerId);
    if (this.players.size === 0) {
      this.stopTicking();
      return true;
    }
    return false;
  }

  startTicking() {
    this.tickInterval = setInterval(() => this.processTick(), TICK_INTERVAL);
  }

  stopTicking() {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.tickInterval = null;
  }

  processTick() {
    const state = this.gameState;
    state.currentTick++;
    state.statistics.totalTicks++;

    this.resolveExpiredChallenges();
    this.applyDelayedEffects();
    this.calculateProduction();
    this.applyMaintenance();
    this.updatePopulation();
    this.updateStability();
    this.updateConstruction();
    this.updateResearch();
    this.checkForEvents();
    this.updateActiveEvent();
    this.updateDifficulty();
    this.spawnEnemies();
    this.processEnemies();
    this.checkGameOver();

    // Broadcast drosseln (Lag-Reduktion)
    if (state.currentTick % 2 === 0) this.broadcastState();
  }

  // ===== Challenges Expiry =====
  resolveExpiredChallenges() {
    const state = this.gameState;
    const tick = state.currentTick;

    const expire = (bucket, onExpireMsg) => {
      const entries = Object.entries(bucket);
      for (const [id, ch] of entries) {
        if (tick > ch.expiresAtTick) {
          delete bucket[id];
          this.broadcast({ type: "notification", severity: "critical", message: onExpireMsg(ch) });
        }
      }
    };

    expire(state.activeChallenges.builds, (ch) => `⛔ Bau-Challenge abgelaufen: ${BUILDINGS[ch.buildingType].name}`);
    expire(state.activeChallenges.upgrades, (ch) => `⛔ Upgrade-Challenge abgelaufen: ${BUILDINGS[ch.buildingType].name}`);
    expire(state.activeChallenges.demolish, (ch) => `⛔ Abriss-Challenge abgelaufen: ${BUILDINGS[ch.buildingType].name}`);
  }

  // ===== Production (inkl. buildingLevels + Research) =====
  calculateProduction() {
    const state = this.gameState;

    // Baseline Bonus
    let totalProductionBonus = 1.0;
    if (state.completedResearch.includes("effizienz_1")) totalProductionBonus += 0.15;
    if (state.completedResearch.includes("automation")) totalProductionBonus += 0.2;

    // Event Modifier
    let eventProductionMod = 1.0;
    if (state.activeEvent?.productionMultiplier) eventProductionMod = state.activeEvent.productionMultiplier;

    // Skill Effects (global über alle Player: wir nehmen den stärksten Effekt pro Skill aus allen Spielern)
    const teamSkillEffects = this.getTeamSkillEffects();

    for (const [buildingType, count] of Object.entries(state.gebaeude)) {
      if (!BUILDINGS[buildingType] || count <= 0) continue;

      const building = BUILDINGS[buildingType];
      const level = state.buildingLevels[buildingType] || 1;

      // Level-Multiplikator: spürbar, aber nicht explodierend
      // L1=1.0, L2=1.15, L3=1.32, L4=1.52...
      const levelMult = 1 + (level - 1) * 0.15;

      for (const [resource, amount] of Object.entries(building.production || {})) {
        let finalAmount = amount * count * totalProductionBonus * eventProductionMod * levelMult;

        // Rollen-Boni (Team kumuliert)
        this.players.forEach((player) => {
          const role = ROLES[player.role];

          if (resource === "energie" && role.bonuses.energieProduction) finalAmount *= role.bonuses.energieProduction;
          if (resource === "nahrung" && role.bonuses.nahrungProduction) finalAmount *= role.bonuses.nahrungProduction;
          if (role.bonuses.resourceEfficiency) finalAmount *= role.bonuses.resourceEfficiency;
          if (resource === "bevoelkerung" && role.bonuses.bevoelkerungEfficiency) finalAmount *= role.bonuses.bevoelkerungEfficiency;
        });

        // Research boni
        if (resource === "energie" && state.completedResearch.includes("solar_upgrade")) finalAmount *= 1.25;
        if (resource === "nahrung" && state.completedResearch.includes("hydroponik")) finalAmount *= 1.3;

        // Skill boni
        if (resource === "energie" && teamSkillEffects.energyProdMult) finalAmount *= teamSkillEffects.energyProdMult;

        state.ressourcen[resource] = (state.ressourcen[resource] || 0) + finalAmount;
      }

      // Stabilisator: Extra
      if (buildingType === "stabilisator" && building.stabilityBonus) {
        state.ressourcen.stabilitaet += building.stabilityBonus * count;
      }
    }

    state.ressourcen.stabilitaet = Math.max(0, Math.min(100, state.ressourcen.stabilitaet));
  }

  // ===== Maintenance (inkl. Level) =====
  applyMaintenance() {
    const state = this.gameState;

    let maintenanceMultiplier = 1.0;
    if (state.activeEvent?.maintenanceMultiplier) maintenanceMultiplier = state.activeEvent.maintenanceMultiplier;

    if (state.completedResearch.includes("hydroponik")) maintenanceMultiplier *= 0.9;
    if (state.completedResearch.includes("automation")) maintenanceMultiplier *= 0.7;

    this.players.forEach((player) => {
      const role = ROLES[player.role];
      if (role.bonuses.maintenanceReduction) maintenanceMultiplier *= 1 - role.bonuses.maintenanceReduction;
    });

    for (const [buildingType, count] of Object.entries(state.gebaeude)) {
      const building = BUILDINGS[buildingType];
      if (!building || !building.maintenance || count <= 0) continue;

      const level = state.buildingLevels[buildingType] || 1;
      // Höheres Level kostet mehr Wartung (Balance)
      const levelMaintMult = 1 + (level - 1) * 0.12;

      for (const [resource, cost] of Object.entries(building.maintenance)) {
        const finalCost = cost * count * maintenanceMultiplier * state.difficultyMultiplier * levelMaintMult;
        state.ressourcen[resource] = (state.ressourcen[resource] || 0) - finalCost;
      }
    }
  }

  // ===== Population =====
  updatePopulation() {
    const state = this.gameState;
    const population = state.ressourcen.bevoelkerung;

    const nahrungsVerbrauch = population * 0.5 * state.difficultyMultiplier;
    state.ressourcen.nahrung -= nahrungsVerbrauch;

    if (state.ressourcen.nahrung < 0) {
      state.ressourcen.nahrung = 0;
      const hungerTote = Math.floor(population * 0.05);
      state.ressourcen.bevoelkerung = Math.max(5, population - hungerTote);
      state.ressourcen.stabilitaet -= 15;

      this.broadcast({ type: "notification", severity: "critical", message: `${hungerTote} Menschen sind verhungert!` });
    }

    if (state.ressourcen.nahrung > 50 && state.ressourcen.stabilitaet > 40) {
      let growthRate = 0.02;
      this.players.forEach((player) => {
        const role = ROLES[player.role];
        if (role.bonuses.populationGrowth) growthRate *= role.bonuses.populationGrowth;
      });

      const newPopulation = population + population * growthRate;
      state.ressourcen.bevoelkerung = Math.floor(newPopulation);

      if (state.ressourcen.bevoelkerung > state.statistics.populationPeak) {
        state.statistics.populationPeak = state.ressourcen.bevoelkerung;
      }
    }
  }

  // ===== Stability =====
  updateStability() {
    const state = this.gameState;
    const teamSkillEffects = this.getTeamSkillEffects();

    state.ressourcen.stabilitaet -= 0.5 * state.difficultyMultiplier;

    this.players.forEach((player) => {
      const role = ROLES[player.role];
      if (role.bonuses.stabilityBonus) state.ressourcen.stabilitaet += role.bonuses.stabilityBonus;
    });

    for (const [buildingType, count] of Object.entries(state.gebaeude)) {
      const building = BUILDINGS[buildingType];
      if (building && building.stabilityImpact) state.ressourcen.stabilitaet += building.stabilityImpact * count;
    }

    const housingCapacity = (state.gebaeude.wohnmodul || 0) * 5;
    const overpopulation = state.ressourcen.bevoelkerung - housingCapacity;
    if (overpopulation > 0) state.ressourcen.stabilitaet -= overpopulation * 0.3;

    if (state.ressourcen.energie < 20) state.ressourcen.stabilitaet -= 2;
    if (state.ressourcen.nahrung < 20) state.ressourcen.stabilitaet -= 3;

    if (state.completedResearch.includes("sozialreform")) state.ressourcen.stabilitaet += 1;

    // Skill: stability floor
    if (typeof teamSkillEffects.stabilityFloor === "number") {
      state.ressourcen.stabilitaet = Math.max(teamSkillEffects.stabilityFloor, state.ressourcen.stabilitaet);
    }

    state.ressourcen.stabilitaet = Math.max(0, Math.min(100, state.ressourcen.stabilitaet));
  }

  // ===== Construction Queue =====
  updateConstruction() {
    const state = this.gameState;

    state.bauWarteschlange = state.bauWarteschlange.filter((bau) => {
      if (state.currentTick >= bau.fertigTick) {
        state.gebaeude[bau.typ] = (state.gebaeude[bau.typ] || 0) + 1;
        state.statistics.buildingsBuilt++;

        // Lifetime reward loop
        const progress = getPlayerProgress(bau.byPlayerId || "unknown");
        progress.lifetime.buildingsBuilt += 1;
        saveProgress();

        this.broadcast({ type: "notification", severity: "success", message: `${BUILDINGS[bau.typ].name} wurde fertiggestellt!` });
        return false;
      }
      return true;
    });
  }

  // ===== Research =====
  updateResearch() {
    const state = this.gameState;
    if (!state.activeResearch) return;

    if (state.currentTick >= state.activeResearch.completionTick) {
      const researchType = state.activeResearch.type;
      state.completedResearch.push(researchType);

      this.broadcast({ type: "notification", severity: "success", message: `Forschung "${RESEARCH[researchType].name}" abgeschlossen!` });
      state.activeResearch = null;
    }
  }

  // ===== Events =====
  checkForEvents() {
    const state = this.gameState;
    if (state.activeEvent && state.activeEvent.duration > 0) return;

    for (const [eventKey, event] of Object.entries(EVENTS)) {
      if (this.shouldTriggerEvent(event)) {
        this.triggerEvent(eventKey, event);
        break;
      }
    }
  }

  shouldTriggerEvent(event) {
    const state = this.gameState;
    const trigger = event.trigger;

    if (Math.random() > trigger.chance * state.difficultyMultiplier) return false;

    if (trigger.minBuildings) {
      const totalBuildings = Object.values(state.gebaeude).reduce((a, b) => a + b, 0);
      if (totalBuildings < trigger.minBuildings) return false;
    }
    if (trigger.minPopulation && state.ressourcen.bevoelkerung < trigger.minPopulation) return false;
    if (trigger.lowFood && state.ressourcen.nahrung > 50) return false;
    if (trigger.lowStability && state.ressourcen.stabilitaet > 30) return false;
    if (trigger.minResearch && state.ressourcen.forschung < trigger.minResearch) return false;

    if (trigger.populationPerHousing) {
      const capacity = (state.gebaeude.wohnmodul || 1) * 5;
      const ratio = state.ressourcen.bevoelkerung / capacity;
      if (ratio < trigger.populationPerHousing) return false;
    }
    if (trigger.oldBuildings) {
      if (state.currentTick < 50) return false;
    }

    // Mitigation durch Forscher
    let mitigationChance = 0;
    this.players.forEach((player) => {
      const role = ROLES[player.role];
      if (role.bonuses.eventMitigation) mitigationChance = role.bonuses.eventMitigation;
    });

    if ((event.severity === "high" || event.severity === "critical") && Math.random() < mitigationChance) {
      return false;
    }

    return true;
  }

  triggerEvent(eventKey, event) {
    const state = this.gameState;

    state.activeEvent = { key: eventKey, ...event, duration: event.duration, triggeredAt: state.currentTick };
    state.statistics.eventsTriggered++;

    if (event.effects.immediate) {
      for (const [resource, change] of Object.entries(event.effects.immediate)) {
        state.ressourcen[resource] = (state.ressourcen[resource] || 0) + change;
      }
    }

    if (event.effects.delayed) {
      this.delayedEffects.push({
        executeTick: state.currentTick + event.effects.delayed.tickDelay,
        effects: event.effects.delayed,
        eventName: event.name,
      });
    }

    this.broadcast({ type: "event_triggered", event: state.activeEvent });

    if (event.requiresVote) {
      this.startVote({
        type: "event_resolution",
        eventKey,
        question: `Wie soll auf "${event.name}" reagiert werden?`,
        options: event.voteOptions,
        timeout: 20,
      });
    }
  }

  updateActiveEvent() {
    const state = this.gameState;
    if (!state.activeEvent || state.activeEvent.duration <= 0) return;

    state.activeEvent.duration--;

    if (state.activeEvent.duration === 0) {
      this.broadcast({ type: "notification", severity: "info", message: `Event "${state.activeEvent.name}" ist vorbei.` });
      state.eventHistory.push({ name: state.activeEvent.name, tick: state.currentTick });
      state.activeEvent = null;
    }
  }

  applyDelayedEffects() {
    const state = this.gameState;

    this.delayedEffects = this.delayedEffects.filter((delayed) => {
      if (state.currentTick >= delayed.executeTick) {
        for (const [resource, change] of Object.entries(delayed.effects)) {
          if (resource !== "tickDelay" && resource !== "message") {
            state.ressourcen[resource] = (state.ressourcen[resource] || 0) + change;
          }
        }
        if (delayed.effects.message) {
          this.broadcast({ type: "notification", severity: "warning", message: `⏰ Verzögerter Effekt: ${delayed.effects.message}` });
        }
        return false;
      }
      return true;
    });
  }

  // ===== Votes =====
  startVote(voteData) {
    const voteId = "vote_" + Date.now();
    const state = this.gameState;

    this.activeVotes.set(voteId, {
      ...voteData,
      votes: new Map(),
      startTick: state.currentTick,
      expiryTick: state.currentTick + voteData.timeout,
    });

    state.statistics.votesHeld++;

    this.broadcast({ type: "vote_started", voteId, voteData });
  }

  castVote(voteId, playerId, choice) {
    const vote = this.activeVotes.get(voteId);
    if (!vote) return { success: false, message: "Abstimmung nicht gefunden" };

    vote.votes.set(playerId, choice);

    if (vote.votes.size === this.players.size) this.resolveVote(voteId);
    return { success: true };
  }

  resolveVote(voteId) {
    const vote = this.activeVotes.get(voteId);
    if (!vote) return;

    const tally = {};
    vote.votes.forEach((choice) => {
      tally[choice] = (tally[choice] || 0) + 1;
    });

    const winner = Object.keys(tally).reduce((a, b) => (tally[a] > tally[b] ? a : b));

    if (vote.type === "event_resolution") this.applyEventResolution(vote.eventKey, winner);

    this.broadcast({ type: "vote_resolved", voteId, winner, tally });
    this.activeVotes.delete(voteId);
  }

  applyEventResolution(eventKey, choice) {
    const state = this.gameState;

    if (eventKey === "aufstand") {
      if (choice === "gewalt") {
        state.ressourcen.bevoelkerung -= 10;
        state.ressourcen.stabilitaet -= 20;
        this.broadcast({ type: "notification", severity: "critical", message: "Gewalt hat die Situation verschlimmert!" });
      } else if (choice === "verhandlung") {
        state.ressourcen.stabilitaet += 15;
        state.ressourcen.energie -= 20;
        this.broadcast({ type: "notification", severity: "success", message: "Verhandlungen waren erfolgreich." });
      } else if (choice === "zugestaendnisse") {
        state.ressourcen.stabilitaet += 25;
        state.ressourcen.nahrung -= 40;
        this.broadcast({ type: "notification", severity: "info", message: "Zugeständnisse haben die Lage beruhigt." });
      }
      state.activeEvent = null;

      // crisesResolved reward (einmal pro Aufstand)
      this.players.forEach((p) => {
        const prog = getPlayerProgress(p.id);
        prog.lifetime.crisesResolved += 1;
        prog.skillPoints += 1;
      });
      saveProgress();
    }
  }

  // ===== Difficulty =====
  updateDifficulty() {
    const state = this.gameState;
    const tickProgress = state.currentTick / 720;
    state.difficultyMultiplier = 1.0 + tickProgress * 0.5;

    const totalBuildings = Object.values(state.gebaeude).reduce((a, b) => a + b, 0);
    if (totalBuildings > 30) state.difficultyMultiplier += 0.2;
  }

  // ===== Enemies (Basis; UI später) =====
  spawnEnemies() {
    const state = this.gameState;

    // Spawn-Chance skaliert mit Fortschritt
    let chance = 0.08 + Math.min(0.12, state.currentTick / 3000);

    // Skills
    const teamSkillEffects = this.getTeamSkillEffects();
    if (teamSkillEffects.enemySpawnChanceMult) chance *= teamSkillEffects.enemySpawnChanceMult;

    // Türme reduzieren effektiv Spawns (wenn vorhanden)
    const towers = state.gebaeude.defense_tower || 0;
    if (towers > 0) chance *= Math.max(0.55, 1 - towers * 0.05);

    if (Math.random() > chance) return;

    // Enemy spawnt am linken Rand auf dem Weg
    const w = state.map.width;
    const h = state.map.height;
    const midY = Math.floor(h / 2);

    const enemyId = `e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const hp = 60 + Math.floor(state.difficultyMultiplier * 30);
    const speed = 1; // tiles per tick (vereinfachtes Modell)

    state.enemies.push({
      id: enemyId,
      hp,
      speed,
      x: 0,
      y: midY,
      progress: 0,
      targetType: this.pickEnemyTarget(state),
    });

    this.broadcast({ type: "notification", severity: "warning", message: `👾 Gegner gesichtet! Ziel: ${state.enemies[state.enemies.length - 1].targetType}` });
  }

  pickEnemyTarget(state) {
    // bevorzugt Generator/Farm; wenn nicht vorhanden, irgendwas
    const priority = ["generator", "farm", "wohnmodul", "forschungslabor"];
    for (const t of priority) if ((state.gebaeude[t] || 0) > 0) return t;
    return "generator";
  }

  processEnemies() {
    const state = this.gameState;
    if (state.enemies.length === 0) return;

    // Türme schießen (vereinfachte Logik): pro Turm 1 Treffer je Tick auf erstes Ziel
    const towers = state.gebaeude.defense_tower || 0;
    if (towers > 0) {
      const dmg = 8 + Math.floor(towers * 1.5);
      if (state.enemies[0]) state.enemies[0].hp -= dmg;
    }

    // Tote entfernen + Reward
    state.enemies = state.enemies.filter((e) => {
      if (e.hp <= 0) {
        this.broadcast({ type: "notification", severity: "success", message: `💥 Gegner eliminiert!` });
        this.players.forEach((p) => {
          const prog = getPlayerProgress(p.id);
          prog.lifetime.enemiesDefeated += 1;
          prog.skillPoints += 1;
        });
        saveProgress();
        return false;
      }
      return true;
    });

    // Bewegung: am Weg nach rechts
    const w = state.map.width;
    for (const e of state.enemies) {
      e.x = Math.min(w - 1, e.x + e.speed);
      if (e.x >= w - 1) {
        // erreicht Ende → beschädigt Gebäude/Ressourcen
        const t = e.targetType;
        if ((state.gebaeude[t] || 0) > 0) {
          state.gebaeude[t] -= 1;
          state.ressourcen.stabilitaet = Math.max(0, state.ressourcen.stabilitaet - 12);
          this.broadcast({ type: "notification", severity: "critical", message: `🏚️ Gegner hat ein Gebäude zerstört: ${BUILDINGS[t]?.name || t}` });
        } else {
          state.ressourcen.energie = Math.max(0, state.ressourcen.energie - 40);
          state.ressourcen.nahrung = Math.max(0, state.ressourcen.nahrung - 40);
          state.ressourcen.stabilitaet = Math.max(0, state.ressourcen.stabilitaet - 8);
          this.broadcast({ type: "notification", severity: "critical", message: `⚠️ Gegner hat Infrastruktur beschädigt (Ressourcenverlust).` });
        }
        e.hp = 0; // wird entfernt
      }
    }

    // Cleanup nach Bewegung
    state.enemies = state.enemies.filter((e) => e.hp > 0);
  }

  // ===== Special Action =====
  useSpecialAction(playerId) {
    const player = this.players.get(playerId);
    if (!player) return { success: false, message: "Spieler nicht gefunden" };

    const role = ROLES[player.role];
    const state = this.gameState;

    const ticksSinceLastUse = state.currentTick - player.specialActionLastUsed;
    if (ticksSinceLastUse < role.cooldown) {
      return { success: false, message: `Noch ${role.cooldown - ticksSinceLastUse} Ticks Cooldown` };
    }

    let resultMessage = "";
    switch (role.specialAction) {
      case "repair":
        state.ressourcen.stabilitaet = Math.min(100, state.ressourcen.stabilitaet + 15);
        state.ressourcen.energie += 20;
        resultMessage = "Systeme repariert (+15 Stabilität, +20 Energie).";
        break;
      case "research":
        state.ressourcen.forschung += 12;
        resultMessage = "Forschungsschub (+12 Forschung).";
        break;
      case "optimize":
        state.ressourcen.nahrung += 25;
        state.ressourcen.energie += 10;
        resultMessage = "Ressourcen optimiert (+25 Nahrung, +10 Energie).";
        break;
      case "negotiate":
        state.ressourcen.stabilitaet = Math.min(100, state.ressourcen.stabilitaet + 20);
        state.ressourcen.bevoelkerung += 2;
        resultMessage = "Verhandelt (+20 Stabilität, +2 Bevölkerung).";
        break;
      default:
        return { success: false, message: "Unbekannte Spezialaktion" };
    }

    player.specialActionLastUsed = state.currentTick;
    this.broadcast({ type: "notification", severity: "info", message: `🔸 ${player.name} (${role.name}) Spezialaktion: ${resultMessage}` });
    return { success: true, message: resultMessage };
  }

  // ===== Team Skill Effects (Aggregat) =====
  getTeamSkillEffects() {
    const effects = {};
    this.players.forEach((p) => {
      const prog = getPlayerProgress(p.id);
      for (const skillId of prog.skills) {
        const s = SKILLS[skillId];
        if (!s || !s.effect) continue;
        for (const [k, v] of Object.entries(s.effect)) {
          if (typeof v === "number") {
            // Multiplikatoren werden multipliziert, Floors/Bonuses addieren
            if (k.endsWith("Mult")) effects[k] = (effects[k] || 1) * v;
            else effects[k] = Math.max(effects[k] || 0, v);
          }
        }
      }
    });
    return effects;
  }

  // ===== Broadcast =====
  broadcast(data) {
    this.players.forEach((player) => {
      if (player.ws && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(data));
      }
    });
  }

  broadcastState() {
    const stateCopy = JSON.parse(JSON.stringify(this.gameState));
    const playersList = Array.from(this.players.values()).map((p) => ({ id: p.id, name: p.name, role: p.role }));

    this.players.forEach((player) => {
      const ws = player.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Progress mitliefern (für Skill Tree UI später)
        const prog = getPlayerProgress(player.id);
        ws.send(
          JSON.stringify({
            type: "update_state",
            state: stateCopy,
            players: playersList,
            progress: {
              skillPoints: prog.skillPoints,
              skills: prog.skills,
              era: prog.era,
              lifetime: prog.lifetime,
            },
            eras: ERAS,
          })
        );
      }
    });
  }

  // ===== Game Over =====
  checkGameOver() {
    const state = this.gameState;

    if (state.ressourcen.bevoelkerung <= 0) {
      this.broadcast({ type: "game_over", reason: "Die gesamte Bevölkerung ist gestorben." });
      this.stopTicking();
    }

    if (state.ressourcen.stabilitaet <= 0) {
      this.broadcast({ type: "game_over", reason: "Die Kolonie ist im Chaos versunken." });
      this.stopTicking();
    }
  }
}

// ========================================
// WEBSOCKET SERVER
// ========================================
const server = http.createServer();
(async () => {
  try {
    await db.initRedis();
  } catch (e) {
    console.error("Redis init failed:", e);
  }
})();

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: "Ungültige Nachricht" }));
    }
  });

  ws.on("close", () => {
    if (ws.lobbyId && lobbies.has(ws.lobbyId)) {
      const lobby = lobbies.get(ws.lobbyId);
      lobby.removePlayer(ws.playerId);
      if (lobby.players.size === 0) lobbies.delete(ws.lobbyId);
    }
  });
});

// ========================================
// MESSAGE HANDLER
// ========================================
function handleMessage(ws, data) {
  switch (data.type) {
    case "create_lobby":
      handleCreateLobby(ws, data);
      break;

    case "join_lobby":
      handleJoinLobby(ws, data);
      break;

    case "leave_lobby":
      handleLeaveLobby(ws);
      break;

    case "special_action":
      handleSpecialAction(ws);
      break;

    case "cast_vote":
      handleCastVote(ws, data);
      break;

    // Bauen (Challenge-basiert)
    case "build":
      handleBuildRequest(ws, data);
      break;

    case "submit_build_result":
      handleSubmitBuildResult(ws, data);
      break;

    // Upgrade (Challenge-basiert)
    case "start_upgrade":
      handleStartUpgrade(ws, data);
      break;

    case "submit_upgrade_result":
      handleSubmitUpgradeResult(ws, data);
      break;

    // Abreißen (Challenge-basiert)
    case "start_demolish":
      handleStartDemolish(ws, data);
      break;

    case "submit_demolish_result":
      handleSubmitDemolishResult(ws, data);
      break;

    // Epoche
    case "unlock_era":
      handleUnlockEra(ws, data);
      break;

    // Skills
    case "skill_unlock":
      handleSkillUnlock(ws, data);
      break;

    case "skill_respec":
      handleSkillRespec(ws);
      break;

    default:
      ws.send(JSON.stringify({ type: "error", message: "Unbekannter Nachrichtentyp" }));
  }
}

// ========================================
// LOBBY HANDLER
// ========================================
function generateLobbyCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function handleCreateLobby(ws, data) {
  const lobbyCode = generateLobbyCode();
  const lobby = new Lobby(lobbyCode);
  lobbies.set(lobbyCode, lobby);

  ws.lobbyId = lobbyCode;
  ws.playerId = data.playerId;

  const res = lobby.addPlayer(data.playerId, data.playerName, data.role, ws);
  if (!res.success) {
    ws.send(JSON.stringify({ type: "error", message: res.message }));
    return;
  }

  ws.send(JSON.stringify({ type: "lobby_created", lobbyId: lobbyCode }));
  lobby.broadcastState();
}

function handleJoinLobby(ws, data) {
  const lobbyId = (data.lobbyId || "").toUpperCase();
  const lobby = lobbies.get(lobbyId);

  if (!lobby) {
    ws.send(JSON.stringify({ type: "error", message: "Lobby nicht gefunden" }));
    return;
  }

  ws.lobbyId = lobbyId;
  ws.playerId = data.playerId;

  const result = lobby.addPlayer(data.playerId, data.playerName, data.role, ws);
  if (!result.success) {
    ws.send(JSON.stringify({ type: "error", message: result.message }));
    return;
  }

  ws.send(JSON.stringify({ type: "lobby_joined", lobbyId }));
  lobby.broadcastState();
}

function handleLeaveLobby(ws) {
  if (!ws.lobbyId || !lobbies.has(ws.lobbyId)) return;
  const lobby = lobbies.get(ws.lobbyId);
  lobby.removePlayer(ws.playerId);
  if (lobby.players.size === 0) lobbies.delete(ws.lobbyId);
  ws.lobbyId = null;
  ws.playerId = null;
}

function handleSpecialAction(ws) {
  const lobby = lobbies.get(ws.lobbyId);
  if (!lobby) return;

  const result = lobby.useSpecialAction(ws.playerId);
  ws.send(JSON.stringify({ type: "special_action_result", ...result }));
  lobby.broadcastState();
}

function handleCastVote(ws, data) {
  const lobby = lobbies.get(ws.lobbyId);
  if (!lobby) return;

  const res = lobby.castVote(data.voteId, ws.playerId, data.choice);
  if (!res.success) ws.send(JSON.stringify({ type: "error", message: res.message }));
}

// ========================================
// BUILD / UPGRADE / DEMOLISH (Challenge-Logik, server-authoritative)
// ========================================
function handleBuildRequest(ws, data) {
  const lobby = lobbies.get(ws.lobbyId);
  if (!lobby) return;

  const state = lobby.gameState;
  const buildingType = data.buildingType;

  if (!buildingType || !BUILDINGS[buildingType]) {
    ws.send(JSON.stringify({ type: "error", message: "Unbekannter Gebäudetyp" }));
    return;
  }

  // MaxCount prüfen
  const currentCount = state.gebaeude[buildingType] || 0;
  const queuedCount = state.bauWarteschlange.filter((b) => b.typ === buildingType).length;
  if (typeof BUILDINGS[buildingType].maxCount === "number" && currentCount + queuedCount >= BUILDINGS[buildingType].maxCount) {
    ws.send(JSON.stringify({ type: "notification", severity: "warning", message: `${BUILDINGS[buildingType].name}: Maximalanzahl erreicht.` }));
    return;
  }

  // Anti-Spam: Kosten steigen pro Bauart
  const spamLevel = state.spamTax[buildingType] || 0;

  // Skill: spamTaxReduction
  const prog = getPlayerProgress(ws.playerId);
  const reductionSkill = prog.skills.includes("cost_scaling") ? (SKILLS.cost_scaling.effect.spamTaxReduction || 0) : 0;

  const spamMultBase = 1 + spamLevel * 0.12;
  const spamMult = Math.min(3.0, Math.max(1.0, spamMultBase * (1 - reductionSkill)));

  // Rollen-Kostenreduktion
  const player = lobby.players.get(ws.playerId);
  const role = player ? ROLES[player.role] : null;
  const roleReduction = role?.bonuses?.buildCostReduction || 0;

  const baseE = BUILDINGS[buildingType].cost?.energie || 0;
  const baseF = BUILDINGS[buildingType].cost?.nahrung || 0;
  const finalE = Math.ceil(baseE * spamMult * (1 - roleReduction));
  const finalF = Math.ceil(baseF * spamMult * (1 - roleReduction));

  if (state.ressourcen.energie < finalE || state.ressourcen.nahrung < finalF) {
    ws.send(JSON.stringify({ type: "notification", severity: "warning", message: `Zu wenig Ressourcen. Kosten: ⚡${finalE} 🌾${finalF}` }));
    return;
  }

  // Kosten sofort abziehen (Fail tut weh)
  state.ressourcen.energie -= finalE;
  state.ressourcen.nahrung -= finalF;

  // Challenge erstellen
  const challengeId = `b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const difficulty = Math.min(10, 2 + spamLevel + (state.era !== "proto" ? 1 : 0));
  const expiresAtTick = state.currentTick + 8;

  state.activeChallenges.builds[challengeId] = {
    challengeId,
    playerId: ws.playerId,
    buildingType,
    difficulty,
    expiresAtTick,
    costPaid: { energie: finalE, nahrung: finalF },
    createdAtTick: state.currentTick,
  };

  // SpamTax erhöhen
  state.spamTax[buildingType] = spamLevel + 1;

  // Micro-Reward
  prog.skillPoints += 1;
  saveProgress();

  ws.send(JSON.stringify({ type: "build_challenge_started", challenge: state.activeChallenges.builds[challengeId] }));
  lobby.broadcast({ type: "notification", severity: "info", message: `🧩 Bau-Challenge gestartet: ${BUILDINGS[buildingType].name} (Schwierigkeit ${difficulty}/10)` });
  lobby.broadcastState();
}

function handleSubmitBuildResult(ws, data) {
  const lobby = lobbies.get(ws.lobbyId);
  if (!lobby) return;

  const state = lobby.gameState;
  const ch = state.activeChallenges.builds[data.challengeId];

  if (!ch || ch.playerId !== ws.playerId) {
    ws.send(JSON.stringify({ type: "error", message: "Build-Challenge nicht gefunden" }));
    return;
  }

  if (state.currentTick > ch.expiresAtTick) {
    delete state.activeChallenges.builds[data.challengeId];
    lobby.broadcast({ type: "notification", severity: "critical", message: "⛔ Bau-Challenge abgelaufen. Bau fehlgeschlagen." });
    lobby.broadcastState();
    return;
  }
  const success = !!data.success;

  if (!success) {
    // Fail: Ressourcen bleiben weg + Stabilitätsstrafe (spürbar)
    state.ressourcen.stabilitaet = Math.max(0, state.ressourcen.stabilitaet - (5 + ch.difficulty));
    lobby.broadcast({
      type: "notification",
      severity: "critical",
      message: `💥 Bau fehlgeschlagen: ${BUILDINGS[ch.buildingType].name} (Stabilität -${5 + ch.difficulty}).`,
    });
    delete state.activeChallenges.builds[data.challengeId];
    lobby.broadcastState();
    return;
  }

  // Erfolg: ab in echte Bau-Queue
  let buildTime = BUILDINGS[ch.buildingType].buildTime || 3;

  // Skill: build_rush (-10% Bauzeit)
  const prog = getPlayerProgress(ws.playerId);
  if (prog.skills.includes("build_rush")) {
    const mult = SKILLS.build_rush.effect.buildTimeMult || 0.9;
    buildTime = Math.max(1, Math.ceil(buildTime * mult));
  }

  state.bauWarteschlange.push({
    typ: ch.buildingType,
    startedTick: state.currentTick,
    fertigTick: state.currentTick + buildTime,
    byPlayerId: ws.playerId,
  });

  prog.lifetime.buildingsBuilt += 1;
  prog.skillPoints += Math.ceil(ch.difficulty / 2);
  saveProgress();

  lobby.broadcast({
    type: "notification",
    severity: "success",
    message: `✅ Bau-Challenge bestanden: ${BUILDINGS[ch.buildingType].name} (fertig in ${buildTime} Ticks).`,
  });

  delete state.activeChallenges.builds[data.challengeId];
  lobby.broadcastState();
}

// =====================
// UPGRADE (Challenge)
// =====================
function handleStartUpgrade(ws, data) {
  const lobby = lobbies.get(ws.lobbyId);
  if (!lobby) return;

  const state = lobby.gameState;
  const buildingType = data.buildingType;

  if (!buildingType || !BUILDINGS[buildingType]) {
    ws.send(JSON.stringify({ type: "error", message: "Unbekannter Gebäudetyp" }));
    return;
  }

  if ((state.gebaeude[buildingType] || 0) <= 0) {
    ws.send(JSON.stringify({ type: "notification", severity: "warning", message: "Kein Gebäude vorhanden zum Upgraden." }));
    return;
  }

  const currentLevel = state.buildingLevels[buildingType] || 1;
  const nextLevel = currentLevel + 1;

  // Upgrade-Kosten skalieren stark (gegen Spam)
  const baseE = BUILDINGS[buildingType].cost?.energie || 0;
  const baseF = BUILDINGS[buildingType].cost?.nahrung || 0;

  const costE = Math.ceil(baseE * (0.8 + nextLevel * 0.9));
  const costF = Math.ceil(baseF * (0.8 + nextLevel * 0.9));

  if (state.ressourcen.energie < costE || state.ressourcen.nahrung < costF) {
    ws.send(JSON.stringify({ type: "notification", severity: "warning", message: `Upgrade zu teuer. Kosten: ⚡${costE} 🌾${costF}` }));
    return;
  }

  state.ressourcen.energie -= costE;
  state.ressourcen.nahrung -= costF;

  const challengeId = `u_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const difficulty = Math.min(10, 3 + nextLevel);
  const expiresAtTick = state.currentTick + 10;

  state.activeChallenges.upgrades[challengeId] = {
    challengeId,
    playerId: ws.playerId,
    buildingType,
    fromLevel: currentLevel,
    toLevel: nextLevel,
    difficulty,
    expiresAtTick,
  };

  ws.send(JSON.stringify({ type: "upgrade_challenge_started", challenge: state.activeChallenges.upgrades[challengeId] }));
  lobby.broadcast({ type: "notification", severity: "info", message: `🧩 Upgrade-Challenge: ${BUILDINGS[buildingType].name} → Level ${nextLevel} (Schwierigkeit ${difficulty}/10)` });
  lobby.broadcastState();
}

function handleSubmitUpgradeResult(ws, data) {
  const lobby = lobbies.get(ws.lobbyId);
  if (!lobby) return;

  const state = lobby.gameState;
  const ch = state.activeChallenges.upgrades[data.challengeId];

  if (!ch || ch.playerId !== ws.playerId) {
    ws.send(JSON.stringify({ type: "error", message: "Upgrade-Challenge nicht gefunden" }));
    return;
  }

  if (state.currentTick > ch.expiresAtTick) {
    delete state.activeChallenges.upgrades[data.challengeId];
    lobby.broadcast({ type: "notification", severity: "critical", message: "⛔ Upgrade-Challenge abgelaufen. Upgrade fehlgeschlagen." });
    lobby.broadcastState();
    return;
  }

  const success = !!data.success;

  if (!success) {
    // Fail: Stabilitätsverlust + kurzer Produktionsmalus als Debuff
    state.ressourcen.stabilitaet = Math.max(0, state.ressourcen.stabilitaet - (8 + ch.difficulty));
    state.activeEvent = state.activeEvent || null;

    // Debuff als delayedEffect: 3 Ticks Produktionsmalus
    lobby.delayedEffects.push({
      executeTick: state.currentTick + 1,
      effects: { message: `Upgrade-Schaden: ${BUILDINGS[ch.buildingType].name} arbeitet ineffizient.` },
      eventName: "Upgrade-Schaden",
    });
    lobby.delayedEffects.push({
      executeTick: state.currentTick + 2,
      effects: { message: `Upgrade-Schaden hält an…` },
      eventName: "Upgrade-Schaden",
    });
    lobby.delayedEffects.push({
      executeTick: state.currentTick + 3,
      effects: { message: `Upgrade-Schaden behoben.` },
      eventName: "Upgrade-Schaden",
    });

    lobby.broadcast({
      type: "notification",
      severity: "critical",
      message: `💥 Upgrade fehlgeschlagen: ${BUILDINGS[ch.buildingType].name} (Stabilität -${8 + ch.difficulty}).`,
    });

    delete state.activeChallenges.upgrades[data.challengeId];
    lobby.broadcastState();
    return;
  }

  // Erfolg
  state.buildingLevels[ch.buildingType] = ch.toLevel;

  const prog = getPlayerProgress(ws.playerId);
  prog.skillPoints += 2;
  saveProgress();

  lobby.broadcast({
    type: "notification",
    severity: "success",
    message: `✅ Upgrade erfolgreich: ${BUILDINGS[ch.buildingType].name} ist jetzt Level ${ch.toLevel}!`,
  });

  delete state.activeChallenges.upgrades[data.challengeId];
  lobby.broadcastState();
}

// =====================
// DEMOLISH (Challenge)
// =====================
function handleStartDemolish(ws, data) {
  const lobby = lobbies.get(ws.lobbyId);
  if (!lobby) return;

  const state = lobby.gameState;
  const buildingType = data.buildingType;

  if (!buildingType || !BUILDINGS[buildingType]) {
    ws.send(JSON.stringify({ type: "error", message: "Unbekannter Gebäudetyp" }));
    return;
  }

  if ((state.gebaeude[buildingType] || 0) <= 0) {
    ws.send(JSON.stringify({ type: "notification", severity: "warning", message: "Nichts zum Abreißen vorhanden." }));
    return;
  }

  const lvl = state.buildingLevels[buildingType] || 1;
  const challengeId = `d_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const difficulty = Math.min(10, 4 + lvl);
  const expiresAtTick = state.currentTick + 8;

  state.activeChallenges.demolish[challengeId] = {
    challengeId,
    playerId: ws.playerId,
    buildingType,
    difficulty,
    expiresAtTick,
  };

  ws.send(JSON.stringify({ type: "demolish_challenge_started", challenge: state.activeChallenges.demolish[challengeId] }));
  lobby.broadcast({ type: "notification", severity: "info", message: `🧩 Abriss-Challenge gestartet: ${BUILDINGS[buildingType].name} (Schwierigkeit ${difficulty}/10)` });
  lobby.broadcastState();
}

function handleSubmitDemolishResult(ws, data) {
  const lobby = lobbies.get(ws.lobbyId);
  if (!lobby) return;

  const state = lobby.gameState;
  const ch = state.activeChallenges.demolish[data.challengeId];

  if (!ch || ch.playerId !== ws.playerId) {
    ws.send(JSON.stringify({ type: "error", message: "Abriss-Challenge nicht gefunden" }));
    return;
  }

  if (state.currentTick > ch.expiresAtTick) {
    delete state.activeChallenges.demolish[data.challengeId];
    lobby.broadcast({ type: "notification", severity: "critical", message: "⛔ Abriss-Challenge abgelaufen. Abriss fehlgeschlagen." });
    lobby.broadcastState();
    return;
  }

  const success = !!data.success;

  if (!success) {
    // Fail: Explosion/Schaden
    state.ressourcen.stabilitaet = Math.max(0, state.ressourcen.stabilitaet - (10 + ch.difficulty));
    state.ressourcen.energie = Math.max(0, state.ressourcen.energie - 30);

    lobby.broadcast({
      type: "notification",
      severity: "critical",
      message: `💥 Abriss fehlgeschlagen! Stabilität -${10 + ch.difficulty}, Energie -30.`,
    });

    delete state.activeChallenges.demolish[data.challengeId];
    lobby.broadcastState();
    return;
  }

  // Erfolg: 1 Gebäude entfernen + Teil-Rückerstattung
  state.gebaeude[ch.buildingType] = Math.max(0, (state.gebaeude[ch.buildingType] || 0) - 1);

  const refundE = Math.floor((BUILDINGS[ch.buildingType].cost?.energie || 0) * 0.25);
  const refundF = Math.floor((BUILDINGS[ch.buildingType].cost?.nahrung || 0) * 0.25);

  state.ressourcen.energie += refundE;
  state.ressourcen.nahrung += refundF;

  lobby.broadcast({
    type: "notification",
    severity: "success",
    message: `✅ ${BUILDINGS[ch.buildingType].name} abgerissen. Rückerstattung: ⚡${refundE} 🌾${refundF}`,
  });

  delete state.activeChallenges.demolish[data.challengeId];
  lobby.broadcastState();
}

// =====================
// ERA UNLOCK (kaufbar)
// =====================
function handleUnlockEra(ws, data) {
  const lobby = lobbies.get(ws.lobbyId);
  if (!lobby) return;

  const state = lobby.gameState;
  const targetEra = data.eraId;
  const era = ERAS.find((e) => e.id === targetEra);

  if (!era) {
    ws.send(JSON.stringify({ type: "error", message: "Unbekannte Epoche" }));
    return;
  }

  // Nur nächste Epoche (kein Skip)
  const currentIndex = ERAS.findIndex((e) => e.id === state.era);
  const targetIndex = ERAS.findIndex((e) => e.id === targetEra);

  if (targetIndex !== currentIndex + 1) {
    ws.send(JSON.stringify({ type: "notification", severity: "warning", message: "Du kannst nur die nächste Epoche freischalten." }));
    return;
  }

  const need = era.unlock || {};
  const okPop = need.pop ? state.ressourcen.bevoelkerung >= need.pop : true;
  const okFood = need.food ? state.ressourcen.nahrung >= need.food : true;
  const okEnergy = need.energy ? state.ressourcen.energie >= need.energy : true;
  const okResearch = need.research ? state.ressourcen.forschung >= need.research : true;
  const okStab = need.stability ? state.ressourcen.stabilitaet >= need.stability : true;
  const okLabs = need.labs ? (state.gebaeude.forschungslabor || 0) >= need.labs : true;

  if (!(okPop && okFood && okEnergy && okResearch && okStab && okLabs)) {
    ws.send(JSON.stringify({ type: "notification", severity: "warning", message: "Voraussetzungen für die Epoche nicht erfüllt." }));
    return;
  }

  // Optional: “Kaufpreis” abziehen (macht es fühlbar)
  if (need.food) state.ressourcen.nahrung -= Math.floor(need.food * 0.25);
  if (need.energy) state.ressourcen.energie -= Math.floor(need.energy * 0.25);
  if (need.research) state.ressourcen.forschung -= Math.floor(need.research * 0.2);

  state.era = targetEra;

  // Persist progress
  const prog = getPlayerProgress(ws.playerId);
  prog.era = targetEra;
  prog.skillPoints += 5; // großer Hit
  saveProgress();

  lobby.broadcast({ type: "notification", severity: "success", message: `🏛️ Neue Epoche freigeschaltet: ${era.name}` });
  lobby.broadcastState();
}

// =====================
// SKILL UNLOCK (permanent)
// =====================
function handleSkillUnlock(ws, data) {
  const playerId = ws.playerId;
  if (!playerId) return;

  const skillId = data.skillId;
  const skill = SKILLS[skillId];

  if (!skill) {
    ws.send(JSON.stringify({ type: "error", message: "Unbekannter Skill" }));
    return;
  }

  const prog = getPlayerProgress(playerId);

  if (prog.skills.includes(skillId)) {
    ws.send(JSON.stringify({ type: "notification", severity: "warning", message: "Skill bereits freigeschaltet." }));
    return;
  }

  const req = skill.requires || [];
  const hasReq = req.every((r) => prog.skills.includes(r));
  if (!hasReq) {
    ws.send(JSON.stringify({ type: "notification", severity: "warning", message: "Voraussetzungen fehlen." }));
    return;
  }

  if (prog.skillPoints < skill.cost) {
    ws.send(JSON.stringify({ type: "notification", severity: "warning", message: "Zu wenig Skillpoints." }));
    return;
  }

  prog.skillPoints -= skill.cost;
  prog.skills.push(skillId);
  saveProgress();

  ws.send(JSON.stringify({ type: "skill_unlocked", skillId, remainingPoints: prog.skillPoints, skills: prog.skills }));
}

function handleSkillRespec(ws) {
  // explizit deaktiviert, weil du "permanent" willst
  ws.send(JSON.stringify({ type: "notification", severity: "warning", message: "Respec ist deaktiviert (Skills sind permanent)." }));
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});


