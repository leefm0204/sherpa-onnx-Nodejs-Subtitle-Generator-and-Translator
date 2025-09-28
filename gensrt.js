#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import Logger from "./logger.js";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import sherpa_onnx from "sherpa-onnx-node";
import cliProgress from "cli-progress";
import { getModel } from "./modelConfig.js";
import os from "os";

const ffmpegPath = ffmpegInstaller.path;
const ffprobePath = ffprobeInstaller.path;

// Track active processes for proper cleanup
let activeFfmpegProcess = null;
let cancelTranscription = false;

// CLI argument parsing
const args = process.argv.slice(2);
const inputPath = args[0];
const modelFlagIndex = args.indexOf("--model");
const modelName = modelFlagIndex !== -1 ? args[modelFlagIndex + 1] : null;
const uploadedFlagIndex = args.indexOf("--uploaded");
const isUploadedFile = uploadedFlagIndex !== -1;

if (!inputPath || (modelFlagIndex !== -1 && !modelName)) {
  Logger.error("TRANSCRIBE", "Invalid arguments provided");
  process.exit(1);
}

// Load model config
let model;
try {
  model = getModel(modelName);
} catch (error) {
  Logger.error("TRANSCRIBE", "Failed to load model config", error.message || error);
  process.exit(1);
}

// Configuration with optimized defaults
const config = {
  sampleRate: 16000,
  featDim: 80,
  bufferSizeInSeconds: 5,
  maxFileSizeMB: 500,
  tempDir: path.join(os.tmpdir(), "sherpa-temp"),
  maxConcurrent: Math.max(1, os.cpus().length - 1),

  vad: {
    sileroVad: {
      model: path.join(model.modelDir, "silero_vad.onnx"),
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.5,
      windowSize: 512,
    },
    sampleRate: 16000,
    debug: false,
    numThreads: 1,
  },

  memory: {
    maxHeapMB: 1024,
    gcInterval: 10000,
  },
};

// Create recognizer with resource limits
function createRecognizer() {
  const recognizer = model.createRecognizer({
    sampleRate: config.sampleRate,
    featDim: config.featDim,
    modelDir: model.modelDir,
  });

  if (recognizer && typeof recognizer.setMaxHeapSize === "function") {
    try {
      recognizer.setMaxHeapSize(config.memory.maxHeapMB);
    } catch (error) {
      Logger.log("TRANSCRIBE", `Recognizer.setMaxHeapSize not applied: ${error.message || error}`);
    }
  }

  return recognizer;
}

function createVad() {
  return new sherpa_onnx.Vad(config.vad, config.bufferSizeInSeconds);
}

function formatTime(t) {
  const intPart = Math.floor(Number(t) || 0);
  const ms = Math.floor((Number(t) - intPart) * 1000) || 0;
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
    return `${formatTime(this.start)} --> ${formatTime(this.end)}\n${this.text}`;
  }
}

function mergeSegments(segments, maxDuration = 15, maxPause = 0.5) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const merged = [];
  let current = new Segment(segments[0].start, segments[0].duration, segments[0].text);
  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    const pause = next.start - current.end;
    if (
      pause >= 0 &&
      current.duration + next.duration <= maxDuration &&
      pause < maxPause
    ) {
      current.duration = next.end - current.start;
      current.text = `${current.text} ${next.text}`;
    } else {
      merged.push(current);
      current = new Segment(next.start, next.duration, next.text);
    }
  }
  merged.push(current);
  return merged;
}

async function saveSrt(segments, outPath) {
  segments = segments || [];
  segments.sort((a, b) => a.start - b.start);
  const merged = mergeSegments(segments);
  const srtContent =
    merged.length > 0
      ? merged
          .map((s, i) => `${i + 1}\n${s.toString()}`)
          .join("\n\n")
      : ""; // empty file if no segments

  const dir = path.dirname(outPath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    Logger.warn("TRANSCRIBE", `Failed to ensure output directory: ${error.message || error}`);
  }

  await fs.writeFile(outPath, srtContent, "utf-8");
  Logger.log("TRANSCRIBE", `SRT file saved to: ${outPath}`);
}

