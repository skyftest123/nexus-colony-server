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
// DESIGN-ENTSCHEIDUNG: ROLLEN-SYSTEM
// Jede Rolle hat einzigartige Stärken und Schwächen.
// Dies erzwingt Teamwork und verhindert, dass ein Spieler
// alleine optimal spielen kann. Rollen ergänzen sich.
// ========================================

const ROLES = {
  engineer: {
    name: 'Ingenieur',
    description: 'Spezialist für Gebäude und Energie',
    bonuses: {
      buildCostReduction: 0.15, // 15% weniger Baukosten
      energieProduction: 1.2, // 20% mehr Energieproduktion
      maintenanceReduction: 0.25 // 25% weniger Wartungskosten
    },
    specialAction: 'repair', // Kann Gebäude sofort reparieren
    cooldown: 10 // Ticks zwischen Spezialaktionen
  },
  researcher: {
    name: 'Forscher',
    description: 'Entwickelt Technologien und Effizienz',
    bonuses: {
      researchSpeed: 2.0, // Doppelte Forschungsgeschwindigkeit
      eventMitigation: 0.3, // 30% weniger schwere Ereignisse
      bevoelkerungEfficiency: 1.15 // Bevölkerung produziert mehr
    },
    specialAction: 'research', // Kann Forschung starten
    cooldown: 15
  },
  logistician: {
    name: 'Logistiker',
    description: 'Optimiert Ressourcen und Produktion',
    bonuses: {
      resourceEfficiency: 1.25, // 25% mehr aus allen Produktionen
      storageBonus: 1.5, // 50% mehr Lagerkapazität
      nahrungProduction: 1.3 // 30% mehr Nahrungsproduktion
    },
    specialAction: 'optimize', // Optimiert Produktion temporär
    cooldown: 12
  },
  diplomat: {
    name: 'Diplomat',
    description: 'Verwaltet Bevölkerung und Stabilität',
    bonuses: {
      stabilityBonus: 0.2, // +20 Stabilität pro Tick
      populationGrowth: 1.4, // 40% schnelleres Wachstum
      crisisResolution: 0.4 // 40% bessere Krisenauflösung
    },
    specialAction: 'negotiate', // Beendet Krisen früher
    cooldown: 8
  }
};

// ========================================
// DESIGN-ENTSCHEIDUNG: GEBÄUDE-KOMPLEXITÄT
// Gebäude haben nun Wartungskosten, die mit der Anzahl skalieren.
// Dies verhindert exponentielles Wachstum und erzeugt strategische
// Entscheidungen: Qualität vs. Quantität.
// ========================================

const BUILDINGS = {
  generator: {
    name: 'Generator',
    cost: { energie: 0, nahrung: 50 },
    production: { energie: 10 },
    maintenance: { energie: 0, nahrung: 2 }, // Pro Tick
    buildTime: 3,
    maxCount: 20, // Limitiert um Snowballing zu vermeiden
    stabilityImpact: -1 // Mehr Generatoren = mehr Instabilität
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
    stabilityImpact: -2 // Überbevölkerung = Unruhe
  },
  forschungslabor: {
    name: 'Forschungslabor',
    cost: { energie: 80, nahrung: 40 },
    production: { forschung: 2 },
    maintenance: { energie: 5, nahrung: 2 },
    buildTime: 8,
    maxCount: 5,
    stabilityImpact: 1 // Forschung erhöht Moral
  },
  stabilisator: {
    name: 'Stabilisator',
    cost: { energie: 60, nahrung: 50 },
    production: {}, // Produziert nichts
    maintenance: { energie: 3, nahrung: 2 },
    buildTime: 6,
    maxCount: 8,
    stabilityImpact: 5, // Hauptzweck: Stabilität erhöhen
    stabilityBonus: 3 // Zusätzlicher Bonus pro Tick
  }
};

// ========================================
// DESIGN-ENTSCHEIDUNG: EREIGNIS-SYSTEM
// Ereignisse erzeugen Variabilität und Herausforderungen.
// Sie reagieren auf den Spielzustand und zwingen zu Anpassungen.
// Zeitverzögerte Effekte bedeuten: schlechte Entscheidungen
// zeigen ihre Konsequenzen erst später.
// ========================================

