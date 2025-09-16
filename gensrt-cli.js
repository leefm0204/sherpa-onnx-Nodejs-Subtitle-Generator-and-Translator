#!/usr/bin/node
// transcriber.js
import path from "path";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import sherpa_onnx from "sherpa-onnx-node";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import cliProgress from "cli-progress";
import chalk from "chalk";
import { getModel } from "./modelConfig.js";

const ffmpegPath = ffmpegInstaller.path;
const ffprobePath = ffprobeInstaller.path;

// CLI argument parsing
const args = process.argv.slice(2);
const inputPath = args[0];
const modelName = args.includes("--model")
  ? args[args.indexOf("--model") + 1]
  : null;

if (!inputPath || !modelName) {
  console.error(
    chalk.red("Usage: node transcriber.js /path/to/media --model <modelName>"),
  );
  process.exit(1);
}

// Load model config
let model;
try {
  model = getModel(modelName);
} catch (error) {
  console.error(chalk.red(error.message));
  process.exit(1);
}

// Recognizer and VAD setup
const config = {
  sampleRate: 16000,
  featDim: 80,
  bufferSizeInSeconds: 30,
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
};

const createRecognizer = () =>
  model.createRecognizer({
    sampleRate: config.sampleRate,
    featDim: config.featDim,
    modelDir: model.modelDir,
  });

const createVad = () =>
  new sherpa_onnx.Vad(config.vad, config.bufferSizeInSeconds);

const formatTime = (t) => {
  const intPart = Math.floor(t);
  const ms = Math.floor((t % 1) * 1000);
  const h = String(Math.floor(intPart / 3600)).padStart(2, "0");
  const m = String(Math.floor((intPart % 3600) / 60)).padStart(2, "0");
  const s = String(intPart % 60).padStart(2, "0");
  return `${h}:${m}:${s},${String(ms).padStart(3, "0")}`;
};

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

const mergeSegments = (segments, maxDuration = 15, maxPause = 0.5) => {
  if (!segments.length) return [];
  const merged = [];
  let current = new Segment(
    segments[0].start,
    segments[0].duration,
    segments[0].text,
  );

  for (const next of segments.slice(1)) {
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
};

const saveSrt = async (segments, outPath) => {
  if (!segments || !segments.length) return;
  segments.sort((a, b) => a.start - b.start);
  const merged = mergeSegments(segments);
  const srtContent = merged
    .map((s, i) => `${i + 1}\n${s.toString()}`)
    .join("\n\n");
  await fs.writeFile(outPath, srtContent, "utf-8");
};

const safeFree = (obj) => {
  try {
    if (obj && typeof obj.free === "function") obj.free();
  } catch {
    // Silently ignore errors when freeing objects
  }
};

const getAudioFiles = async (inputPath) => {
  const stats = await fs.stat(inputPath);
  const isDirectory = stats.isDirectory();
  const audioExt = new Set([
    ".wav",
    ".mp3",
    ".flac",
    ".m4a",
    ".ogg",
    ".mp4",
    ".mkv",
    ".mov",
    ".avi",
    ".webm",
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
            await fs.access(srtPath);
            console.log(
              chalk.yellow(
                `- Skipping ${path.basename(fullPath)} (SRT already exists)`,
              ),
            );
          } catch {
            filesToProcess.push(fullPath);
          }
        }
      } catch {
        // Silently ignore errors when checking file stats
      }
    }
  } else if (audioExt.has(path.extname(inputPath).toLowerCase())) {
    const srtPath = inputPath.replace(/\.[^.]*$/, ".srt");
    try {
      await fs.access(srtPath);
      console.log(
        chalk.yellow(
          `- Skipping ${path.basename(inputPath)} (SRT already exists)`,
        ),
      );
    } catch {
      filesToProcess.push(inputPath);
    }
  }
  return filesToProcess;
};

const getDuration = (inputFile) =>
  new Promise((resolve) => {
    const ffprobe = spawn(ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputFile,
    ]);
    let data = "";
    ffprobe.stdout.on("data", (chunk) => (data += chunk));
    ffprobe.on("close", () => resolve(parseFloat(data)));
  });

