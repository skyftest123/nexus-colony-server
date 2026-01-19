// ========================================
// NEXUS COLONY - MULTIPLAYER IDLE GAME
// Server.js - Node.js + WebSocket Server
// ERWEITERTE VERSION MIT ROLLEN, EREIGNISSEN & KOOP-MECHANIKEN
// ========================================

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TICK_INTERVAL = 5000; // 5 Sekunden pro Tick

// ========================================
// LOBBY VERWALTUNG
// ========================================
const lobbies = new Map(); // lobbyCode -> Lobby

// ========================================
// DESIGN-ENTSCHEIDUNG: ROLLEN-SYSTEM
// ========================================

const ROLES = {
  engineer: {
    name: 'Ingenieur',
    description: 'Spezialist für Gebäude und Energie',
    bonuses: {
      buildCostReduction: 0.15,
      energieProduction: 1.2,
      maintenanceReduction: 0.25
    },
    specialAction: 'repair',
    cooldown: 10
  },
  researcher: {
    name: 'Forscher',
    description: 'Entwickelt Technologien und Effizienz',
    bonuses: {
      researchSpeed: 2.0,
      eventMitigation: 0.3,
      bevoelkerungEfficiency: 1.15
    },
    specialAction: 'research',
    cooldown: 15
  },
  logistician: {
    name: 'Logistiker',
    description: 'Optimiert Ressourcen und Produktion',
    bonuses: {
      resourceEfficiency: 1.25,
      storageBonus: 1.5,
      nahrungProduction: 1.3
    },
    specialAction: 'optimize',
    cooldown: 12
  },
  diplomat: {
    name: 'Diplomat',
    description: 'Verwaltet Bevölkerung und Stabilität',
    bonuses: {
      stabilityBonus: 0.2,
      populationGrowth: 1.4,
      crisisResolution: 0.4
    },
    specialAction: 'negotiate',
    cooldown: 8
  }
};

const BUILDINGS = {
  generator: {
    name: 'Generator',
    cost: { energie: 0, nahrung: 50 },
    production: { energie: 10 },
    maintenance: { energie: 0, nahrung: 2 },
    buildTime: 3,
    maxCount: 20,
    stabilityImpact: -1
  },
  farm: {
    name: 'Farm',
    cost: { energie: 30, nahrung: 0 },
    production: { nahrung: 8 },
    maintenance: { energie: 1, nahrung: 0 },
    buildTime: 3,
    maxCount: 15,
    stabilityImpact: 0
  },
  wohnmodul: {
    name: 'Wohnmodul',
    cost: { energie: 40, nahrung: 60 },
    production: { bevoelkerung: 5 },
    maintenance: { energie: 2, nahrung: 3 },
    buildTime: 5,
    maxCount: 12,
    stabilityImpact: -2
  },
  forschungslabor: {
    name: 'Forschungslabor',
    cost: { energie: 80, nahrung: 40 },
    production: { forschung: 2 },
    maintenance: { energie: 5, nahrung: 2 },
    buildTime: 8,
    maxCount: 5,
    stabilityImpact: 1
  },
  stabilisator: {
    name: 'Stabilisator',
    cost: { energie: 60, nahrung: 50 },
    production: {},
    maintenance: { energie: 3, nahrung: 2 },
    buildTime: 6,
    maxCount: 8,
    stabilityImpact: 5,
    stabilityBonus: 3
  }
};

