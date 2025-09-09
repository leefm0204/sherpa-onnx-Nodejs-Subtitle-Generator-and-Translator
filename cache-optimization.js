// cache-optimization.js - LRU and file-based caching optimizations
import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { LRUCache } from "lru-cache";

// Ensure /tmp/genfast-cache directory exists
const CACHE_DIR = "/tmp/genfast-cache";
if (!existsSync(CACHE_DIR)) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    console.warn("Failed to create cache directory:", error.message);
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
async function writeCacheFile(key, value) {
  try {
    const filePath = join(CACHE_DIR, `${key}.json`);
    const data = {
      value,
      timestamp: Date.now(),
      ttl: 3600000, // 1 hour default TTL
    };
    await fs.writeFile(filePath, JSON.stringify(data), "utf8");
    return true;
  } catch (error) {
    console.warn("Failed to write cache file:", error.message);
    return false;
  }
}

async function readCacheFile(key) {
  try {
    const filePath = join(CACHE_DIR, `${key}.json`);
    if (!existsSync(filePath)) {
      return null;
    }

    const data = JSON.parse(await fs.readFile(filePath, "utf8"));

    // Check if expired
    if (Date.now() - data.timestamp > data.ttl) {
      // Delete expired cache file
      await fs.unlink(filePath).catch(() => {});
      return null;
    }

    return data.value;
  } catch (error) {
    console.warn("Failed to read cache file:", error.message);
    return null;
  }
}

// Cleanup old cache files periodically
async function cleanupOldCache() {
  try {
    const files = await fs.readdir(CACHE_DIR);
    const now = Date.now();

    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          const filePath = join(CACHE_DIR, file);
          const data = JSON.parse(await fs.readFile(filePath, "utf8"));

          // Delete if expired
          if (now - data.timestamp > data.ttl) {
            await fs.unlink(filePath);
          }
        } catch (error) {
          // Delete corrupted files
          const filePath = join(CACHE_DIR, file);
          await fs.unlink(filePath).catch(() => {});
        }
      }
    }
  } catch (error) {
    console.warn("Failed to cleanup cache:", error.message);
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupOldCache, 30 * 60 * 1000);

// LRU Caching Functions
function getFromLRU(key) {
  return lruCache.get(key);
}

function setInLRU(key, value, ttl = null) {
  lruCache.set(key, value, {
    ttl: ttl || 1000 * 60 * 60, // Default 1 hour
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

async function setInFileCache(key, value, ttl = 3600) {
  try {
    const filePath = join(CACHE_DIR, `${key}.json`);
    const data = {
      value,
      timestamp: Date.now(),
      ttl: ttl * 1000, // Convert to milliseconds
    };
    await fs.writeFile(filePath, JSON.stringify(data), "utf8");
    return true;
  } catch (error) {
    console.warn("Failed to write cache file:", error.message);
    return false;
  }
}

async function deleteFromFileCache(key) {
  try {
    const filePath = join(CACHE_DIR, `${key}.json`);
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

async function clearFileCache() {
  try {
    const files = await fs.readdir(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith(".json")) {
        const filePath = join(CACHE_DIR, file);
        await fs.unlink(filePath);
      }
    }
    return true;
  } catch (error) {
    console.warn("Failed to clear file cache:", error.message);
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

async function setInCache(key, value, ttl = 3600) {
  // Set in both LRU and file cache for consistency
  setInLRU(key, value, ttl * 1000); // LRU TTL is in milliseconds
  await setInFileCache(key, value, ttl); // File cache TTL is in seconds
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
    console.error("Query execution error:", error.message);
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
      // This would typically be a database query or expensive operation
      // For now, we'll simulate system info retrieval
      const memInfo = await fs.readFile("/proc/meminfo", "utf8");
      const lines = memInfo.split("\n");
      const object = {};
      for (const line of lines) {
        const [k, v] = line.split(":");
        if (k && v)
          object[k.trim()] = Number.parseInt(v.trim().replace(" kB", ""), 10);
      }

      const ramTotal = object["MemTotal"] || 0;
      const ramAvailable = object["MemAvailable"] || 0;
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
  const ttl = 86400; // 24 hours for translation cache
  await setInCache(cacheKey, cacheData, ttl);
}

// Initialize cache directory
console.log(`Using file-based cache in ${CACHE_DIR}`);

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