function safeFree(obj) {
  if (!obj) return;

  if (typeof obj.free === "function") {
    obj.free();
  } else if (typeof obj.delete === "function") {
    obj.delete();
  } else if (typeof obj.destroy === "function") {
    obj.destroy();
  }
}

async function getAudioFiles(inputPath) {
  const stats = await fs.stat(inputPath);
  const isDirectory = stats.isDirectory();
  const audioExt = new Set([
    ".wav", ".mp3", ".flac", ".m4a", ".ogg",
    ".mp4", ".mkv", ".mov", ".avi", ".webm",
  ]);
  const filesToProcess = [];

  if (isDirectory) {
    const entries = await fs.readdir(inputPath);
    for (const entry of entries) {
      const fullPath = path.join(inputPath, entry);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isFile() && audioExt.has(path.extname(entry).toLowerCase())) {
          const srtPath = fullPath.replace(/\.[^.]*$/, ".srt");
          try {
            await fs.access(srtPath); // exists
            Logger.log("TRANSCRIBE", `Skipping ${path.basename(fullPath)} (SRT already exists)`);
          } catch {
            filesToProcess.push(fullPath); // doesn't exist → process
          }
        }
      } catch {
        // ignore entries that can't be stat'd
      }
    }
  } else if (audioExt.has(path.extname(inputPath).toLowerCase())) {
    const srtPath = inputPath.replace(/\.[^.]*$/, ".srt");
    try {
      await fs.access(srtPath); // exists
      Logger.log("TRANSCRIBE", `Skipping ${path.basename(inputPath)} (SRT already exists)`);
    } catch {
      filesToProcess.push(inputPath); // doesn't exist → process
    }
  }

  return filesToProcess;
}

async function getDuration(inputFile) {
  return new Promise((resolve, _) => {
    let stdout = "";
    const ffprobe = spawn(ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputFile,
    ]);

    ffprobe.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    let stderr = "";
    ffprobe.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    ffprobe.on("error", (error) => {
      Logger.log("TRANSCRIBE", `ffprobe spawn error: ${error.message || error}`);
      resolve(0);
    });

    ffprobe.on("close", (code) => {
      if (code !== 0) {
        Logger.log("TRANSCRIBE", `ffprobe returned code ${code}. stderr: ${stderr.trim()}`);
        resolve(0);
        return;
      }
      const val = parseFloat(stdout);
      if (Number.isFinite(val) && val > 0) resolve(val);
      else resolve(0);
    });
  });
}