const EVENTS = {
  stromausfall: {
    name: 'Stromausfall',
    description: 'Ein Generator ist ausgefallen!',
    severity: 'medium',
    trigger: { minBuildings: 5, chance: 0.15 },
    effects: {
      immediate: { energie: -50 },
      delayed: {
        tickDelay: 3,
        stabilitaet: -15,
        message: 'Die Nachwirkungen des Stromausfalls belasten die Kolonie'
      }
    },
    duration: 2,
    requiresVote: false
  },
  hungersnot: {
    name: 'Hungersnot',
    description: 'Ernteausfälle bedrohen die Nahrungsversorgung!',
    severity: 'high',
    trigger: { minPopulation: 50, lowFood: true, chance: 0.12 },
    effects: {
      immediate: { nahrung: -80, stabilitaet: -20 },
      delayed: {
        tickDelay: 5,
        bevoelkerung: -10,
        message: 'Mangelernährung fordert Opfer in der Bevölkerung'
      }
    },
    duration: 4,
    requiresVote: false,
    canBeMitigated: true
  },
  aufstand: {
    name: 'Aufstand',
    description: 'Die Bevölkerung rebelliert gegen die Führung!',
    severity: 'critical',
    trigger: { minPopulation: 40, lowStability: true, chance: 0.2 },
    effects: {
      immediate: { stabilitaet: -30, bevoelkerung: -5 },
      delayed: {
        tickDelay: 2,
        energie: -30,
        nahrung: -30,
        message: 'Der Aufstand hat Infrastruktur beschädigt'
      }
    },
    duration: 3,
    requiresVote: true,
    voteOptions: ['gewalt', 'verhandlung', 'zugestaendnisse']
  },
  technologiedurchbruch: {
    name: 'Technologiedurchbruch',
    description: 'Forscher haben eine wichtige Entdeckung gemacht!',
    severity: 'positive',
    trigger: { minResearch: 50, chance: 0.18 },
    effects: {
      immediate: { forschung: 20, stabilitaet: 10 }
    },
    duration: 1,
    requiresVote: false
  },
  uebervoelkerung: {
    name: 'Übervölkerung',
    description: 'Zu viele Menschen, zu wenig Raum!',
    severity: 'high',
    trigger: { populationPerHousing: 8, chance: 0.25 },
    effects: {
      immediate: { stabilitaet: -25 },
      delayed: {
        tickDelay: 4,
        nahrung: -40,
        energie: -20,
        stabilitaet: -15,
        message: 'Überbelegung führt zu Ressourcenproblemen'
      }
    },
    duration: 3,
    requiresVote: false,
    preventBuilding: 'wohnmodul'
  },
  maschinenverschleiss: {
    name: 'Maschinenverschleiß',
    description: 'Alte Anlagen benötigen dringend Wartung!',
    severity: 'medium',
    trigger: { oldBuildings: true, chance: 0.2 },
    effects: {
      immediate: {},
      maintenanceMultiplier: 2.0,
      productionMultiplier: 0.7
    },
    duration: 5,
    requiresVote: false,
    canBeMitigated: true
  }
};

const RESEARCH = {
  effizienz_1: {
    name: 'Effizienztechnologie I',
    cost: 50,
    time: 10,
    effect: { productionBonus: 0.15 },
    requires: []
  },
  solar_upgrade: {
    name: 'Solarzellenverbesserung',
    cost: 80,
    time: 15,
    effect: { energieBonus: 0.25 },
    requires: ['effizienz_1']
  },
  hydroponik: {
    name: 'Hydroponische Landwirtschaft',
    cost: 100,
    time: 20,
    effect: { nahrungBonus: 0.3, maintenanceReduction: 0.1 },
    requires: ['effizienz_1']
  },
  sozialreform: {
    name: 'Sozialreformen',
    cost: 120,
    time: 18,
    effect: { stabilityBonus: 20, populationEfficiency: 0.2 },
    requires: []
  },
  automation: {
    name: 'Automatisierung',
    cost: 150,
    time: 25,
    effect: { maintenanceReduction: 0.3, productionBonus: 0.2 },
    requires: ['effizienz_1', 'solar_upgrade']
  }
};

// ========================================
// LOBBY KLASSE
// ========================================

