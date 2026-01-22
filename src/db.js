
// src/db.js
// Redis helper for Render Key Value (uses process.env.REDIS_URL)
// CommonJS (passt zu deinem nexus_server.js mit require)

let redis = null;
let ready = false;

// Fallback (falls REDIS_URL fehlt): in-memory Map (nicht persistent!)
const mem = new Map();

async function initRedis() {
  if (ready) return;
  ready = true;

  const url = process.env.REDIS_URL;
  if (!url) return; // bleibt bei in-memory

  // npm package: redis (v4)
  const { createClient } = require("redis");

  redis = createClient({ url });

  redis.on("error", (err) => {
    console.error("Redis error:", err?.message || err);
  });

  await redis.connect();
  console.log("Redis connected");
}

// ---------- Basic KV ----------
async function get(key) {
  await initRedis();
  if (!redis) return mem.get(key) ?? null;
  return await redis.get(key);
}

async function set(key, value, ttlSeconds = null) {
  await initRedis();
  if (!redis) {
    mem.set(key, value);
    return true;
  }
  if (ttlSeconds && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    await redis.set(key, value, { EX: Math.floor(ttlSeconds) });
  } else {
    await redis.set(key, value);
  }
  return true;
}

async function del(key) {
  await initRedis();
  if (!redis) return mem.delete(key);
  await redis.del(key);
  return true;
}

// ---------- JSON helpers ----------
async function getJSON(key) {
  const raw = await get(key);
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function setJSON(key, obj, ttlSeconds = null) {
  return await set(key, JSON.stringify(obj), ttlSeconds);
}

// ---------- List helpers (für “laufende Colonies”) ----------
async function sadd(setKey, member) {
  await initRedis();
  if (!redis) {
    const s = mem.get(setKey) ?? new Set();
    s.add(member);
    mem.set(setKey, s);
    return true;
  }
  await redis.sAdd(setKey, member);
  return true;
}

async function srem(setKey, member) {
  await initRedis();
  if (!redis) {
    const s = mem.get(setKey);
    if (s instanceof Set) s.delete(member);
    return true;
  }
  await redis.sRem(setKey, member);
  return true;
}

async function smembers(setKey) {
  await initRedis();
  if (!redis) {
    const s = mem.get(setKey);
    if (s instanceof Set) return Array.from(s);
    return [];
  }
  return await redis.sMembers(setKey);
}

module.exports = {
  initRedis,
  get,
  set,
  del,
  getJSON,
  setJSON,
  sadd,
  srem,
  smembers,
};
