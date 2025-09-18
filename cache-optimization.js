import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { LRUCache } from "lru-cache";
import Logger from "./logger.js";

// Ensure /tmp/genfast-cache directory exists
const CACHE_DIR = "/tmp/genfast-cache";
if (!existsSync(CACHE_DIR)) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    Logger.warn("Failed to create cache directory:", error);
  }
}

// LRU Cache Configuration for frequently accessed data
const lruCache = new LRUCache({
  max: 500, // Maximum number of items in cache
  ttl: 1000 * 60 * 60, // TTL: 1 hour in milliseconds
  updateAgeOnGet: true, // Refresh TTL on access
  allowStale: false, // Don't return stale items
});

// File-based cache functions
async function writeCacheFile(key, value, ttlSeconds = 3600) {
  try {
    const filePath = join(CACHE_DIR, `${key}.json`);
    const data = {
      value,
      timestamp: Date.now(),
      ttl: ttlSeconds * 1000, // store TTL in milliseconds
    };
    await fs.writeFile(filePath, JSON.stringify(data), "utf8");
    return true;
  } catch (error) {
    Logger.warn("Failed to write cache file:", error);
    return false;
  }
}

async function readCacheFile(key) {
  try {
    const filePath = join(CACHE_DIR, `${key}.json`);
    if (!existsSync(filePath)) {
      return null;
    }

    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw);

    // Check if expired (data.ttl is milliseconds)
    if (!data.timestamp || !data.ttl || Date.now() - data.timestamp > data.ttl) {
      // Delete expired cache file
      await fs.unlink(filePath).catch(() => {});
      return null;
    }

    return data.value;
  } catch (error) {
    Logger.warn("Failed to read cache file:", error);
    return null;
  }
}

// Cleanup old cache files periodically
async function cleanupOldCache() {
  try {
    const files = await fs.readdir(CACHE_DIR);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const filePath = join(CACHE_DIR, file);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const data = JSON.parse(raw);

        // Delete if expired (data.ttl in ms)
        if (!data.timestamp || !data.ttl || now - data.timestamp > data.ttl) {
          await fs.unlink(filePath).catch(() => {});
          Logger.log(`Deleted expired cache: ${filePath}`);
        }
      } catch {
        // If parsing fails or read fails, remove corrupted file
        await fs.unlink(filePath).catch(() => {});
        Logger.warn(`Deleted corrupted cache: ${filePath}`);
      }
    }
  } catch (error) {
    Logger.warn("Failed to cleanup cache:", error);
  }
}

// Run cleanup every 30 minutes (and once at startup)
cleanupOldCache().catch(() => {});
setInterval(cleanupOldCache, 30 * 60 * 1000);

// LRU Caching Functions
function getFromLRU(key) {
  return lruCache.get(key);
}

function setInLRU(key, value, ttl = null) {
  lruCache.set(key, value, {
    ttl: ttl || 1000 * 60 * 60, // Default 1 hour (ms)
  });
}

function deleteFromLRU(key) {
  lruCache.delete(key);
}

function clearLRU() {
  lruCache.clear();
}

function getLRUStats() {
  return {
    size: lruCache.size,
    max: lruCache.max,
  };
}

// File-based Caching Functions
async function getFromFileCache(key) {
  return await readCacheFile(key);
}

async function setInFileCache(key, value, ttlSeconds = 3600) {
  try {
    return await writeCacheFile(key, value, ttlSeconds);
  } catch (error) {
    Logger.warn("Failed to write cache file:", error);
    return false;
  }
}

async function deleteFromFileCache(key) {
  try {
    const filePath = join(CACHE_DIR, `${key}.json`);
    await fs.unlink(filePath).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function clearFileCache() {
  try {
    const files = await fs.readdir(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith(".json")) {
        const filePath = join(CACHE_DIR, file);
        await fs.unlink(filePath).catch(() => {});
      }
    }
    return true;
  } catch (error) {
    Logger.warn("Failed to clear file cache:", error);
    return false;
  }
}

// Hybrid Caching: LRU + File-based
async function getFromCache(key) {
  // First check LRU cache (fastest)
  let value = getFromLRU(key);

  if (value !== undefined) {
    return value;
  }

  // If not in LRU, check file cache
  value = await getFromFileCache(key);

  if (value !== null) {
    // Promote to LRU cache for faster access next time
    setInLRU(key, value);
    return value;
  }

  return null;
}

async function setInCache(key, value, ttlSeconds = 3600) {
  // Set in both LRU and file cache for consistency
  setInLRU(key, value, ttlSeconds * 1000); // LRU TTL expects ms
  await setInFileCache(key, value, ttlSeconds); // File cache TTL in seconds
}

async function deleteFromCache(key) {
  // Delete from both caches
  deleteFromLRU(key);
  await deleteFromFileCache(key);
}

// Optimized Database Query Caching
async function cachedQuery(queryKey, queryFunction, ttl = 3600) {
  // Try to get from cache first
  let result = await getFromCache(queryKey);

  if (result !== null) {
    return result;
  }

  // If not in cache, execute the query
  try {
    result = await queryFunction();

    // Cache the result
    await setInCache(queryKey, result, ttl);

    return result;
  } catch (error) {
    Logger.error("Query execution error:", error);
    throw error;
  }
}

// System Information Caching
async function getCachedSystemInfo() {
  const cacheKey = "system_info";
  const cacheTTL = 30; // 30 seconds for system info

  return await cachedQuery(
    cacheKey,
    async () => {
      let ramTotal, ramAvailable, ramUsed, swapTotal, swapFree, swapUsed;

      try {
        // Try to read /proc/meminfo (Linux systems)
        const memInfo = await fs.readFile("/proc/meminfo", "utf8");
        const lines = memInfo.split("\n");
        const object = {};
        for (const line of lines) {
          const [k, v] = line.split(":");
          if (k && v)
            object[k.trim()] = Number.parseInt(v.trim().replace(" kB", ""), 10);
        }

        ramTotal = object["MemTotal"] || 0;
        ramAvailable = object["MemAvailable"] || 0;
        ramUsed = ramTotal - ramAvailable;
        swapTotal = object["SwapTotal"] || 0;
        swapFree = object["SwapFree"] || 0;
        swapUsed = swapTotal - swapFree;
      } catch (error) {
        // Fallback to cross-platform os module
        const totalBytes = os.totalmem();
        const freeBytes = os.freemem();
        const usedBytes = totalBytes - freeBytes;

        // Convert bytes to kilobytes to match /proc/meminfo format
        ramTotal = Math.round(totalBytes / 1024);
        ramAvailable = Math.round(freeBytes / 1024);
        ramUsed = Math.round(usedBytes / 1024);
        
        // os module doesn't provide swap info, so set to 0
        swapTotal = 0;
        swapFree = 0;
        swapUsed = 0;
      }

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
          usagePercent: swapTotal
            ? Math.round((swapUsed / swapTotal) * 100)
            : 0,
        },
        timestamp: Date.now(),
      };
    },
    cacheTTL,
  );
}

// Translation Cache Optimization
async function getTranslationCache() {
  const cacheKey = "translation_cache";
  return await getFromCache(cacheKey);
}

async function setTranslationCache(cacheData) {
  const cacheKey = "translation_cache";
  const ttl = 86400; // 24 hours for translation cache (seconds)
  await setInCache(cacheKey, cacheData, ttl);
}

// Initialize cache directory
Logger.log(`Using file-based cache in ${CACHE_DIR}`);

// Export all functions
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