const EVENTS = {
  stromausfall: {
    name: 'Stromausfall',
    description: 'Ein Generator ist ausgefallen!',
    severity: 'medium',
    trigger: { minBuildings: 5, chance: 0.15 }, // 15% Chance ab 5 Gebäuden
    effects: {
      immediate: { energie: -50 },
      delayed: { // Nach 3 Ticks
        tickDelay: 3,
        stabilität: -15,
        message: 'Die Nachwirkungen des Stromausfalls belasten die Kolonie'
      }
    },
    duration: 2, // Ticks
    requiresVote: false
  },
  hungersnot: {
    name: 'Hungersnot',
    description: 'Ernteausfälle bedrohen die Nahrungsversorgung!',
    severity: 'high',
    trigger: { minPopulation: 50, lowFood: true, chance: 0.12 },
    effects: {
      immediate: { nahrung: -80, stabilität: -20 },
      delayed: {
        tickDelay: 5,
        bevoelkerung: -10,
        message: 'Mangelernährung fordert Opfer in der Bevölkerung'
      }
    },
    duration: 4,
    requiresVote: false,
    canBeMitigated: true // Diplomat kann helfen
  },
  aufstand: {
    name: 'Aufstand',
    description: 'Die Bevölkerung rebelliert gegen die Führung!',
    severity: 'critical',
    trigger: { minPopulation: 40, lowStability: true, chance: 0.2 },
    effects: {
      immediate: { stabilität: -30, bevoelkerung: -5 },
      delayed: {
        tickDelay: 2,
        energie: -30,
        nahrung: -30,
        message: 'Der Aufstand hat Infrastruktur beschädigt'
      }
    },
    duration: 3,
    requiresVote: true, // Team muss Lösung abstimmen
    voteOptions: ['gewalt', 'verhandlung', 'zugestaendnisse']
  },
  technologiedurchbruch: {
    name: 'Technologiedurchbruch',
    description: 'Forscher haben eine wichtige Entdeckung gemacht!',
    severity: 'positive',
    trigger: { minResearch: 50, chance: 0.18 },
    effects: {
      immediate: { forschung: 20, stabilität: 10 }
    },
    duration: 1,
    requiresVote: false
  },
  uebervoelkerung: {
    name: 'Übervölkerung',
    description: 'Zu viele Menschen, zu wenig Raum!',
    severity: 'high',
    trigger: { populationPerHousing: 8, chance: 0.25 }, // Über 8 pro Wohnmodul
    effects: {
      immediate: { stabilität: -25 },
      delayed: {
        tickDelay: 4,
        nahrung: -40,
        energie: -20,
        stabilität: -15,
        message: 'Überbelegung führt zu Ressourcenproblemen'
      }
    },
    duration: 3,
    requiresVote: false,
    preventBuilding: 'wohnmodul' // Verhindert Wohnmodul-Bau während Ereignis
  },
  maschinenverschleiss: {
    name: 'Maschinenverschleiß',
    description: 'Alte Anlagen benötigen dringend Wartung!',
    severity: 'medium',
    trigger: { oldBuildings: true, chance: 0.2 },
    effects: {
      immediate: {},
      maintenanceMultiplier: 2.0, // Doppelte Wartungskosten während Event
      productionMultiplier: 0.7 // 30% weniger Produktion
    },
    duration: 5,
    requiresVote: false,
    canBeMitigated: true // Ingenieur kann reparieren
  }
};

// ========================================
// DESIGN-ENTSCHEIDUNG: FORSCHUNGEN
// Forschungen bieten permanente Upgrades, sind aber teuer
// und benötigen Zeit. Dies erzeugt langfristige Ziele.
// ========================================