const processFile = async (inputFile) => {
  const filename = path.basename(inputFile);
  const outPath = inputFile.replace(/\.[^.]*$/, ".srt");

  console.log(chalk.green(`\n▶️  Starting: ${filename}`));

  const recognizer = createRecognizer();
  const vad = createVad();
  const buffer = new sherpa_onnx.CircularBuffer(
    config.bufferSizeInSeconds * config.vad.sampleRate,
  );

  const duration = await getDuration(inputFile);
  const startTime = Date.now();
  let processed = 0;

  const progressBar = new cliProgress.SingleBar(
    {
      format:
        chalk.blue("   {bar}") +
        chalk.green(
          " | {percentage}% | Time: {timeUsed}/{timeRemaining}s | Speed: {speed}x",
        ),
      clearOnComplete: false,
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic,
  );

  progressBar.start(duration, 0, {
    speed: "N/A",
    timeUsed: "0",
    timeRemaining: "0",
  });

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      "-i",
      inputFile,
      "-f",
      "s16le",
      "-ac",
      "1",
      "-ar",
      config.vad.sampleRate.toString(),
      "-",
    ]);

    ffmpeg.stdout.on("data", (chunk) => {
      const sampleCount = Math.floor(chunk.length / 2);
      const float32 = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        float32[i] = chunk.readInt16LE(i * 2) / 32768.0;
      }
      buffer.push(float32);
      while (buffer.size() >= config.vad.sileroVad.windowSize) {
        const frame = buffer.get(
          buffer.head(),
          config.vad.sileroVad.windowSize,
        );
        buffer.pop(config.vad.sileroVad.windowSize);
        vad.acceptWaveform(frame);
      }
      processed += chunk.length / (config.vad.sampleRate * 2);
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = (processed / elapsed).toFixed(2);
      const remaining = Math.max(
        0,
        (duration - processed) / (processed / elapsed) || 0,
      );
      progressBar.update(processed, {
        speed,
        timeUsed: elapsed.toFixed(1),
        timeRemaining: remaining.toFixed(1),
      });
    });

    let ffmpegError = "";
    ffmpeg.stderr.on("data", (data) => {
      ffmpegError += data.toString();
    });

    ffmpeg.on("close", async (code) => {
      progressBar.update(duration);
      progressBar.stop();
      if (code !== 0) {
        safeFree(vad);
        safeFree(recognizer);
        safeFree(buffer);
        const errorMsg = `FFmpeg exited with code ${code}. Error: ${ffmpegError}`;
        console.error(
          chalk.red(`\n❌ Error processing ${filename}: ${errorMsg}`),
        );
        return reject(new Error(errorMsg));
      }

      try {
        console.log(chalk.green("   Finalizing transcription..."));
        vad.flush();
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
                  result.text.trim(),
                ),
              );
            }
          } finally {
            safeFree(stream);
          }
        }

        await saveSrt(segments, outPath);

        const elapsedTotal = (Date.now() - startTime) / 1000;
        console.log(chalk.green(`✅ Done! Output: ${outPath}`));
        console.log(
          chalk.blue(
            `   - Segments: ${segments.length}, Duration: ${duration.toFixed(2)}s`,
          ),
        );
        console.log(
          chalk.blue(
            `   - Time: ${elapsedTotal.toFixed(2)}s, Speed: ${(duration / elapsedTotal).toFixed(2)}x`,
          ),
        );
        resolve();
      } catch (error) {
        console.error(
          chalk.red(
            `\n❌ Error during final transcription of ${filename}: ${error.message}`,
          ),
        );
        reject(error);
      } finally {
        safeFree(vad);
        safeFree(recognizer);
        safeFree(buffer);
      }
    });

    ffmpeg.on("error", (error) => {
      progressBar.stop();
      safeFree(vad);
      safeFree(recognizer);
      safeFree(buffer);
      console.error(
        chalk.red(`\n❌ FFmpeg spawn error for ${filename}: ${error.message}`),
      );
      reject(error);
    });
  });
};

const main = async () => {
  try {
    console.log(chalk.blue("🔍 Searching for files to process..."));
    const filesToProcess = await getAudioFiles(inputPath);

    if (filesToProcess.length === 0) {
      console.log(
        chalk.yellow("No new compatible audio/video files found to process."),
      );
      return;
    }

    console.log(
      chalk.blue(`📂 Found ${filesToProcess.length} file(s) to process.`),
    );
    const startTime = Date.now();

    for (const file of filesToProcess) {
      try {
        await processFile(file);
        
        // Force garbage collection after each file if available
        if (global.gc) {
          global.gc();
        }
        
        // Add a small delay between files to allow for resource cleanup
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(
          chalk.yellow(
            `⚠️ Skipping to next file due to error: ${error.message}`,
          ),
        );
      }
    }

    const totalTime = (Date.now() - startTime) / 1000;
    console.log(
      chalk.green(
        `
🎉 All processing complete! Total time: ${totalTime.toFixed(2)}s`,
      ),
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error(
        chalk.red(`❌ Error: The path "${inputPath}" does not exist.`),
      );
    } else {
      console.error(
        chalk.red(`❌ An unexpected error occurred: ${error.message}`),
      );
    }
    process.exit(1);
  }
};

main();
