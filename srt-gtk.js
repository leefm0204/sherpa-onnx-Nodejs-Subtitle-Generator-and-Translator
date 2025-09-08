#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { URLSearchParams } from "node:url";
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from "chalk";

// --- Constants ---
const CHUNK_SZ = 1000;
const REQ_GAP = 1200;
const CACHE_F = path.join(process.cwd(), "cache.json");
const MAX_FILENAME_BYTES = 150; // Max bytes for sanitized filename

// --- Cache Management ---
async function loadCache() {
  try {
    const data = await fs.readFile(CACHE_F, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.warn(chalk.yellow(`Failed to load cache from ${CACHE_F}: ${error.message}`));
    return {};
  }
}

async function saveCache(c) {
  try {
    await fs.writeFile(CACHE_F, JSON.stringify(c, null, 2), "utf8");
  } catch (error) {
    console.error(chalk.red(`Failed to save cache to ${CACHE_F}: ${error.message}`));
  }
}

let cache = await loadCache();

// --- Utility Functions ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatTime(t) {
  const intPart = Math.floor(t);
  const ms = Math.floor((t % 1) * 1000);
  const h = Math.floor(intPart / 3600).toString().padStart(2, "0");
  const m = Math.floor((intPart % 3600) / 60).toString().padStart(2, "0");
  const s = (intPart % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s},${ms.toString().padStart(3, "0")}`;
}

class Segment {
  constructor(start, duration, text) {
    this.start = start;
    this.duration = duration;
    this.text = text;
  }
  get end() {
    return this.start + this.duration;
  }
  toString() {
    return `${formatTime(this.start)} --> ${formatTime(this.end)}
${this.text}`;
  }
}

function mergeSegments(segments, maxDuration = 15, maxPause = 0.5) {
  if (!segments.length) return [];
  const merged = [];
  let current = new Segment(
    segments[0].start,
    segments[0].duration,
    segments[0].text,
  );
  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    const pause = next.start - current.end;
    if (
      pause >= 0 &&
      current.duration + next.duration <= maxDuration &&
      pause < maxPause
    ) {
      current.duration = next.end - current.start;
      current.text += " " + next.text;
    } else {
      merged.push(current);
      current = new Segment(next.start, next.duration, next.text);
    }
  }
  merged.push(current);
  return merged;
}

function generateTk(text) {
  const b = 406_644;
  const b1 = 3_293_161_072;
  let e = [], f = 0;
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

// --- Core Translation Logic ---
async function translateText(text, targetLang, sourceLang = "auto") {
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
            resolve(translated);
          } catch (e) {
            reject(new Error(`GTX parse error: ${e.message}`));
          }
        });
      })
      .on("error", (e) => reject(new Error(`GTX request error: ${e.message}`)));
  });
}

async function gtxTranslate(text, targetLang, sourceLang = "auto") {
  const key = `${text}_${sourceLang}_${targetLang}`;
  if (cache[key]) return cache[key];

  try {
    const translated = await translateText(text, targetLang, sourceLang);
    cache[key] = translated;
    return translated;
  } catch (error) {
    console.error(chalk.red(`Translation failed for "${text}": ${error.message}`));
    throw error;
  }
}

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

// --- File Path Sanitization ---
function sanitizeFilename(name) {
  if (!name) return "file";
  let out = name.replace(/[\x00-\x1F\x7F]/g, ""); // remove null bytes and control chars
  out = out.replace(/[\\/<>:\"|?*]/g, "_"); // replace path separators and other problematic chars
  out = out.replace(/\s+/g, " ").trim(); // collapse repeated spaces
  if (out.length === 0) return "file";
  return out;
}

function truncateToBytes(filename, maxBytes = MAX_FILENAME_BYTES) {
  if (!filename) return filename;
  const extension = path.extname(filename);
  let base = path.basename(filename, extension);
  
  const extensionBytes = Buffer.byteLength(extension, 'utf8');
  const availableBaseBytes = maxBytes - extensionBytes;

  if (availableBaseBytes <= 0) {
    const fallback = `file_${Date.now()}${extension}`;
    return fallback.length > 0 ? fallback : `file${extension}`;
  }

  let byteLength = Buffer.byteLength(base, 'utf8');
  while (byteLength > availableBaseBytes) {
    base = base.slice(0, -1);
    byteLength = Buffer.byteLength(base, 'utf8');
  }
  
  if (base.length === 0 && extension.length === 0) {
    return `file`;
  } else if (base.length === 0) {
    const fallback = `file_${Date.now()}${extension}`;
    return fallback.length > 0 ? fallback : `file${extension}`;
  }

  return base + extension;
}

// --- Main Translation Process ---
async function translateFile(filePath, sourceLang, tgtLang, index, total) {
  const extension = path.extname(filePath);
  const baseName = path.basename(filePath, extension);

  const safeBaseName = truncateToBytes(sanitizeFilename(baseName), MAX_FILENAME_BYTES);
  const srtFilename = `${safeBaseName}-${tgtLang}.srt`;

  const outFile = filePath.startsWith("/tmp/")
    ? path.join("/sdcard/Download", srtFilename)
    : path.join(path.dirname(filePath), srtFilename);

  try {
    await fs.access(outFile);
    console.log(
      chalk.yellow(`(${index}/${total}) ⏭ Skipped: ${path.basename(outFile)} (already exists)`),
    );
    return { skipped: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  console.log(chalk.blue(`(${index}/${total}) 📄 Translating: ${path.basename(filePath)}`));
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
      indices.push(index_);
      index_++;
    }
    if (indices.length === 0) indices.push(index_++);

    try {
      const res = await gtxTranslate(chunk.trim(), tgtLang, sourceLang);
      const lines = res.split("\n");
      for (let k = 0; k < indices.length && k < lines.length; k++) {
        if (indices[k] !== undefined) entries[indices[k]].text = lines[k];
      }
    } catch (error) {
      console.error(chalk.red(`⚠️  ${error.message}`));
    }

    await sleep(REQ_GAP);
  }

  try {
    await fs.writeFile(outFile, buildSrt(entries), "utf8");
    await saveCache(cache);
    console.log(chalk.green(`✅ Saved: ${path.basename(outFile)}`));
  } catch (error) {
    console.error(chalk.red(`❌ Failed to write ${outFile}: ${error.message}`));
    throw error;
  }

  return { skipped: false, outPath: outFile };
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('input', {
      alias: 'i',
      type: 'string',
      description: 'Path to the SRT file or directory containing SRT files',
      demandOption: true,
    })
    .option('source', {
      alias: 's',
      type: 'string',
      description: 'Source language code (e.g., en, auto)',
      demandOption: true,
    })
    .option('target', {
      alias: 't',
      type: 'string',
      description: 'Target language code (e.g., es, fr)',
      demandOption: true,
    })
    .help()
    .alias('h', 'help')
    .parse();

  const pathArgument = argv.input;
  const sourceLang = argv.source;
  const tgtLang = argv.target;

  console.log(
    `Starting translation with path: ${pathArgument}, source: ${sourceLang}, target: ${tgtLang}`,
  );

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
      console.error(
        chalk.red("❌ Invalid path. Must be a .srt file or directory containing .srt files."),
      );
      process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red("❌ Error accessing path:"), error.message);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(chalk.yellow("❌ No .srt files found."));
    process.exit(1);
  }

  const total = files.length;
  let index = 0;
  let cancelled = false;

  const signalHandler = () => {
    cancelled = true;
    console.log("\n[INFO] Translation process cancelled by user");
    process.exit(0);
  };

  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  for (const file of files) {
    if (cancelled) {
      console.log(chalk.yellow(`[INFO] Skipping ${path.basename(file)} due to cancellation`));
      continue;
    }

    index++;
    try {
      await translateFile(file, sourceLang, tgtLang, index, total);
    } catch (error) {
      console.error(
        chalk.red(`❌ Failed to translate ${path.basename(file)}:`),
        error.message,
      );
    }

    if (cancelled) {
      console.log(chalk.yellow("[INFO] Process cancelled during file translation"));
      break;
    }
  }

  console.log(chalk.green("\n🎉 All done!"));
}

main();