class Lobby {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.maxPlayers = 4;
    this.gameState = this.createInitialState();
    this.lastTick = Date.now();
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
        stabilitaet: 100
      },
      gebaeude: {
        generator: 2,
        farm: 2,
        wohnmodul: 1,
        forschungslabor: 0,
        stabilisator: 0
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
        populationPeak: 15
      }
    };
  }

  addPlayer(playerId, playerName, role, ws) {
    if (this.players.size >= this.maxPlayers) {
      return { success: false, message: 'Lobby voll' };
    }

    const existingRoles = Array.from(this.players.values()).map(p => p.role);
    if (existingRoles.includes(role)) {
      return { success: false, message: 'Rolle bereits vergeben' };
    }

    this.players.set(playerId, {
      id: playerId,
      name: playerName,
      role: role,
      ws: ws,
      joinedAt: Date.now(),
      actionsUsed: 0,
      specialActionLastUsed: -999
    });

    console.log(`Spieler ${playerName} (${ROLES[role].name}) ist Lobby ${this.code} beigetreten`);
    return { success: true };
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      console.log(`Spieler ${player.name} hat Lobby ${this.code} verlassen`);
      this.players.delete(playerId);
      
      if (this.players.size === 0) {
        this.stopTicking();
        return true;
      }
    }
    return false;
  }

  startTicking() {
    this.tickInterval = setInterval(() => {
      this.processTick();
    }, TICK_INTERVAL);
  }

  stopTicking() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
  }

  processTick() {
    const state = this.gameState;
    state.currentTick++;
    state.statistics.totalTicks++;

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
    this.checkGameOver();

    this.broadcastState();
  }

  calculateProduction() {
    const state = this.gameState;
    let totalProductionBonus = 1.0;

    if (state.completedResearch.includes('effizienz_1')) {
      totalProductionBonus += 0.15;
    }
    if (state.completedResearch.includes('automation')) {
      totalProductionBonus += 0.2;
    }

    let eventProductionMod = 1.0;
    if (state.activeEvent?.productionMultiplier) {
      eventProductionMod = state.activeEvent.productionMultiplier;
    }

    for (const [buildingType, count] of Object.entries(state.gebaeude)) {
      if (BUILDINGS[buildingType] && count > 0) {
        const building = BUILDINGS[buildingType];
        const production = building.production;

        for (const [resource, amount] of Object.entries(production)) {
          let finalAmount = amount * count * totalProductionBonus * eventProductionMod;

          this.players.forEach(player => {
            const role = ROLES[player.role];
            
            if (resource === 'energie' && role.bonuses.energieProduction) {
              finalAmount *= role.bonuses.energieProduction;
            }
            
            if (resource === 'nahrung' && role.bonuses.nahrungProduction) {
              finalAmount *= role.bonuses.nahrungProduction;
            }
            
            if (role.bonuses.resourceEfficiency) {
              finalAmount *= role.bonuses.resourceEfficiency;
            }

            if (resource === 'bevoelkerung' && role.bonuses.bevoelkerungEfficiency) {
              finalAmount *= role.bonuses.bevoelkerungEfficiency;
            }
          });

          if (resource === 'energie' && state.completedResearch.includes('solar_upgrade')) {
            finalAmount *= 1.25;
          }
          if (resource === 'nahrung' && state.completedResearch.includes('hydroponik')) {
            finalAmount *= 1.3;
          }

          state.ressourcen[resource] = (state.ressourcen[resource] || 0) + finalAmount;
        }

        if (buildingType === 'stabilisator' && building.stabilityBonus) {
          state.ressourcen.stabilitaet += building.stabilityBonus * count;
        }
      }
    }

    state.ressourcen.stabilitaet = Math.max(0, Math.min(100, state.ressourcen.stabilitaet));
  }

  applyMaintenance() {
    const state = this.gameState;
    let maintenanceMultiplier = 1.0;

    if (state.activeEvent?.maintenanceMultiplier) {
      maintenanceMultiplier = state.activeEvent.maintenanceMultiplier;
    }

    if (state.completedResearch.includes('hydroponik')) {
      maintenanceMultiplier *= 0.9;
    }
    if (state.completedResearch.includes('automation')) {
      maintenanceMultiplier *= 0.7;
    }

    this.players.forEach(player => {
      const role = ROLES[player.role];
      if (role.bonuses.maintenanceReduction) {
        maintenanceMultiplier *= (1 - role.bonuses.maintenanceReduction);
      }
    });

    for (const [buildingType, count] of Object.entries(state.gebaeude)) {
      const building = BUILDINGS[buildingType];
      if (building && building.maintenance && count > 0) {
        for (const [resource, cost] of Object.entries(building.maintenance)) {
          const finalCost = cost * count * maintenanceMultiplier * state.difficultyMultiplier;
          state.ressourcen[resource] = (state.ressourcen[resource] || 0) - finalCost;
        }
      }
    }
  }

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
      
      this.broadcast({
        type: 'notification',
        severity: 'critical',
        message: `${hungerTote} Menschen sind verhungert!`
      });
    }

    if (state.ressourcen.nahrung > 50 && state.ressourcen.stabilitaet > 40) {
      let growthRate = 0.02;
      
      this.players.forEach(player => {
        const role = ROLES[player.role];
        if (role.bonuses.populationGrowth) {
          growthRate *= role.bonuses.populationGrowth;
        }
      });

      const newPopulation = population + (population * growthRate);
      state.ressourcen.bevoelkerung = Math.floor(newPopulation);

      if (state.ressourcen.bevoelkerung > state.statistics.populationPeak) {
        state.statistics.populationPeak = state.ressourcen.bevoelkerung;
      }
    }
  }

  updateStability() {
    const state = this.gameState;
    
    state.ressourcen.stabilitaet -= 0.5 * state.difficultyMultiplier;

    this.players.forEach(player => {
      const role = ROLES[player.role];
      if (role.bonuses.stabilityBonus) {
        state.ressourcen.stabilitaet += role.bonuses.stabilityBonus;
      }
    });

    for (const [buildingType, count] of Object.entries(state.gebaeude)) {
      const building = BUILDINGS[buildingType];
      if (building && building.stabilityImpact) {
        state.ressourcen.stabilitaet += building.stabilityImpact * count;
      }
    }

    const housingCapacity = (state.gebaeude.wohnmodul || 0) * 5;
    const overpopulation = state.ressourcen.bevoelkerung - housingCapacity;
    if (overpopulation > 0) {
      state.ressourcen.stabilitaet -= overpopulation * 0.3;
    }

    if (state.ressourcen.energie < 20) {
      state.ressourcen.stabilitaet -= 2;
    }
    if (state.ressourcen.nahrung < 20) {
      state.ressourcen.stabilitaet -= 3;
    }

    if (state.completedResearch.includes('sozialreform')) {
      state.ressourcen.stabilitaet += 1;
    }

    state.ressourcen.stabilitaet = Math.max(0, Math.min(100, state.ressourcen.stabilitaet));
  }

  updateConstruction() {
    const state = this.gameState;
    
    state.bauWarteschlange = state.bauWarteschlange.filter(bau => {
      if (state.currentTick >= bau.fertigTick) {
        state.gebaeude[bau.typ] = (state.gebaeude[bau.typ] || 0) + 1;
        state.statistics.buildingsBuilt++;
        
        this.broadcast({
          type: 'notification',
          severity: 'success',
          message: `${BUILDINGS[bau.typ].name} wurde fertiggestellt!`
        });
        
        return false;
      }
      return true;
    });
  }

  updateResearch() {
    const state = this.gameState;
    
    if (state.activeResearch) {
      if (state.currentTick >= state.activeResearch.completionTick) {
        const researchType = state.activeResearch.type;
        state.completedResearch.push(researchType);
        
        this.broadcast({
          type: 'notification',
          severity: 'success',
          message: `Forschung "${RESEARCH[researchType].name}" abgeschlossen!`
        });
        
        state.activeResearch = null;
      }
    }
  }

  checkForEvents() {
    const state = this.gameState;
    
    if (state.activeEvent && state.activeEvent.duration > 0) {
      return;
    }

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

    if (Math.random() > trigger.chance * state.difficultyMultiplier) {
      return false;
    }

    if (trigger.minBuildings) {
      const totalBuildings = Object.values(state.gebaeude).reduce((a, b) => a + b, 0);
      if (totalBuildings < trigger.minBuildings) return false;
    }

    if (trigger.minPopulation && state.ressourcen.bevoelkerung < trigger.minPopulation) {
      return false;
    }

    if (trigger.lowFood && state.ressourcen.nahrung > 50) {
      return false;
    }

    if (trigger.lowStability && state.ressourcen.stabilitaet > 30) {
      return false;
    }

    if (trigger.minResearch && state.ressourcen.forschung < trigger.minResearch) {
      return false;
    }

    if (trigger.populationPerHousing) {
      const capacity = (state.gebaeude.wohnmodul || 1) * 5;
      const ratio = state.ressourcen.bevoelkerung / capacity;
      if (ratio < trigger.populationPerHousing) return false;
    }

    if (trigger.oldBuildings) {
      if (state.currentTick < 50) return false;
    }

    let mitigationChance = 0;
    this.players.forEach(player => {
      const role = ROLES[player.role];
      if (role.bonuses.eventMitigation) {
        mitigationChance = role.bonuses.eventMitigation;
      }
    });

    if (event.severity === 'high' || event.severity === 'critical') {
      if (Math.random() < mitigationChance) {
        return false;
      }
    }

    return true;
  }

  triggerEvent(eventKey, event) {
    const state = this.gameState;
    
    state.activeEvent = {
      key: eventKey,
      ...event,
      duration: event.duration,
      triggeredAt: state.currentTick
    };

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
        eventName: event.name
      });
    }

    this.broadcast({
      type: 'event_triggered',
      event: state.activeEvent
    });

    console.log(`Lobby ${this.code}: Event "${event.name}" ausgelöst!`);

    if (event.requiresVote) {
      this.startVote({
        type: 'event_resolution',
        eventKey: eventKey,
        question: `Wie soll auf "${event.name}" reagiert werden?`,
        options: event.voteOptions,
        timeout: 20
      });
    }
  }

  updateActiveEvent() {
    const state = this.gameState;
    
    if (state.activeEvent && state.activeEvent.duration > 0) {
      state.activeEvent.duration--;
      
      if (state.activeEvent.duration === 0) {
        this.broadcast({
          type: 'notification',
          severity: 'info',
          message: `Event "${state.activeEvent.name}" ist vorbei.`
        });
        
        state.eventHistory.push({
          name: state.activeEvent.name,
          tick: state.currentTick
        });
        
        state.activeEvent = null;
      }
    }
  }

  applyDelayedEffects() {
    const state = this.gameState;
    
    this.delayedEffects = this.delayedEffects.filter(delayed => {
      if (state.currentTick >= delayed.executeTick) {
        for (const [resource, change] of Object.entries(delayed.effects)) {
          if (resource !== 'tickDelay' && resource !== 'message') {
            state.ressourcen[resource] = (state.ressourcen[resource] || 0) + change;
          }
        }
        
        if (delayed.effects.message) {
          this.broadcast({
            type: 'notification',
            severity: 'warning',
            message: `⏰ Verzögerter Effekt: ${delayed.effects.message}`
          });
        }
        
        return false;
      }
      return true;
    });
  }

  startVote(voteData) {
    const voteId = 'vote_' + Date.now();
    const state = this.gameState;
    
    this.activeVotes.set(voteId, {
      ...voteData,
      votes: new Map(),
      startTick: state.currentTick,
      expiryTick: state.currentTick + voteData.timeout
    });

    state.statistics.votesHeld++;

    this.broadcast({
      type: 'vote_started',
      voteId: voteId,
      voteData: voteData
    });
  }

  castVote(voteId, playerId, choice) {
    const vote = this.activeVotes.get(voteId);
    if (!vote) {
      return { success: false, message: 'Abstimmung nicht gefunden' };
    }

    vote.votes.set(playerId, choice);

    if (vote.votes.size === this.players.size) {
      this.resolveVote(voteId);
    }

    return { success: true };
  }

  resolveVote(voteId) {
    const vote = this.activeVotes.get(voteId);
    if (!vote) return;

    const tally = {};
    vote.votes.forEach(choice => {
      tally[choice] = (tally[choice] || 0) + 1;
    });

    const winner = Object.keys(tally).reduce((a, b) => 
      tally[a] > tally[b] ? a : b
    );

    if (vote.type === 'event_resolution') {
      this.applyEventResolution(vote.eventKey, winner);
    }

    this.broadcast({
      type: 'vote_resolved',
      voteId: voteId,
      winner: winner,
      tally: tally
    });

    this.activeVotes.delete(voteId);
  }

  applyEventResolution(eventKey, choice) {
    const state = this.gameState;
    
    if (eventKey === 'aufstand') {
      if (choice === 'gewalt') {
        state.ressourcen.bevoelkerung -= 10;
        state.ressourcen.stabilitaet -= 20;
        this.broadcast({
          type: 'notification',
          severity: 'critical',
          message: 'Gewalt hat die Situation verschlimmert!'
        });
      } else if (choice === 'verhandlung') {
        state.ressourcen.stabilitaet += 15;
        state.ressourcen.energie -= 20;
        this.broadcast({
          type: 'notification',
          severity: 'success',
          message: 'Verhandlungen waren erfolgreich.'
        });
      } else if (choice === 'zugestaendnisse') {
        state.ressourcen.stabilitaet += 25;
        state.ressourcen.nahrung -= 40;
        this.broadcast({
          type: 'notification',
          severity: 'info',
          message: 'Zugeständnisse haben die Lage beruhigt.'
        });
      }
      
      state.activeEvent = null;
    }
  }

  updateDifficulty() {
    const state = this.gameState;
    
    const tickProgress = state.currentTick / 720;
    state.difficultyMultiplier = 1.0 + (tickProgress * 0.5);

    const totalBuildings = Object.values(state.gebaeude).reduce((a, b) => a + b, 0);
    if (totalBuildings > 30) {
      state.difficultyMultiplier += 0.2;
    }
  }

  useSpecialAction(playerId, actionData) {
    const player = this.players.get(playerId);
    if (!player) {
      return { success: false, message: 'Spieler nicht gefunden' };
    }

    const role = ROLES[player.role];
    const state = this.gameState;
    const cooldown = role.cooldown;

    const ticksSinceLastUse = state.currentTick - player.specialActionLastUsed;
    if (ticksSinceLastUse < cooldown) {
      const remaining = cooldown - ticksSinceLastUse;
      return { 
        success: false, 
        message: `Noch ${remaining} Ticks Cooldown`    };
  }

  // ================================
  // STATE BROADCAST & WS HELPERS
  // ================================
    broadcast(data)
    this.players.forEach(player => {
      if (player.ws && player.ws.readyState === player.ws.OPEN) {
        player.ws.send(JSON.stringify(data));
      }
    });

  broadcastState() {
    const stateCopy = { ...this.gameState };
    this.players.forEach(player => {
      const ws = player.ws;
      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'update_state',
          state: stateCopy,
          players: Array.from(this.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            role: p.role
          }))
        }));
      }
    });
  }
}

