#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { URLSearchParams } from "node:url";
import Logger from "./logger.js";

const CHUNK_SZ = 1000;
const REQ_GAP = 1200;
const CACHE_F = path.join(process.cwd(), "cache.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadCache() {
  try {
    const data = await fs.readFile(CACHE_F, "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveCache(c) {
  await fs.writeFile(CACHE_F, JSON.stringify(c, null, 2), "utf8");
}

let cache = await loadCache();

async function parseSrt(file) {
  const content = await fs.readFile(file, "utf8");
  const blocks = content.split(/\r?\n\r?\n/);
  return blocks.map((b) => {
    const [index, time, ...textLines] = b.split(/\r?\n/);
    return { idx: index, time, text: textLines.join("\n") };
  });
}

function buildSrt(entries) {
  return (
    entries.map((e) => `${e.idx}\n${e.time}\n${e.text}`).join("\n\n") + "\n"
  );
}

function generateTk(text) {
  const b = 406_644;
  const b1 = 3_293_161_072;
  let e = [],
    f = 0;
  for (let g = 0; g < text.length; g++) {
    let l = text.charCodeAt(g);
    if (l < 128) e[f++] = l;
    else {
      if (l < 2048) e[f++] = (l >> 6) | 192;
      else {
        if (
          (l & 0xfc00) === 0xd800 &&
          g + 1 < text.length &&
          (text.charCodeAt(g + 1) & 0xfc00) === 0xdc00
        ) {
          l = 0x10000 + (((l & 0x3ff) << 10) | (text.charCodeAt(++g) & 0x3ff));
          e[f++] = (l >> 18) | 240;
          e[f++] = ((l >> 12) & 63) | 128;
        } else e[f++] = (l >> 12) | 224;
        e[f++] = ((l >> 6) & 63) | 128;
      }
      e[f++] = (l & 63) | 128;
    }
  }
  let a = b;
  for (f = 0; f < e.length; f++) {
    a += e[f];
    a = (a + b1) >>> 0;
  }
  return (a >>> 0).toString();
}

async function gtxTranslate(text, targetLang, sourceLang = "auto") {
  const key = `${text}_${sourceLang}_${targetLang}`;
  if (cache[key]) return cache[key];

  const tk = generateTk(text);
  const parameters = new URLSearchParams({
    client: "gtx",
    sl: sourceLang,
    tl: targetLang,
    hl: targetLang,
    dt: "t",
    ie: "UTF-8",
    oe: "UTF-8",
    q: text,
    tk,
  });

  const url = `https://translate.googleapis.com/translate_a/single?${parameters.toString()}`;
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            const translated = json[0].map((x) => x[0]).join("");
            cache[key] = translated;
            resolve(translated);
          } catch {
            reject("GTX parse error");
          }
        });
      })
      .on("error", reject);
  });
}

