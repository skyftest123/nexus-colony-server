// src/tick.js
// Dedicated ticker for lobbies. Keeps tick logic inside Lobby.processTick().
// Goal: stabilize performance + avoid overlapping ticks.

class LobbyTicker {
  constructor(lobby, intervalMs) {
    this.lobby = lobby;
    this.intervalMs = intervalMs;
    this.timer = null;

    this._running = false;
    this._lastTickAt = 0;
  }

  start() {
    if (this.timer) return;

    this.timer = setInterval(async () => {
      // Prevent overlapping ticks (lag fix if a tick takes too long)
      if (this._running) return;
      this._running = true;

      try {
        this._lastTickAt = Date.now();
        // Your Lobby must implement processTick()
        this.lobby.processTick();
      } finally {
        this._running = false;
      }
    }, this.intervalMs);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  isRunning() {
    return !!this.timer;
  }

  lastTickAt() {
    return this._lastTickAt;
  }
}

module.exports = {
  LobbyTicker,
};