// ========================================
// WEBSOCKET SERVER
// ========================================
const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('Neuer Client verbunden');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (err) {
      console.error('Fehler beim Verarbeiten der Nachricht:', err);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Ungültige Nachricht'
      }));
    }
  });

  ws.on('close', () => {
    if (ws.lobbyId && lobbies.has(ws.lobbyId)) {
      const lobby = lobbies.get(ws.lobbyId);
      lobby.removePlayer(ws.playerId);
      if (lobby.players.size === 0) {
        lobbies.delete(ws.lobbyId);
      }
    }
    console.log('Client getrennt');
  });
});

// ================================
// MESSAGE HANDLER
// ================================
function handleMessage(ws, data) {
  switch(data.type) {
    case 'create_lobby':
      handleCreateLobby(ws, data);
      break;
    case 'join_lobby':
      handleJoinLobby(ws, data);
      break;
    case 'leave_lobby':
      handleLeaveLobby(ws);
      break;
    case 'special_action':
      handleSpecialAction(ws, data);
      break;
    case 'cast_vote':
      handleCastVote(ws, data);
      break;
    default:
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Unbekannter Nachrichtentyp'
      }));
  }
}

// ================================
// LOBBY HANDLER
// ================================
function handleCreateLobby(ws, data) {
  const lobbyCode = generateLobbyCode();
  const lobby = new Lobby(lobbyCode);
  lobbies.set(lobbyCode, lobby);

  ws.lobbyId = lobbyCode;
  ws.playerId = data.playerId;

  lobby.addPlayer(data.playerId, data.playerName, data.role, ws);

  ws.send(JSON.stringify({
    type: 'lobby_created',
    lobbyId: lobbyCode
  }));

  console.log(`Lobby ${lobbyCode} erstellt von Spieler ${data.playerName}`);
}