async function translateFile(filePath, sourceLang, tgtLang, index, total) {
  const extension = path.extname(filePath);
  const baseName = path.basename(filePath, extension);

  // Save translated SRT files directly to /sdcard/Download directory
  // Sanitize and truncate filename to prevent issues with long filenames or special characters
  let safeBaseName = baseName.replace(/[\x00-\x1f"*<>?|]/g, "_"); // Replace problematic ASCII characters
  // Remove null bytes and control chars separately
  safeBaseName = safeBaseName.replace(/[\x00-\x1f]/g, "");
  // Truncate to a safe length while preserving Unicode characters
  if (Buffer.byteLength(safeBaseName, "utf8") > 150) {
    // Gradually trim the string to fit within the byte limit
    while (
      Buffer.byteLength(safeBaseName, "utf8") > 150 &&
      safeBaseName.length > 0
    ) {
      safeBaseName = safeBaseName.slice(0, -1);
    }
  }
  const srtFilename = `${safeBaseName}-${tgtLang}.srt`;

  // Determine output path based on input path
  // If input path is in /tmp (uploaded file), save to /sdcard/Download
  // Otherwise, save in the same directory as the input file
  const outFile = filePath.startsWith("/tmp/")
    ? path.join("/sdcard/Download", srtFilename)
    : path.join(path.dirname(filePath), srtFilename);

  try {
    await fs.access(outFile);
    Logger.processComplete("TRANSLATE", `${path.basename(outFile)} (already exists)`, `(${index}/${total}) Skipped`);
    return { skipped: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  Logger.processStart("TRANSLATE", `${path.basename(filePath)}`, `(${index}/${total}) Translating`);
  const entries = await parseSrt(filePath);
  let index_ = 0;
  while (index_ < entries.length) {
    let chunk = "";
    const indices = [];
    while (
      index_ < entries.length &&
      (chunk + entries[index_].text).length <= CHUNK_SZ
    ) {
      chunk += entries[index_].text + "\n";
      indices.push(index_++);
    }
    if (indices.length === 0) indices.push(index_++);

    try {
      const res = await gtxTranslate(chunk.trim(), tgtLang, sourceLang);
      const lines = res.split("\n");
      for (let k = 0; k < indices.length && k < lines.length; k++) {
        if (indices[k] !== undefined) entries[indices[k]].text = lines[k];
      }
    } catch (error) {
      Logger.error('TRANSLATE', `⚠️  ${error}`);
    }

    await sleep(REQ_GAP);
  }

  try {
    await fs.writeFile(outFile, buildSrt(entries), "utf8");
    await saveCache(cache);
    Logger.success('TRANSLATE', `✅ Saved: ${path.basename(outFile)}`);
  } catch (error) {
    Logger.error('TRANSLATE', `❌ Failed to write ${outFile}:`, error.message);
    throw error;
  }

  return { skipped: false, outPath: outFile };
}
async function main() {
  const [, , pathArgument, sourceLang, tgtLang] = process.argv;

  Logger.log('TRANSLATE', `Starting translation with path: ${pathArgument}, source: ${sourceLang}, target: ${tgtLang}`);

  if (!pathArgument || !sourceLang || !tgtLang) {
    Logger.error('TRANSLATE', "❌ Usage: node srt-gtk.js /path/to/file/or/folder sourceLang targetLang");
    process.exit(1);
  }

  let files = [];
  try {
    const stats = await fs.stat(pathArgument);
    if (stats.isDirectory()) {
      files = (await fs.readdir(pathArgument))
        .filter((f) => f.toLowerCase().endsWith(".srt"))
        .map((f) => path.join(pathArgument, f));
    } else if (stats.isFile() && pathArgument.toLowerCase().endsWith(".srt")) {
      files = [pathArgument];
    } else {
      Logger.error('TRANSLATE', "❌ Invalid path. Must be a .srt file or directory containing .srt files.");
      process.exit(1);
    }
  } catch (error) {
    Logger.error('TRANSLATE', "❌ Error accessing path:", error.message);
    process.exit(1);
  }

  if (files.length === 0) {
    Logger.error('TRANSLATE', "❌ No .srt files found.");
    process.exit(1);
  }

  const total = files.length;
  let index = 0;
  let cancelled = false;

  // Handle cancellation signals
  const signalHandler = (signal) => {
    cancelled = true;
    Logger.log('TRANSLATE', `[INFO] Translation process cancelled by ${signal}`);
    // Exit immediately
    process.exit(0);
  };

  process.on("SIGINT", () => signalHandler('SIGINT'));
  process.on("SIGTERM", () => signalHandler('SIGTERM'));

  for (const file of files) {
    // Check if cancelled before processing each file
    if (cancelled) {
      Logger.log('TRANSLATE', `[INFO] Skipping ${path.basename(file)} due to cancellation`);
      continue;
    }

    index++;
    try {
      await translateFile(file, sourceLang, tgtLang, index, total);
    } catch (error) {
      Logger.error('TRANSLATE', `❌ Failed to translate ${path.basename(file)}:`, error.message);
    }

    // If cancelled during processing, exit
    if (cancelled) {
      Logger.log('TRANSLATE', "[INFO] Process cancelled during file translation");
      break;
    }
  }

  Logger.success('TRANSLATE', "\n🎉 All done!");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