async function processFile(inputFile) {
  const filename = path.basename(inputFile);
  const baseName = filename.replace(/\.[^.]*$/, "");
  let safeBaseName = baseName.replace(/[\x00-\x1f"*/:<>?|]/g, "_");

  if (Buffer.byteLength(safeBaseName, "utf8") > 150) {
    while (Buffer.byteLength(safeBaseName, "utf8") > 150 && safeBaseName.length > 0) {
      safeBaseName = safeBaseName.slice(0, -1);
    }
  }
  const srtFilename = `${safeBaseName}.srt`;

  const outPath =
    inputFile.startsWith("/tmp/") || isUploadedFile
      ? path.join("/sdcard/Download", srtFilename)
      : path.join(path.dirname(inputFile), srtFilename);

  Logger.log("TRANSCRIBE", `Starting: ${filename}`);

  const recognizer = createRecognizer();
  const vad = createVad();

  const bufferLength = Math.max(
    1,
    Math.floor(config.bufferSizeInSeconds * (config.vad.sampleRate || config.sampleRate))
  );
  const buffer = new sherpa_onnx.CircularBuffer(bufferLength);

  const duration = await getDuration(inputFile) || 0;
  const startTime = Date.now();
  let processed = 0;

  const progressBar = new cliProgress.SingleBar(
    {
      format:
        chalk.blue("   {bar}") +
        chalk.green(" | {percentage}% | Time: {timeUsed}/{timeRemaining}s | Speed: {speed}x"),
      clearOnComplete: false,
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );

  const progressTotal = duration > 0 ? duration : 1;
  progressBar.start(progressTotal, 0, {
    speed: "N/A",
    timeUsed: "0",
    timeRemaining: "0",
  });

  const progressInterval = setInterval(() => {
    // Update progress bar periodically to ensure it's always showing current status
    const elapsed = Math.max(0.001, (Date.now() - startTime) / 1000);
    const speed = Number((processed / elapsed).toFixed(2));
    const remaining = processed > 0 && duration > 0 ? Math.max(0, (duration - processed) / (processed / elapsed)) : 0;
    const updateValue = duration > 0 ? Math.min(duration, processed) : processed;
    
    progressBar.update(updateValue, {
      speed: isFinite(speed) ? speed : "N/A",
      timeUsed: elapsed.toFixed(1),
      timeRemaining: remaining.toFixed(1),
    });
  }, 1000);

  return new Promise((resolve, reject) => {
    let ffmpeg;
    try {
      ffmpeg = spawn(ffmpegPath, [
        "-i",
        inputFile,
        "-f",
        "s16le",
        "-ac",
        "1",
        "-ar",
        String(config.vad.sampleRate),
        "-",
      ]);
      // Track the active ffmpeg process for signal handling
      activeFfmpegProcess = ffmpeg;
      Logger.log("TRANSCRIBE", `Started ffmpeg process with pid: ${ffmpeg.pid}`);
    } catch (spawnError) {
      clearInterval(progressInterval);
      progressBar.stop();
      safeFree(vad);
      safeFree(recognizer);
      safeFree(buffer);
      const errorMsg = `Failed to spawn FFmpeg: ${spawnError.message || spawnError}`;
      Logger.error("TRANSCRIBE", errorMsg);
      return reject(new Error(errorMsg));
    }

    let ffmpegError = "";
    ffmpeg.stderr.on("data", (data) => {
      ffmpegError += data.toString();
    });

    ffmpeg.stdout.on("data", (chunk) => {
      // Check if transcription has been cancelled
      if (cancelTranscription) {
        Logger.log("TRANSCRIBE", "Transcription cancelled by user");
        // Kill the ffmpeg process
        if (ffmpeg && !ffmpeg.killed) {
          ffmpeg.kill('SIGTERM');
        }
        return;
      }
      
      try {
        const sampleCount = Math.floor(chunk.length / 2);
        const float32 = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          float32[i] = chunk.readInt16LE(i * 2) / 32768.0;
        }
        buffer.push(float32);

        // Yield control to the event loop periodically to allow signal handling
        if (buffer.size() % 1000 === 0) {
          setImmediate(() => {}); // Schedule a microtask to yield control
        }

        while (buffer.size() >= config.vad.sileroVad.windowSize) {
          // Check if transcription has been cancelled before processing
          if (cancelTranscription) {
            Logger.log("TRANSCRIBE", "Transcription cancelled by user during processing");
            // Kill the ffmpeg process
            if (ffmpeg && !ffmpeg.killed) {
              ffmpeg.kill('SIGTERM');
            }
            return;
          }
          
          const frame = buffer.get(buffer.head(), config.vad.sileroVad.windowSize);
          buffer.pop(config.vad.sileroVad.windowSize);
          vad.acceptWaveform(frame);
          
          // Yield control to the event loop periodically to allow signal handling
          if (buffer.head() % 1000 === 0) {
            setImmediate(() => {}); // Schedule a microtask to yield control
          }
        }

        processed += chunk.length / (config.vad.sampleRate * 2);
        const elapsed = Math.max(0.001, (Date.now() - startTime) / 1000);
        const speed = Number((processed / elapsed).toFixed(2));
        const remaining = processed > 0 && duration > 0 ? Math.max(0, (duration - processed) / (processed / elapsed)) : 0;
        const updateValue = duration > 0 ? Math.min(duration, processed) : processed;

        progressBar.update(updateValue, {
          speed: isFinite(speed) ? speed : "N/A",
          timeUsed: elapsed.toFixed(1),
          timeRemaining: remaining.toFixed(1),
        });
      } catch (error) {
        Logger.log("TRANSCRIBE", `Error handling audio chunk: ${error.message || error}`);
        const errorMsg = `Error handling audio chunk: ${error.message || error}`;
        return reject(new Error(errorMsg));
      }
    });

    ffmpeg.on("close", async (code, signal) => {
      // Clear the active ffmpeg process reference
      Logger.log("TRANSCRIBE", `FFmpeg process closed with code: ${code}, signal: ${signal}`);
      activeFfmpegProcess = null;
      clearInterval(progressInterval);
      if (duration > 0) progressBar.update(duration);
      else progressBar.update(processed);
      progressBar.stop();

      if (code !== 0) {
        safeFree(vad);
        safeFree(recognizer);
        safeFree(buffer);
        const errorMsg = `FFmpeg exited with code ${code}. Error: ${ffmpegError}`;
        Logger.error("TRANSCRIBE", `Error processing ${filename}: ${errorMsg}`);
        return reject(new Error(errorMsg));
      }

      try {
        Logger.log("TRANSCRIBE", "Finalizing transcription...");
        if (typeof vad.flush === "function") vad.flush();

        const segments = [];
        while (!vad.isEmpty()) {
          const seg = vad.front();
          vad.pop();

          const stream = recognizer.createStream();
          try {
            stream.acceptWaveform({
              samples: seg.samples,
              sampleRate: config.vad.sampleRate,
            });
            recognizer.decode(stream);
            const result = recognizer.getResult(stream);
            if (result && result.text) {
              segments.push(
                new Segment(
                  seg.start / config.vad.sampleRate,
                  seg.samples.length / config.vad.sampleRate,
                  result.text.trim()
                )
              );
            }
          } finally {
            safeFree(stream);
          }
        }

        await saveSrt(segments, outPath);

        const elapsedTotal = (Date.now() - startTime) / 1000;
        Logger.success("TRANSCRIBE", `Done! Output: ${outPath}`);
        Logger.log("TRANSCRIBE", `   - Segments: ${segments.length}, Duration: ${duration.toFixed(2)}s`);
        Logger.log("TRANSCRIBE", `   - Time: ${elapsedTotal.toFixed(2)}s, Speed: ${(duration > 0 ? (duration / elapsedTotal).toFixed(2) : "N/A")}x`);
        resolve();
      } catch (error) {
        Logger.error("TRANSCRIBE", `Error during final transcription of ${filename}: ${error.message || error}`);
        const errorMsg = `Error during final transcription: ${error.message || error}`;
        return reject(new Error(errorMsg));
      } finally {
        safeFree(vad);
        safeFree(recognizer);
        safeFree(buffer);
      }
    });

    ffmpeg.on("error", (error) => {
      // Clear the active ffmpeg process reference
      Logger.log("TRANSCRIBE", `FFmpeg process error: ${error.message}`);
      activeFfmpegProcess = null;
      clearInterval(progressInterval);
      progressBar.stop();
      safeFree(vad);
      safeFree(recognizer);
      safeFree(buffer);
      Logger.error("TRANSCRIBE", `FFmpeg spawn error for ${filename}: ${error.message || error}`);
      reject(error);
    });
  });
}

async function main() {
  try {
    Logger.log("TRANSCRIBE", "Searching for files to process...");
    const filesToProcess = await getAudioFiles(inputPath);

    if (filesToProcess.length === 0) {
      Logger.warn("TRANSCRIBE", "No new compatible audio/video files found to process.");
      return;
    }

    Logger.log("TRANSCRIBE", `Found ${filesToProcess.length} file(s) to process.`);
    const startTime = Date.now();

    for (const file of filesToProcess) {
      try {
        await processFile(file);
        if (global.gc) {
          try {
            global.gc();
          } catch {
            // ignore GC errors
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      } catch (error) {
        Logger.error("TRANSCRIBE", `Skipping to next file due to error: ${error.message || error}`);
      }
    }

    const totalTime = (Date.now() - startTime) / 1000;
    Logger.success("TRANSCRIBE", `All processing complete! Total time: ${totalTime.toFixed(2)}s`);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      Logger.error("TRANSCRIBE", `Error: The path "${inputPath}" does not exist.`);
    } else {
      Logger.error("TRANSCRIBE", `An unexpected error occurred: ${error && error.message ? error.message : error}`);
    }
    process.exit(1);
  }
}

// Handle SIGINT (Ctrl+C) and SIGTERM signals for graceful shutdown
process.on('SIGINT', () => {
  Logger.log("TRANSCRIBE", "Received SIGINT. Shutting down gracefully...");
  cancelTranscription = true;
  
  if (activeFfmpegProcess) {
    Logger.log("TRANSCRIBE", `Terminating ffmpeg process (pid: ${activeFfmpegProcess.pid})...`);
    try {
      // Try to kill gracefully first
      if (!activeFfmpegProcess.killed) {
        activeFfmpegProcess.kill('SIGTERM');
      }
      
      // Force kill if SIGTERM doesn't work after 2 seconds
      setTimeout(() => {
        if (activeFfmpegProcess && !activeFfmpegProcess.killed) {
          Logger.log("TRANSCRIBE", "Force killing ffmpeg process with SIGKILL...");
          try {
            activeFfmpegProcess.kill('SIGKILL');
          } catch (error) {
            Logger.error("TRANSCRIBE", `Failed to kill ffmpeg process with SIGKILL: ${error.message}`);
          }
        }
      }, 1000);
    } catch (error) {
      Logger.error("TRANSCRIBE", `Error terminating ffmpeg process: ${error.message}`);
    }
  } else {
    Logger.log("TRANSCRIBE", "No active ffmpeg process to terminate");
  }
  
  // Exit quickly if no ffmpeg process
  setTimeout(() => {
    Logger.log("TRANSCRIBE", "Exiting process...");
    process.exit(0);
  }, 1000);
});

process.on('SIGTERM', () => {
  Logger.log("TRANSCRIBE", "Received SIGTERM. Shutting down gracefully...");
  cancelTranscription = true;
  
  if (activeFfmpegProcess) {
    Logger.log("TRANSCRIBE", `Terminating ffmpeg process (pid: ${activeFfmpegProcess.pid})...`);
    try {
      // Try to kill gracefully first
      if (!activeFfmpegProcess.killed) {
        activeFfmpegProcess.kill('SIGTERM');
      }
      
      // Force kill if SIGTERM doesn't work after 1 second
      setTimeout(() => {
        if (activeFfmpegProcess && !activeFfmpegProcess.killed) {
          Logger.log("TRANSCRIBE", "Force killing ffmpeg process with SIGKILL...");
          try {
            activeFfmpegProcess.kill('SIGKILL');
          } catch (error) {
            Logger.error("TRANSCRIBE", `Failed to kill ffmpeg process with SIGKILL: ${error.message}`);
          }
        }
        process.exit(0);
      }, 1000);
    } catch (error) {
      Logger.error("TRANSCRIBE", `Error terminating ffmpeg process: ${error.message}`);
    }
  } else {
    Logger.log("TRANSCRIBE", "No active ffmpeg process to terminate");
  }
  
  // Exit quickly
  setTimeout(() => {
    Logger.log("TRANSCRIBE", "Exiting process...");
    process.exit(0);
  }, 1000);
});

main();