function handleJoinLobby(ws, data) {
  const lobby = lobbies.get(data.lobbyId);
  if (!lobby) {
    ws.send(JSON.stringify({ type: 'error', message: 'Lobby nicht gefunden' }));
    return;
  }

  const result = lobby.addPlayer(data.playerId, data.playerName, data.role, ws);
  if (!result.success) {
    ws.send(JSON.stringify({ type: 'error', message: result.message }));
    return;
  }

  ws.lobbyId = data.lobbyId;
  ws.playerId = data.playerId;

  ws.send(JSON.stringify({ type: 'lobby_joined', lobbyId: data.lobbyId }));
  console.log(`Spieler ${data.playerName} ist Lobby ${data.lobbyId} beigetreten`);
}

function handleLeaveLobby(ws) {
  if (!ws.lobbyId || !lobbies.has(ws.lobbyId)) return;

  const lobby = lobbies.get(ws.lobbyId);
  lobby.removePlayer(ws.playerId);

  if (lobby.players.size === 0) {
    lobbies.delete(ws.lobbyId);
  }

  ws.lobbyId = null;
  ws.playerId = null;

  ws.send(JSON.stringify({ type: 'left_lobby' }));
}

// ================================
// SPEZIALAKTION & VOTES
// ================================
function handleSpecialAction(ws, data) {
  if (!ws.lobbyId || !lobbies.has(ws.lobbyId)) return;

  const lobby = lobbies.get(ws.lobbyId);
  const result = lobby.useSpecialAction(ws.playerId, data);
  ws.send(JSON.stringify({
    type: 'special_action_result',
    success: result.success,
    message: result.message
  }));
}

function handleCastVote(ws, data) {
  if (!ws.lobbyId || !lobbies.has(ws.lobbyId)) return;

  const lobby = lobbies.get(ws.lobbyId);
  const result = lobby.castVote(data.voteId, ws.playerId, data.choice);
  ws.send(JSON.stringify({
    type: 'vote_cast',
    success: result.success,
    message: result.message
  }));
}

// ================================
// HELPER
// ================================
function generateLobbyCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ================================
// SERVER START
// ================================
server.listen(PORT, () => {
  console.log("===========================================");
  console.log("NEXUS COLONY SERVER - ERWEITERTE VERSION");
  console.log("Server läuft auf Port", PORT);
  console.log("Features: Rollen, Events, Voting, Forschung");
  console.log("===========================================");
});
