// cache-optimization.js - LRU and file-based caching optimizations
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { LRUCache } from "lru-cache";

const CACHE_DIR = "/tmp";
const DEFAULT_TTL_SECONDS = 3600; // 1 hour default for most caches
const SYSTEM_INFO_TTL_SECONDS = 30; // 30 seconds
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function initializeCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    // If directory creation fails for some unexpected reason, log but continue
    console.warn("Failed to create cache directory:", error?.message || error);
  }
}

// LRU expects TTL in milliseconds
const DEFAULT_TTL_MS = DEFAULT_TTL_SECONDS * 1000;
const lruCache = new LRUCache({
  max: 500,
  ttl: DEFAULT_TTL_MS,
  updateAgeOnGet: true,
  allowStale: false,
});

async function setInFileCache(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const filePath = join(CACHE_DIR, `${key}.json`);
  const data = {
    value,
    timestamp: Date.now(),
    ttlSeconds: Number(ttlSeconds),
  };

  try {
    await fs.writeFile(filePath, JSON.stringify(data), "utf8");
    return true;
  } catch (error) {
    console.warn(`Failed to write cache file ${filePath}:`, error?.message || error);
    return false;
  }
}

async function getFromFileCache(key) {
  const filePath = join(CACHE_DIR, `${key}.json`);
  try {
    // Quick existence check - will throw ENOENT if missing
    await fs.access(filePath);
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw);

    if (!data || typeof data.timestamp !== "number" || typeof data.ttlSeconds !== "number") {
      // Malformed: remove file and return null
      await fs.unlink(filePath).catch(() => {});
      return null;
    }

    const now = Date.now();
    if (now - data.timestamp > data.ttlSeconds * 1000) {
      // expired
      await fs.unlink(filePath).catch(() => {});
      return null;
    }

    return data.value;
  } catch (error) {
    // Missing file is normal on first run; only warn for other errors
    if (error && error.code && error.code !== "ENOENT") {
      console.warn(`Failed to read cache file ${filePath}:`, error?.message || error);
    }
    return null;
  }
}

async function deleteFromFileCache(key) {
  const filePath = join(CACHE_DIR, `${key}.json`);
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    // missing file is fine
    if (error && error.code && error.code !== "ENOENT") {
      console.warn(`Failed to delete cache file ${filePath}:`, error?.message || error);
    }
    return false;
  }
}

async function clearFileCache() {
  try {
    const files = await fs.readdir(CACHE_DIR);
    await Promise.all(files.map(async (file) => {
      if (file.endsWith(".json")) {
        const filePath = join(CACHE_DIR, file);
        await fs.unlink(filePath).catch(() => {});
      }
    }));
    return true;
  } catch (error) {
    // If cache dir doesn't exist or something else, log and continue
    console.warn("Failed to clear file cache:", error?.message || error);
    return false;
  }
}

async function cleanupOldCache() {
  try {
    const files = await fs.readdir(CACHE_DIR);
    const now = Date.now();

    await Promise.all(files.map(async (file) => {
      if (!file.endsWith(".json")) return;
      const filePath = join(CACHE_DIR, file);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const data = JSON.parse(raw);
        if (!data || typeof data.timestamp !== "number" || typeof data.ttlSeconds !== "number") {
          await fs.unlink(filePath).catch(() => {});
          return;
        }
        if (now - data.timestamp > data.ttlSeconds * 1000) {
          await fs.unlink(filePath).catch(() => {});
        }
      } catch {
        // If file unreadable or was removed between readdir and readFile, try to remove or ignore
        await fs.unlink(filePath).catch(() => {});
      }
    }));
  } catch (error) {
    // It's OK if cleanup fails occasionally
    // console.warn("cleanupOldCache error:", error?.message || error);
  }
}

setInterval(cleanupOldCache, CLEANUP_INTERVAL_MS);

// LRU helpers
function getFromLRU(key) {
  return lruCache.get(key);
}

function setInLRU(key, value, ttlMs = null) {
  const opts = (ttlMs !== null && typeof ttlMs === "number") ? { ttl: ttlMs } : undefined;
  if (opts) {
    lruCache.set(key, value, opts);
  } else {
    lruCache.set(key, value); // uses default ttl
  }
}

function deleteFromLRU(key) {
  lruCache.delete(key);
}

function clearLRU() {
  lruCache.clear();
}

function getLRUStats() {
  return { size: lruCache.size, max: lruCache.max };
}