const RESEARCH = {
  effizienz_1: {
    name: 'Effizienztechnologie I',
    cost: 50,
    time: 10, // Ticks
    effect: { productionBonus: 0.15 }, // 15% mehr Produktion global
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
// LOBBY KLASSE - ERWEITERT
// ========================================

class Lobby {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.maxPlayers = 4;
    this.gameState = this.createInitialState();
    this.lastTick = Date.now();
    this.tickInterval = null;
    this.activeVotes = new Map(); // voteId -> voteData
    this.delayedEffects = []; // Für zeitverzögerte Ereigniseffekte
    this.startTicking();
  }

  createInitialState() {
    return {
      ressourcen: {
        energie: 150,
        nahrung: 150,
        bevoelkerung: 15,
        forschung: 0,
        stabilität: 100 // Neue Ressource: 0-100, beeinflusst alles
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
      activeEvent: null, // Aktuelles Ereignis
      eventHistory: [], // Vergangene Ereignisse
      completedResearch: [], // Abgeschlossene Forschungen
      activeResearch: null, // { type, startTick, completionTick }
      roleActions: {}, // playerId -> { lastAction: tick }
      difficultyMultiplier: 1.0, // Steigt mit Fortschritt
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
      return false;
    }

    // DESIGN: Keine doppelten Rollen (erzwingt Vielfalt)
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
      specialActionLastUsed: -999 // Tick der letzten Spezialverwendung
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

  // ========================================
  // HAUPTSPIEL-LOOP - Hier passiert die Magie
  // ========================================

  processTick() {
    const state = this.gameState;
    state.currentTick++;
    state.statistics.totalTicks++;

    // PHASE 1: Verzögerte Effekte anwenden
    this.applyDelayedEffects();

    // PHASE 2: Ressourcen-Produktion (mit Boni und Wartung)
    this.calculateProduction();

    // PHASE 3: Wartungskosten abziehen
    this.applyMaintenance();

    // PHASE 4: Bevölkerungs-Dynamik
    this.updatePopulation();

    // PHASE 5: Stabilität berechnen
    this.updateStability();

    // PHASE 6: Baufortschritt
    this.updateConstruction();

    // PHASE 7: Forschungsfortschritt
    this.updateResearch();

    // PHASE 8: Ereignis-System
    this.checkForEvents();

    // PHASE 9: Event-Dauer updaten
    this.updateActiveEvent();

    // PHASE 10: Schwierigkeit skalieren (je länger gespielt, desto härter)
    this.updateDifficulty();

    // PHASE 11: Spielende-Bedingungen prüfen
    this.checkGameOver();

    // State an alle Spieler senden
    this.broadcastState();
  }

  // ========================================
  // PRODUKTION MIT ROLLEN-BONI
  // ========================================

  calculateProduction() {
    const state = this.gameState;
    let totalProductionBonus = 1.0;

    // Forschungs-Boni anwenden
    if (state.completedResearch.includes('effizienz_1')) {
      totalProductionBonus += 0.15;
    }
    if (state.completedResearch.includes('automation')) {
      totalProductionBonus += 0.2;
    }

    // Event-Modifikatoren (z.B. Maschinenverschleiß)
    let eventProductionMod = 1.0;
    if (state.activeEvent?.productionMultiplier) {
      eventProductionMod = state.activeEvent.productionMultiplier;
    }

    // Gebäude-Produktion berechnen
    for (const [buildingType, count] of Object.entries(state.gebaeude)) {
      if (BUILDINGS[buildingType] && count > 0) {
        const building = BUILDINGS[buildingType];
        const production = building.production;

        for (const [resource, amount] of Object.entries(production)) {
          let finalAmount = amount * count * totalProductionBonus * eventProductionMod;

          // Rollen-spezifische Boni
          this.players.forEach(player => {
            const role = ROLES[player.role];
            
            // Ingenieur: +20% Energie
            if (resource === 'energie' && role.bonuses.energieProduction) {
              finalAmount *= role.bonuses.energieProduction;
            }
            
            // Logistiker: +30% Nahrung
            if (resource === 'nahrung' && role.bonuses.nahrungProduction) {
              finalAmount *= role.bonuses.nahrungProduction;
            }
            
            // Logistiker: +25% alle Ressourcen
            if (role.bonuses.resourceEfficiency) {
              finalAmount *= role.bonuses.resourceEfficiency;
            }

            // Forscher: Bevölkerung effizienter
            if (resource === 'bevoelkerung' && role.bonuses.bevoelkerungEfficiency) {
              finalAmount *= role.bonuses.bevoelkerungEfficiency;
            }
          });

          // Forschungs-spezifische Boni
          if (resource === 'energie' && state.completedResearch.includes('solar_upgrade')) {
            finalAmount *= 1.25;
          }
          if (resource === 'nahrung' && state.completedResearch.includes('hydroponik')) {
            finalAmount *= 1.3;
          }

          state.ressourcen[resource] = (state.ressourcen[resource] || 0) + finalAmount;
        }

        // Stabilisator Bonus
        if (buildingType === 'stabilisator' && building.stabilityBonus) {
          state.ressourcen.stabilität += building.stabilityBonus * count;
        }
      }
    }

    // Stabilität begrenzen
    state.ressourcen.stabilität = Math.max(0, Math.min(100, state.ressourcen.stabilität));
  }

  // ========================================
  // WARTUNGS-SYSTEM
  // DESIGN: Wartung skaliert mit Anzahl und verhindert
  // unkontrolliertes Wachstum. Spieler müssen Balance finden.
  // ========================================

  applyMaintenance() {
    const state = this.gameState;
    let maintenanceMultiplier = 1.0;

    // Event-Modifikator
    if (state.activeEvent?.maintenanceMultiplier) {
      maintenanceMultiplier = state.activeEvent.maintenanceMultiplier;
    }

    // Forschungs-Reduktion
    if (state.completedResearch.includes('hydroponik')) {
      maintenanceMultiplier *= 0.9;
    }
    if (state.completedResearch.includes('automation')) {
      maintenanceMultiplier *= 0.7;
    }

    // Ingenieur-Bonus
    this.players.forEach(player => {
      const role = ROLES[player.role];
      if (role.bonuses.maintenanceReduction) {
        maintenanceMultiplier *= (1 - role.bonuses.maintenanceReduction);
      }
    });

    // Wartungskosten anwenden
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

  // ========================================
  // BEVÖLKERUNGS-DYNAMIK
  // DESIGN: Bevölkerung verbraucht Nahrung und erzeugt
  // Stabilität-Probleme bei Mangel oder Überbevölkerung.
  // ========================================

  updatePopulation() {
    const state = this.gameState;
    const population = state.ressourcen.bevoelkerung;

    // Nahrungsverbrauch: 0.5 pro Person
    const nahrungsVerbrauch = population * 0.5 * state.difficultyMultiplier;
    state.ressourcen.nahrung -= nahrungsVerbrauch;

    // KRITISCH: Verhungern
    if (state.ressourcen.nahrung < 0) {
      state.ressourcen.nahrung = 0;
      const hungerTote = Math.floor(population * 0.05); // 5% sterben
      state.ressourcen.bevoelkerung = Math.max(5, population - hungerTote);
      state.ressourcen.stabilität -= 15;
      
      this.broadcast({
        type: 'notification',
        severity: 'critical',
        message: `${hungerTote} Menschen sind verhungert!`
      });
    }

    // Langsames Bevölkerungswachstum (wenn genug Ressourcen)
    if (state.ressourcen.nahrung > 50 && state.ressourcen.stabilität > 40) {
      let growthRate = 0.02; // 2% pro Tick
      
      // Diplomat erhöht Wachstum
      this.players.forEach(player => {
        const role = ROLES[player.role];
        if (role.bonuses.populationGrowth) {
          growthRate *= role.bonuses.populationGrowth;
        }
      });

      const newPopulation = population + (population * growthRate);
      state.ressourcen.bevoelkerung = Math.floor(newPopulation);

      // Statistik Update
      if (state.ressourcen.bevoelkerung > state.statistics.populationPeak) {
        state.statistics.populationPeak = state.ressourcen.bevoelkerung;
      }
    }
  }

  // ========================================
  // STABILITÄTS-BERECHNUNG
  // DESIGN: Zentrale Metrik die alles beeinflusst.
  // Niedrige Stabilität = höhere Wahrscheinlichkeit für Krisen.
  // ========================================

  updateStability() {
    const state = this.gameState;
    
    // Basis-Degradation: Stabilität sinkt immer leicht
    state.ressourcen.stabilität -= 0.5 * state.difficultyMultiplier;

    // Diplomat-Bonus
    this.players.forEach(player => {
      const role = ROLES[player.role];
      if (role.bonuses.stabilityBonus) {
        state.ressourcen.stabilität += role.bonuses.stabilityBonus;
      }
    });

    // Gebäude-Einfluss
    for (const [buildingType, count] of Object.entries(state.gebaeude)) {
      const building = BUILDINGS[buildingType];
      if (building && building.stabilityImpact) {
        state.ressourcen.stabilität += building.stabilityImpact * count;
      }
    }

    // Übervölkerung bestraft Stabilität
    const housingCapacity = (state.gebaeude.wohnmodul || 0) * 5;
    const overpopulation = state.ressourcen.bevoelkerung - housingCapacity;
    if (overpopulation > 0) {
      state.ressourcen.stabilität -= overpopulation * 0.3;
    }

    // Ressourcenmangel
    if (state.ressourcen.energie < 20) {
      state.ressourcen.stabilität -= 2;
    }
    if (state.ressourcen.nahrung < 20) {
      state.ressourcen.stabilität -= 3;
    }

    // Forschungs-Bonus
    if (state.completedResearch.includes('sozialreform')) {
      state.ressourcen.stabilität += 1;
    }

    // Begrenzen
    state.ressourcen.stabilität = Math.max(0, Math.min(100, state.ressourcen.stabilität));
  }

  // ========================================
  // BAU-FORTSCHRITT
  // ========================================

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

  // ========================================
  // FORSCHUNGS-FORTSCHRITT
  // ========================================

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

  // ========================================
  // EREIGNIS-SYSTEM
  // DESIGN: Ereignisse halten das Spiel dynamisch und
  // reagieren auf Spieler-Entscheidungen.
  // ========================================

  checkForEvents() {
    const state = this.gameState;
    
    // Kein Event während ein anderes läuft
    if (state.activeEvent && state.activeEvent.duration > 0) {
      return;
    }

    // Event-Check mit Wahrscheinlichkeiten
    for (const [eventKey, event] of Object.entries(EVENTS)) {
      if (this.shouldTriggerEvent(event)) {
        this.triggerEvent(eventKey, event);
        break; // Nur ein Event pro Tick
      }
    }
  }

  shouldTriggerEvent(event) {
    const state = this.gameState;
    const trigger = event.trigger;

    // Basis-Wahrscheinlichkeit
    if (Math.random() > trigger.chance * state.difficultyMultiplier) {
      return false;
    }

    // Spezifische Bedingungen
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

    if (trigger.lowStability && state.ressourcen.stabilität > 30) {
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
      // Simuliert "alte" Gebäude nach vielen Ticks
      if (state.currentTick < 50) return false;
    }

    // Forscher-Bonus: Weniger schlimme Events
    let mitigationChance = 0;
    this.players.forEach(player => {
      const role = ROLES[player.role];
      if (role.bonuses.eventMitigation) {
        mitigationChance = role.bonuses.eventMitigation;
      }
    });

    if (event.severity === 'high' || event.severity === 'critical') {
      if (Math.random() < mitigationChance) {
        return false; // Event wird verhindert
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

    // Sofortige Effekte anwenden
    if (event.effects.immediate) {
      for (const [resource, change] of Object.entries(event.effects.immediate)) {
        state.ressourcen[resource] = (state.ressourcen[resource] || 0) + change;
      }
    }

    // Verzögerte Effekte registrieren
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

    // Voting starten wenn nötig
    if (event.requiresVote) {
      this.startVote({
        type: 'event_resolution',
        eventKey: eventKey,
        question: `Wie soll auf "${event.name}" reagiert werden?`,
        options: event.voteOptions,
        timeout: 20 // Ticks
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
        // Effekte anwenden
        for (const [resource, change] of Object.entries(delayed.effects)) {
          if (resource !== 'tickDelay' && resource !== 'message') {
            state.ressourcen[resource] = (state.ressourcen[resource] || 0) + change;
          }
        }
        
        // Nachricht senden
        if (delayed.effects.message) {
          this.broadcast({
            type: 'notification',
            severity: 'warning',
            message: `⏰ Verzögerter Effekt: ${delayed.effects.message}`
          });
        }
        
        return false; // Entfernen
      }
      return true;
    });
  }

  // ========================================
  // ABSTIMMUNGS-SYSTEM
  // DESIGN: Erzwingt Teamwork und Kommunikation.
  // Wichtige Entscheidungen müssen gemeinsam getroffen werden.
  // ========================================

  startVote(voteData) {
    const voteId = 'vote_' + Date.now();
    const state = this.gameState;
    
    this.activeVotes.set(voteId, {
      ...voteData,
      votes: new Map(), // playerId -> choice
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

    // Prüfen ob alle abgestimmt haben
    if (vote.votes.size === this.players.size) {
      this.resolveVote(voteId);
    }

    return { success: true };
  }

  resolveVote(voteId) {
    const vote = this.activeVotes.get(voteId);
    if (!vote) return;

    // Stimmen zählen
    const tally = {};
    vote.votes.forEach(choice => {
      tally[choice] = (tally[choice] || 0) + 1;
    });

    // Gewinner ermitteln
    const winner = Object.keys(tally).reduce((a, b) => 
      tally[a] > tally[b] ? a : b
    );

    // Ergebnis anwenden
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
    
    // Event-spezifische Auflösungen
    if (eventKey === 'aufstand') {
      if (choice === 'gewalt') {
        state.ressourcen.bevoelkerung -= 10;
        state.ressourcen.stabilität -= 20;
        this.broadcast({
          type: 'notification',
          severity: 'critical',
          message: 'Gewalt hat die Situation verschlimmert!'
        });
      } else if (choice === 'verhandlung') {
        state.ressourcen.stabilität += 15;
        state.ressourcen.energie -= 20;
        this.broadcast({
          type: 'notification',
          severity: 'success',
          message: 'Verhandlungen waren erfolgreich.'
        });
      } else if (choice === 'zugestaendnisse') {
        state.ressourcen.stabilität += 25;
        state.ressourcen.nahrung -= 40;
        this.broadcast({
          type: 'notification',
          severity: 'info',
          message: 'Zugeständnisse haben die Lage beruhigt.'
        });
      }
      
      // Event beenden
      state.activeEvent = null;
    }
  }

  // ========================================
  // SCHWIERIGKEIT SKALIEREN
  // DESIGN: Je länger gespielt wird, desto herausfordernder.
  // Verhindert "idle = gewinnen" Gameplay.
  // ========================================

  updateDifficulty() {
    const state = this.gameState;
    
    // Schwierigkeit steigt langsam über Zeit
    const tickProgress = state.currentTick / 720; // 720 Ticks = 1 Stunde
    state.difficultyMultiplier = 1.0 + (tickProgress * 0.5); // Max 1.5x nach 1 Stunde

    // Zusätzlich: Skalierung mit Fortschritt
    const totalBuildings = Object.values(state.gebaeude).reduce((a, b) => a + b, 0);
    if (totalBuildings > 30) {
      state.difficultyMultiplier += 0.2;
    }
  }

  // ========================================
  // SPEZIAL-AKTIONEN DER ROLLEN
  // DESIGN: Jede Rolle kann das Team in kritischen Momenten retten.
  // Cooldowns verhindern Spam.
  // ========================================

  useSpecialAction(playerId, actionData) {
    const player = this.players.get(playerId);
    if (!player) {
      return { success: false, message: 'Spieler nicht gefunden' };
    }

    const role = ROLES[player.role];
    const state = this.gameState;
    const cooldown = role.cooldown;

    // Cooldown prüfen
    const ticksSinceLastUse = state.currentTick - player.specialActionLastUsed;
    if (ticksSinceLastUse < cooldown) {
      const remaining = cooldown - ticksSinceLastUse;
      return { 
        success: false, 
        message: `Noch ${remaining} Ticks Cooldown` 
      };
    }

    let result = { success: false };

    switch (role.specialAction) {
      case 'repair':
        // Ingenieur: Repariert Gebäude, beendet Maschinenverschleiß
        if (state.activeEvent?.key === 'maschinenverschleiss') {
          state.activeEvent.duration = 0;
          result = { 
            success: true, 
            message: 'Maschinen wurden repariert!' 
          };
        } else {
          // Allgemein: Reduziert Wartungskosten temporär
          state.ressourcen.energie += 50;
          result = { 
            success: true, 
            message: 'Notfall-Reparaturen durchgeführt' 
          };
        }
        break;

      case 'research':
        // Forscher: Startet schnelle Forschung oder beendet Event
        if (!state.activeResearch && actionData.researchType) {
          const research = RESEARCH[actionData.researchType];
          if (research) {
            state.activeResearch = {
              type: actionData.researchType,
              startTick: state.currentTick,
              completionTick: state.currentTick + Math.ceil(research.time / 2)
            };
            result = { 
              success: true, 
              message: `Schnell-Forschung "${research.name}" gestartet!` 
            };
          }
        }
        break;

      case 'optimize':
        // Logistiker: Verdoppelt Produktion für 5 Ticks
        this.applyTemporaryBoost('production', 2.0, 5);
        result = { 
          success: true, 
          message: 'Produktion optimiert für 5 Ticks!' 
        };
        break;

      case 'negotiate':
        // Diplomat: Beendet Krise oder erhöht Stabilität massiv
        if (state.activeEvent) {
          const mitigation = role.bonuses.crisisResolution;
          state.activeEvent.duration = Math.floor(state.activeEvent.duration * (1 - mitigation));
          state.ressourcen.stabilität += 20;
          result = { 
            success: true, 
            message: 'Krise erfolgreich entschärft!' 
          };
        } else {
          state.ressourcen.stabilität += 30;
          result = { 
            success: true, 
            message: 'Diplomatie hat die Moral gestärkt!' 
          };
        }
        break;
    }

    if (result.success) {
      player.specialActionLastUsed = state.currentTick;
      player.actionsUsed++;
      this.broadcastState();
    }

    return result;
  }

  applyTemporaryBoost(boostType, multiplier, duration) {
    // Implementierung für temporäre Boosts
    // (würde in echtem System über delayed effects laufen)
    this.broadcast({
      type: 'notification',
      severity: 'info',
      message: `Temporärer Boost aktiv: ${boostType} x${multiplier} für ${duration} Ticks`
    });
  }

  // ========================================
  // GEBÄUDE BAUEN (mit Rollen-Boni)
  // ========================================

  buildBuilding(buildingType, playerId) {
    const building = BUILDINGS[buildingType];
    if (!building) {
      return { success: false, message: 'Unbekanntes Gebäude' };
    }

    const state = this.gameState;
    const player = this.players.get(playerId);

    // Event-Beschränkungen
    if (state.activeEvent?.preventBuilding === buildingType) {
      return { 
        success: false, 
        message: `Kann ${building.name} während "${state.activeEvent.name}" nicht bauen` 
      };
    }

    // Maximum erreicht?
    if (state.gebaeude[buildingType] >= building.maxCount) {
      return { 
        success: false, 
        message: `Maximum von ${building.maxCount} ${building.name} erreicht` 
      };
    }

    // Kosten berechnen (mit Rollen-Boni)
    let costMultiplier = 1.0;
    if (player) {
      const role = ROLES[player.role];
      if (role.bonuses.buildCostReduction) {
        costMultiplier = 1 - role.bonuses.buildCostReduction;
      }
    }

    // Kosten prüfen
    for (const [resource, cost] of Object.entries(building.cost)) {
      const finalCost = Math.ceil(cost * costMultiplier);
      if ((state.ressourcen[resource] || 0) < finalCost) {
        return { success: false, message: 'Nicht genug Ressourcen' };
      }
    }

    // Kosten abziehen
    for (const [resource, cost] of Object.entries(building.cost)) {
      const finalCost = Math.ceil(cost * costMultiplier);
      state.ressourcen[resource] -= finalCost;
    }

    // Zur Bau-Warteschlange
    state.bauWarteschlange.push({
      typ: buildingType,
      fertigTick: state.currentTick + building.buildTime,
      startedBy: playerId
    });

    this.broadcastState();
    return { success: true, message: `${building.name} wird gebaut` };
  }

  // ========================================
  // FORSCHUNG STARTEN
  // ========================================

  startResearch(researchType, playerId) {
    const research = RESEARCH[researchType];
    if (!research) {
      return { success: false, message: 'Unbekannte Forschung' };
    }

    const state = this.gameState;

    // Bereits erforscht?
    if (state.completedResearch.includes(researchType)) {
      return { success: false, message: 'Bereits erforscht' };
    }

    // Schon eine Forschung aktiv?
    if (state.activeResearch) {
      return { success: false, message: 'Forschung bereits aktiv' };
    }

    // Voraussetzungen prüfen
    for (const req of research.requires) {
      if (!state.completedResearch.includes(req)) {
        return { 
          success: false, 
          message: `Benötigt: ${RESEARCH[req].name}` 
        };
      }
    }

    // Kosten prüfen
    if (state.ressourcen.forschung < research.cost) {
      return { success: false, message: 'Nicht genug Forschungspunkte' };
    }

    // Kosten abziehen
    state.ressourcen.forschung -= research.cost;

    // Zeit berechnen (Forscher-Bonus)
    let researchTime = research.time;
    const player = this.players.get(playerId);
    if (player) {
      const role = ROLES[player.role];
      if (role.bonuses.researchSpeed) {
        researchTime = Math.ceil(researchTime / role.bonuses.researchSpeed);
      }
    }

    state.activeResearch = {
      type: researchType,
      startTick: state.currentTick,
      completionTick: state.currentTick + researchTime
    };

    this.broadcastState();
    return { 
      success: true, 
      message: `Forschung "${research.name}" gestartet (${researchTime} Ticks)` 
    };
  }

  // ========================================
  // GAME OVER BEDINGUNGEN
  // ========================================

  checkGameOver() {
    const state = this.gameState;

    // Verloren: Bevölkerung zu niedrig
    if (state.ressourcen.bevoelkerung < 5) {
      this.broadcast({
        type: 'game_over',
        reason: 'Zu wenig Bevölkerung',
        success: false
      });
      this.stopTicking();
      return;
    }

    // Verloren: Stabilität dauerhaft zu niedrig
    if (state.ressourcen.stabilität < 5 && state.currentTick > 20) {
      this.broadcast({
        type: 'game_over',
        reason: 'Vollständiger Zusammenbruch der Ordnung',
        success: false
      });
      this.stopTicking();
      return;
    }

    // Gewonnen: Alle Forschungen + stabile Kolonie
    const allResearch = Object.keys(RESEARCH);
    const hasAllResearch = allResearch.every(r => 
      state.completedResearch.includes(r)
    );
    
    if (hasAllResearch && 
        state.ressourcen.bevoelkerung > 100 && 
        state.ressourcen.stabilität > 70) {
      this.broadcast({
        type: 'game_over',
        reason: 'Kolonie floriert!',
        success: true,
        statistics: state.statistics
      });
      this.stopTicking();
    }
  }

  // ========================================
  // BROADCASTING
  // ========================================

  broadcastState() {
    const message = JSON.stringify({
      type: 'state_update',
      state: this.gameState,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        actionsUsed: p.actionsUsed
      })),
      activeVotes: Array.from(this.activeVotes.entries()).map(([id, vote]) => ({
        id,
        ...vote,
        votes: undefined // Verstecke individuelle Stimmen
      }))
    });

    this.players.forEach(player => {
      if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(message);
      }
    });
  }

  broadcast(message, excludeId = null) {
    const msgStr = JSON.stringify(message);
    this.players.forEach(player => {
      if (player.id !== excludeId && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(msgStr);
      }
    });
  }
}

// ========================================
// HTTP SERVER
// ========================================

const server = http.createServer((req, res) => {
  let filePath = '.' + req.url;
  if (filePath === './') {
    filePath = './index.html';
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
  };

  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 - Datei nicht gefunden</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end('Server Error: ' + error.code);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// ========================================
// WEBSOCKET SERVER
// ========================================

const wss = new WebSocket.Server({ server });

function generateLobbyCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

wss.on('connection', (ws) => {
  let playerId = null;
  let currentLobbyCode = null;

  console.log('Neuer Client verbunden');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'create_lobby':
          handleCreateLobby(data);
          break;
        
        case 'join_lobby':
          handleJoinLobby(data);
          break;
        
        case 'build':
          handleBuild(data);
          break;

        case 'start_research':
          handleStartResearch(data);
          break;

        case 'special_action':
          handleSpecialAction(data);
          break;

        case 'cast_vote':
          handleCastVote(data);
          break;
        
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    } catch (error) {
      console.error('Fehler beim Verarbeiten der Nachricht:', error);
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Ungültige Nachricht' 
      }));
    }
  });

  ws.on('close', () => {
    console.log('Client getrennt');
    if (currentLobbyCode && playerId) {
      const lobby = lobbies.get(currentLobbyCode);
      if (lobby) {
        const shouldDelete = lobby.removePlayer(playerId);
        lobby.broadcast({
          type: 'player_left',
          playerId: playerId
        });
        
        if (shouldDelete) {
          lobbies.delete(currentLobbyCode);
          console.log(`Lobby ${currentLobbyCode} wurde geschlossen`);
        }
      }
    }
  });

  // ========================================
  // MESSAGE HANDLER
  // ========================================

  function handleCreateLobby(data) {
    const lobbyCode = generateLobbyCode();
    const lobby = new Lobby(lobbyCode);
    lobbies.set(lobbyCode, lobby);

    playerId = Date.now().toString() + Math.random().toString(36).substring(2);
    currentLobbyCode = lobbyCode;

    const result = lobby.addPlayer(playerId, data.playerName || 'Spieler', data.role || 'engineer', ws);

    if (result.success) {
      ws.send(JSON.stringify({
        type: 'lobby_created',
        lobbyCode: lobbyCode,
        playerId: playerId
      }));

      lobby.broadcastState();
      console.log(`Lobby ${lobbyCode} erstellt`);
    } else {
      ws.send(JSON.stringify({
        type: 'error',
        message: result.message
      }));
    }
  }

  function handleJoinLobby(data) {
    const lobby = lobbies.get(data.lobbyCode);
    
    if (!lobby) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Lobby nicht gefunden'
      }));
      return;
    }

    playerId = Date.now().toString() + Math.random().toString(36).substring(2);
    currentLobbyCode = data.lobbyCode;

    const result = lobby.addPlayer(playerId, data.playerName || 'Spieler', data.role || 'engineer', ws);

    if (result.success) {
      ws.send(JSON.stringify({
        type: 'lobby_joined',
        lobbyCode: data.lobbyCode,
        playerId: playerId
      }));

      lobby.broadcast({
        type: 'player_joined',
        playerName: data.playerName || 'Spieler',
        role: data.role
      }, playerId);

      lobby.broadcastState();
    } else {
      ws.send(JSON.stringify({
        type: 'error',
        message: result.message
      }));
    }
  }

  function handleBuild(data) {
    if (!currentLobbyCode || !playerId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Nicht in einer Lobby'
      }));
      return;
    }

    const lobby = lobbies.get(currentLobbyCode);
    if (!lobby) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Lobby nicht gefunden'
      }));
      return;
    }

    const result = lobby.buildBuilding(data.buildingType, playerId);
    ws.send(JSON.stringify({
      type: 'build_result',
      ...result
    }));
  }

  function handleStartResearch(data) {
    if (!currentLobbyCode || !playerId) return;

    const lobby = lobbies.get(currentLobbyCode);
    if (!lobby) return;

    const result = lobby.startResearch(data.researchType, playerId);
    ws.send(JSON.stringify({
      type: 'research_result',
      ...result
    }));
  }

  function handleSpecialAction(data) {
    if (!currentLobbyCode || !playerId) return;

    const lobby = lobbies.get(currentLobbyCode);
    if (!lobby) return;

    const result = lobby.useSpecialAction(playerId, data);
    ws.send(JSON.stringify({
      type: 'special_action_result',
      ...result
    }));
  }

  function handleCastVote(data) {
    if (!currentLobbyCode || !playerId) return;

    const lobby = lobbies.get(currentLobbyCode);
    if (!lobby) return;

    const result = lobby.castVote(data.voteId, playerId, data.choice);
    ws.send(JSON.stringify({
      type: 'vote_cast_result',
      ...result
    }));
  }
});

// ========================================
// SERVER START
// ========================================

server.listen(PORT, () => {
  console.log('===========================================');
  console.log('NEXUS COLONY SERVER - ERWEITERTE VERSION');
  console.log(`Server läuft auf Port ${PORT}`);
  console.log('Features: Rollen, Events, Voting, Forschung');
  console.log('===========================================');
});

process.on('SIGINT', () => {
  console.log('\nServer wird heruntergefahren...');
  lobbies.forEach(lobby => lobby.stopTicking());
  wss.close(() => {
    server.close(() => {
      console.log('Server beendet');
      process.exit(0);
    });
  });
});