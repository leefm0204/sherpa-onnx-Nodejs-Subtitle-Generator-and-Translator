// fileupload.js - Module for handling file uploads with original names (revised)
// - fixes mojibake for non-ASCII filenames (decode latin1 -> utf8)
// - sanitizes filenames and truncates to safe byte length
// - saves uploaded file using the same (normalized) filename and OVERWRITES if exists
// - preserves existing stream-based saving and cleanup logic

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import multer from "multer";
import Logger from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, "uploads");
const downloadDir = process.env.DOWNLOAD_DIR || "/sdcard/Download";

// ensure uploads dir exists
(async () => {
  try {
    await fs.promises.mkdir(uploadsDir, { recursive: true });
  } catch (error) {
    Logger.error('UPLOAD', 'Failed to create uploads directory', error);
  }
})();

// Use disk storage for multer to reduce memory usage
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: function (req, file, cb) {
    // We'll override this in the middleware, but provide a fallback
    cb(null, file.originalname);
  },
});
const upload = multer({ storage });

/**
 * Map original base name (without ext) => uploaded info
 * e.g. "myfile" => { uploadedPath: "/.../uploads/myfile.mp4", uploadedFilename: "myfile.mp4", originalName: "原始名.mp4" }
 */
const uploadMap = new Map();

/* ---------- Helpers: encoding, sanitize, truncate ---------- */

/**
 * Convert multer originalname from latin1 -> utf8 to fix mojibake for non-ascii filenames.
 * Many browsers send UTF-8 but multer sometimes returns latin1 bytes in originalname.
 */
function fixEncoding(name) {
  if (!name || typeof name !== "string") return name;
  try {
    return Buffer.from(name, "latin1").toString("utf8");
  } catch {
    return name;
  }
}

/**
 * Very small sanitize function: removes path separators, control chars, and trims.
 * Keeps Unicode chars but removes problematic characters.
 */