// Higher-level cache API (ttl in seconds)
async function getFromCache(key) {
  // Try LRU first
  const fromLru = getFromLRU(key);
  if (fromLru !== undefined) return fromLru;

  // Then file
  const fromFile = await getFromFileCache(key);
  if (fromFile !== null) {
    // populate LRU with remaining TTL unknown; use default TTL for in-memory
    setInLRU(key, fromFile, DEFAULT_TTL_MS);
    return fromFile;
  }

  return null;
}

async function setInCache(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  // LRU expects ms
  setInLRU(key, value, ttlSeconds * 1000);
  await setInFileCache(key, value, ttlSeconds);
}

async function deleteFromCache(key) {
  deleteFromLRU(key);
  await deleteFromFileCache(key);
}

async function cachedQuery(queryKey, queryFunction, ttlSeconds = DEFAULT_TTL_SECONDS) {
  let result = await getFromCache(queryKey);
  if (result !== null) return result;

  try {
    result = await queryFunction();
    await setInCache(queryKey, result, ttlSeconds);
    return result;
  } catch (error) {
    console.error("Query execution error:", error?.message || error);
    throw error;
  }
}

/**
 * system_info - read /proc/meminfo -> returns structured object
 * Will be cached for SYSTEM_INFO_TTL_SECONDS and file will be created at startup.
 */
async function readSystemInfoOnce() {
  try {
    const memInfo = await fs.readFile("/proc/meminfo", "utf8");
    const object = memInfo.split("\n").reduce((acc, line) => {
      if (!line) return acc;
      const [k, v] = line.split(":");
      if (k && v) acc[k.trim()] = Number.parseInt(v.trim().replace(" kB", ""), 10);
      return acc;
    }, {});

    const ramTotal = object["MemTotal"] || 0;
    const ramAvailable = object["MemAvailable"] || 0;
    const ramFree = object["MemFree"] || 0;
    const ramBuffers = object["Buffers"] || 0;
    const ramCached = object["Cached"] || 0;
    // Use the same calculation as htop: total - available
    const ramUsed = ramTotal - ramAvailable;
    const swapTotal = object["SwapTotal"] || 0;
    const swapFree = object["SwapFree"] || 0;
    const swapUsed = swapTotal - swapFree;

    return {
      ram: {
        total: ramTotal,
        used: ramUsed,
        available: ramAvailable,
        usagePercent: ramTotal ? Math.round((ramUsed / ramTotal) * 100) : 0,
      },
      swap: {
        total: swapTotal,
        used: swapUsed,
        usagePercent: swapTotal ? Math.round((swapUsed / swapTotal) * 100) : 0,
      },
      timestamp: Date.now(),
    };
  } catch (error) {
    // If /proc/meminfo missing (non-linux), return a safe fallback
    console.warn("Could not read /proc/meminfo:", error?.message || error);
    return {
      ram: { total: 0, used: 0, available: 0, usagePercent: 0 },
      swap: { total: 0, used: 0, usagePercent: 0 },
      timestamp: Date.now(),
    };
  }
}

async function getCachedSystemInfo() {
  const cacheKey = "system_info";
  return await cachedQuery(cacheKey, readSystemInfoOnce, SYSTEM_INFO_TTL_SECONDS);
}

// Optional translation cache helpers (kept for compatibility)
async function getTranslationCache() {
  const cacheKey = "translation_cache";
  return await getFromCache(cacheKey);
}

async function setTranslationCache(cacheData) {
  const cacheKey = "translation_cache";
  const ttl = 86400; // 1 day
  await setInCache(cacheKey, cacheData, ttl);
}

// Pre-warm cache at startup: ensures /tmp/system_info.json exists
await initializeCacheDir();
try {
  // Warm system_info so the file is present after app start
  await getCachedSystemInfo();
} catch (error) {
  // Do not crash on startup; just warn
  console.warn("Failed to pre-warm system_info cache:", error?.message || error);
}

console.log(`Using file-based cache in ${CACHE_DIR}`);

export {
  lruCache,
  getFromLRU,
  setInLRU,
  deleteFromLRU,
  clearLRU,
  getLRUStats,

  getFromFileCache,
  setInFileCache,
  deleteFromFileCache,
  clearFileCache,
  getFromCache,
  setInCache,
  deleteFromCache,
  cachedQuery,
  getCachedSystemInfo,
  getTranslationCache,
  setTranslationCache,
};
