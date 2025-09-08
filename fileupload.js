// fileupload.js - Module for handling file uploads with original names (optimized)
// - fixes mojibake for non-ASCII filenames (decode latin1 -> utf8)
// - sanitizes filenames and truncates to safe byte length
// - saves uploaded file using the same (normalized) filename and OVERWRITES if exists
// - preserves existing stream-based saving and cleanup logic

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, "uploads");
const downloadDir = process.env.DOWNLOAD_DIR || "/sdcard/Download";

// Ensure uploads directory exists
await fs.promises.mkdir(uploadsDir, { recursive: true });

// Use disk storage for multer to reduce memory usage
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

const uploadMap = new Map();

/* ---------- Helpers: encoding, sanitize, truncate ---------- */

const fixEncoding = (name) => {
  if (!name || typeof name !== "string") return name;
  try {
    return Buffer.from(name, "latin1").toString("utf8");
  } catch {
    return name;
  }
};

const sanitizeName = (name) => {
  if (!name) return "file";
  return name
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[\/<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "file";
};

const truncateToBytes = (filename, maxBytes = 200) => {
  if (!filename) return filename;
  const extension = path.extname(filename);
  let base = path.basename(filename, extension);
  const availableBaseBytes = maxBytes - Buffer.byteLength(extension, 'utf8');

  if (availableBaseBytes <= 0) {
    return `file_${Date.now()}${extension}`;
  }

  while (Buffer.byteLength(base, 'utf8') > availableBaseBytes) {
    base = base.slice(0, -1);
  }

  return base.length ? base + extension : `file${extension}`;
};

const normalizeFilename = (originalName, maxBytes = 200) => {
  return truncateToBytes(sanitizeName(fixEncoding(originalName || "")), maxBytes);
};

/* ---------- Saving logic: keep same filename (overwrite if exists) ---------- */

async function renameSrtToOriginal(srtPath) {
  const safeSrtFilename = normalizeFilename(path.basename(srtPath), 200);
  const targetPath = path.join(downloadDir, safeSrtFilename);

  try {
    await fs.promises.rename(srtPath, targetPath);
    console.info(`Moved SRT to Downloads: ${safeSrtFilename}`);
    return { success: true, finalPath: targetPath, finalName: safeSrtFilename };
  } catch (error) {
    console.warn(`Failed to move SRT ${srtPath}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/* ---------- Cleanup helpers for explicit cleanup ---------- */

async function cleanupUploadedFiles(filePaths) {
  // Convert Set to Array if needed
  let filePathsArray = filePaths;
  if (filePaths && !(filePaths instanceof Array)) {
    if (filePaths instanceof Set) {
      filePathsArray = Array.from(filePaths);
    } else {
      filePathsArray = [filePaths];
    }
  }

  if (!filePathsArray || filePathsArray.length === 0) {
    const uploadedFiles = await fs.promises.readdir(uploadsDir);
    await Promise.all(uploadedFiles.map(async (file) => {
      const filePath = path.join(uploadsDir, file);
      try {
        await fs.promises.unlink(filePath);
        console.info(`Cleaned up uploaded file: ${file}`);
      } catch (error) {
        console.warn(`Failed to clean up ${file}: ${error.message}`);
      }
    }));
    uploadMap.clear();
    console.info("All uploaded files cleaned up");
    return;
  }

  await Promise.all(filePathsArray.map(async (filePath) => {
    if (filePath && filePath.startsWith(uploadsDir)) {
      try {
        await fs.promises.unlink(filePath);
        console.info(`Cleaned up uploaded file: ${path.basename(filePath)}`);
        uploadMap.delete(path.basename(filePath, path.extname(filePath)));
      } catch (error) {
        console.warn(`Failed to clean up ${filePath}: ${error.message}`);
      }
    }
  }));
}

/* ---------- Multer middleware wrapper: use normalized filename and save to disk ---------- */

async function processUploadedFile(file) {
  const safeName = normalizeFilename(file.originalname, 200);
  const newPath = path.join(uploadsDir, safeName);

  if (file.path !== newPath) {
    await fs.promises.rename(file.path, newPath);
  }

  const processedFile = {
    ...file,
    path: newPath,
    filename: safeName,
    destination: uploadsDir,
    originalname: fixEncoding(file.originalname),
  };

  const uploadedBase = path.basename(processedFile.filename, path.extname(processedFile.filename));
  const originalBase = path.basename(processedFile.originalname || processedFile.filename, path.extname(processedFile.originalname));

  uploadMap.set(uploadedBase, { uploadedPath: processedFile.path, uploadedFilename: processedFile.filename, originalName: processedFile.originalname });
  if (originalBase !== uploadedBase) uploadMap.set(originalBase, { uploadedPath: processedFile.path, uploadedFilename: processedFile.filename, originalName: processedFile.originalname });

  console.info(`Tracked uploaded file: ${processedFile.filename} (original: ${processedFile.originalname})`);
  return processedFile;
}

function uploadSingleFile(fieldName = "file") {
  return (request, res, next) => {
    upload.single(fieldName)(request, res, async (error) => {
      if (error) {
        console.error("Upload middleware error:", error);
        return next(error);
      }

      if (request.file && request.file.path) {
        try {
          request.file = await processUploadedFile(request.file);
        } catch (processingError) {
          return next(processingError);
        }
      }
      next();
    });
  };
}

/* ---------- Exports ---------- */

export {
  uploadSingleFile,
  cleanupUploadedFiles,
  renameSrtToOriginal,
  uploadMap,
  uploadsDir,
  downloadDir,
};