function sanitizeName(name) {
  if (!name) return "file";
  // remove null bytes and control chars
  let out = name.replace(/[\x00-\x1F\x7F]/g, "");
  // replace path separators and other problematic chars
  out = out.replace(/[\/<>:"|?*]/g, "_");
  // collapse repeated spaces
  out = out.replace(/\s+/g, " ").trim();
  if (out.length === 0) return "file";
  return out;
}

/**
 * Truncate filename to ensure UTF-8 byte length <= maxBytes.
 * Keeps the extension intact.
 */
function truncateToBytes(filename, maxBytes = 200) {
  if (!filename) return filename;
  const extension = path.extname(filename);
  let base = path.basename(filename, extension);
  let candidate = base + extension;
  // quick accept
  if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
  // gradually trim base
  // remove characters from the end until it fits
  while (base.length > 0) {
    base = base.slice(0, -1);
    candidate = base + extension;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
  }
  // fallback: use a short hashed-ish name (timestamp)
  const fallback = `file_${Date.now()}${extension}`;
  return fallback.length > 0 ? fallback : `file${extension}`;
}

/**
 * Full normalization pipeline for an uploaded filename.
 * - fix encoding
 * - sanitize
 * - truncate to safe byte length
 */
function normalizeFilename(originalName, maxBytes = 200) {
  const fixed = fixEncoding(originalName || "");
  const sanitized = sanitizeName(fixed);
  return truncateToBytes(sanitized, maxBytes);
}

/* ---------- Saving logic: keep same filename (overwrite if exists) ---------- */

/**
 * Save file buffer to uploadsDir using provided filename.
 * Overwrites existing file with the same name (as requested).
 * Returns { path, filename }.
 */
// This function is no longer used since we're using disk storage directly
// async function saveFileWithStream(buffer, filename) {
//   const finalPath = path.join(uploadsDir, filename);
//
//   // If file exists, remove it first so we overwrite cleanly.
//   try {
//     await fs.promises.access(finalPath);
//     // file exists — remove it to overwrite
//     try {
//       await fs.promises.unlink(finalPath);
//       // proceed to write new file
//     } catch (error) {
//       // If we can't unlink, still attempt to write (may fail)
//       Logger.warn(`Could not unlink existing file ${finalPath}: ${error.message}`);
//     }
//   } catch {
//     // does not exist — fine
//   }
//
//   return new Promise((resolve, reject) => {
//     const writeStream = fs.createWriteStream(finalPath, { flags: 'w' });
//     const readStream = Readable.from(buffer);
//     readStream.pipe(writeStream);
//     writeStream.on('finish', () => {
//       Logger.log(`File saved (overwrite mode): ${filename}`);
//       resolve({ path: finalPath, filename });
//     });
//     writeStream.on('error', (error) => {
//       Logger.error(`Error saving file ${filename}:`, error);
//       reject(error);
//     });
//   });
// }

/* ---------- SRT rename/move: keep behavior but ensure safe filenames ---------- */

/**
 * Move SRT to downloadDir, prefer using same name (but sanitized/truncated for safety).
 * If target exists, it will be overwritten (like uploads) to preserve "same filename" behavior.
 */
async function renameSrtToOriginal(srtPath) {
  const srtFilenameRaw = path.basename(srtPath);
  // sanitize/truncate the srt filename too (to avoid too-long names in Download)
  const safeSrtFilename = normalizeFilename(srtFilenameRaw, 200);
  const targetPath = path.join(downloadDir, safeSrtFilename);

  try {
    // Try rename (fast) then fallback to streaming copy if rename fails across devices.
    // fs.promises.rename will overwrite the destination file if it already exists.
    try {
      await fs.promises.rename(srtPath, targetPath);
    } catch {
      // fallback copy+unlink
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(srtPath);
        const ws = fs.createWriteStream(targetPath);
        rs.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
        rs.on("error", reject);
      });
      try {
        await fs.promises.unlink(srtPath);
      } catch {
        /* ignore */
      }
    }

    Logger.log('SRT', `Moved SRT to Downloads: ${safeSrtFilename}`);
    return { success: true, finalPath: targetPath, finalName: safeSrtFilename };
  } catch (error) {
    Logger.warn('SRT', `Failed to move SRT ${srtPath}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/* ---------- Uploaded-file deletion helpers ---------- */

async function deleteUploadedFile(base) {
  const info = uploadMap.get(base);
  if (!info) {
    Logger.log('UPLOAD', `No upload mapping found for base: ${base}`);
    return false;
  }

  try {
    await fs.promises.unlink(info.uploadedPath);
    Logger.log('UPLOAD', `Deleted uploaded file: ${info.uploadedFilename}`);
    uploadMap.delete(base);
    // delete any other keys pointing to the same info (originalBase/uploadedBase)
    if (info.originalBase && info.originalBase !== base)
      uploadMap.delete(info.originalBase);
    if (info.uploadedBase && info.uploadedBase !== base)
      uploadMap.delete(info.uploadedBase);
    return true;
  } catch (error) {
    Logger.warn('UPLOAD', `Failed to delete uploaded file ${info.uploadedPath}: ${error.message}`);
    // still remove mapping to avoid leaking it
    uploadMap.delete(base);
    if (info.originalBase) uploadMap.delete(info.originalBase);
    if (info.uploadedBase) uploadMap.delete(info.uploadedBase);
    return false;
  }
}

async function deleteUploadedFileByMatch(srtBase) {
  // Fallback: iterate through the map to find a match if direct lookup fails.
  for (const [key, info] of uploadMap.entries()) {
    if (info.uploadedBase === srtBase || info.originalBase === srtBase) {
      Logger.log('UPLOAD', `Found matching file in map for SRT base: ${srtBase}`);
      return await deleteUploadedFile(key); // Use the key to delete
    }
  }
  Logger.log('UPLOAD', `No matching uploaded file found in map for SRT base: ${srtBase}`);
  return false;
}

/* ---------- Combined cleanup ---------- */

async function cleanupAfterSrt(srtPath) {
  const renameResult = await renameSrtToOriginal(srtPath);
  if (!renameResult.success) {
    Logger.error('SRT', `Failed to move/rename SRT: ${renameResult.error}`);
    return;
  }

  const srtBase = path.basename(renameResult.finalName, ".srt");
  const deletedFromMap = await deleteUploadedFile(srtBase);
  if (!deletedFromMap) {
    await deleteUploadedFileByMatch(srtBase);
  }

  Logger.log('SRT', `Cleanup completed for SRT: ${renameResult.finalName}`);
}

/* ---------- Cleanup helpers for explicit cleanup ---------- */

async function cleanupUploadedFiles(filePaths) {
  if (!filePaths) {
    try {
      const uploadedFiles = await fs.promises.readdir(uploadsDir);
      for (const file of uploadedFiles) {
        const filePath = path.join(uploadsDir, file);
        try {
          await fs.promises.unlink(filePath);
          Logger.log('UPLOAD', `Cleaned up uploaded file: ${file}`);
        } catch (error) {
          Logger.warn('UPLOAD', `Failed to clean up ${file}: ${error.message}`);
        }
      }
      uploadMap.clear();
      Logger.log('UPLOAD', "All uploaded files cleaned up");
    } catch (error) {
      Logger.warn('UPLOAD', "Error during cleanup", error);
    }
    return;
  }

  for (const filePath of filePaths) {
    try {
      if (filePath.startsWith(uploadsDir)) {
        await fs.promises.unlink(filePath);
        Logger.log('UPLOAD', `Cleaned up uploaded file: ${path.basename(filePath)}`);
        const fileName = path.basename(filePath);
        const extension = path.extname(fileName);
        const base = path.basename(fileName, extension);
        uploadMap.delete(base);
      }
    } catch (error) {
      Logger.warn('UPLOAD', `Failed to clean up ${filePath}: ${error.message}`);
    }
  }
}

/* ---------- Multer middleware wrapper: use normalized filename and save to disk ---------- */

function uploadSingleFile(fieldName = "file") {
  return (request, res, next) => {
    const middleware = upload.single(fieldName);
    middleware(request, res, async (error) => {
      if (error) {
        Logger.error('UPLOAD', 'Upload middleware error', error);
        return next(error);
      }

      // For disk storage, the file is already saved, but we need to rename it to our normalized name
      if (request.file && request.file.path) {
        try {
          // Normalize original filename (fix encoding, sanitize, truncate)
          const safeName = normalizeFilename(request.file.originalname, 200);

          // Rename the file to our normalized name
          const newPath = path.join(uploadsDir, safeName);

          // Only rename if the paths are different
          if (request.file.path !== newPath) {
            // Rename the temporary file to our normalized name. This will overwrite if the file exists.
            await fs.promises.rename(request.file.path, newPath);
          }

          // Update req.file to match our normalized format
          request.file = {
            ...request.file,
            path: newPath,
            filename: safeName,
            destination: uploadsDir,
            originalname: fixEncoding(request.file.originalname), // keep coherent original name (decoded)
          };

          // Track uploaded file in map using base derived from saved filename
          const extension = path.extname(request.file.filename);
          const uploadedBase = path.basename(request.file.filename, extension);
          const originalBase = path.basename(
            request.file.originalname || request.file.filename,
            extension,
          );

          const info = {
            uploadedPath: request.file.path,
            uploadedFilename: request.file.filename,
            originalName: request.file.originalname, // This is already fixed
            originalBase,
            uploadedBase,
            uploadedAt: Date.now(),
          };

          // Store under both keys for robust lookup
          uploadMap.set(uploadedBase, info);
          if (originalBase !== uploadedBase) uploadMap.set(originalBase, info);

          Logger.log('UPLOAD', `Tracked uploaded file: ${request.file.filename} (original: ${request.file.originalname}, uploadedBase=${uploadedBase}, originalBase=${originalBase})`);
        } catch (error) {
          Logger.error('UPLOAD', 'Error saving uploaded file', error);
          return next(error);
        }
      }

      next();
    });
  };
}

/* ---------- Watcher: detect new .srt files in Downloads ---------- */
// Disabled since SRT files are now saved directly to /sdcard/Download
// function startDownloadWatcher() {
//   try {
//     const watcher = chokidar.watch(downloadDir, { ignored: /^\./, persistent: true, depth: 0 });
//
//     watcher.on('add', async (filePath) => {
//       const file = path.basename(filePath);
//       if (!file.toLowerCase().endsWith('.srt')) return;
//       Logger.log(`Detected new .srt: ${file}`);
//       await cleanupAfterSrt(filePath);
//     });
//
//     watcher.on('error', (error) => {
//       Logger.error('Watcher error:', error);
//     });
//
//     Logger.log(`Watching ${downloadDir} for new .srt files...`);
//   } catch (error) {
//     Logger.error('Failed to start watcher — check permissions and that path exists:', error);
//   }
// }
// startDownloadWatcher();

/* ---------- Garbage Collection ---------- */

/**
 * Perform garbage collection on the uploadMap to remove stale entries
 * and call explicit garbage collection if available
 */
function performGC() {
  try {
    // Trigger Node.js garbage collection if available
    if (global.gc) {
      global.gc();
    }
  } catch (error) {
    Logger.warn('GC', 'Failed to perform garbage collection', error);
  }
}

/**
 * Cleanup old/stale entries in the uploadMap that haven't been accessed in a while
 * This helps prevent memory leaks over time
 */
function cleanupStaleUploads(maxAgeMs = 30 * 60 * 1000) { // 30 minutes default
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [key, info] of uploadMap.entries()) {
    // Remove entries that are older than maxAgeMs
    if (info.uploadedAt && (now - info.uploadedAt > maxAgeMs)) {
      uploadMap.delete(key);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    Logger.log('UPLOAD', `Cleaned up ${cleanedCount} stale upload entries from map`);
  }
  
  // Perform garbage collection after cleanup
  performGC();
}

/**
 * Periodic cleanup function to remove stale uploads
 * Runs every 10 minutes by default
 */
function startPeriodicCleanup(intervalMs = 10 * 60 * 1000) {
  setInterval(() => {
    cleanupStaleUploads();
  }, intervalMs);
  
  Logger.log('UPLOAD', 'Started periodic upload cleanup task');
}
        
/* ---------- Exports ---------- */

export {
  uploadSingleFile,
  cleanupUploadedFiles,
  cleanupAfterSrt,
  deleteUploadedFile,
  deleteUploadedFileByMatch,
  renameSrtToOriginal,
  uploadMap,
  uploadsDir,
  downloadDir,
  performGC,
  cleanupStaleUploads,
  startPeriodicCleanup,
};
