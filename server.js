// server.js - Enhanced version with improved security, performance, and error handling
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';

import express from 'express';
import { WebSocketServer } from 'ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';

import { uploadSingleFile, cleanupUploadedFiles } from './fileupload.js';
import { getCachedSystemInfo, clearFileCache } from './cache-optimization.js';

// ==================== CONFIGURATION ====================
const CONFIG = {
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || 'localhost',
    environment: process.env.NODE_ENV || 'development'
  },
  security: {
    maxFileSize: process.env.MAX_FILE_SIZE || '500MB',
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    rateLimitWindowMs: 15 * 60 * 1000, // 15 minutes
    rateLimitMax: 100, // limit each IP to 100 requests per windowMs
    websocketRateLimitMax: 20, // messages per second
    sessionTimeout: 30 * 60 * 1000 // 30 minutes
  },
  processing: {
    maxConcurrentTranscriptions: process.env.MAX_CONCURRENT_TRANSCRIPTIONS || 2,
    maxConcurrentTranslations: process.env.MAX_CONCURRENT_TRANSLATIONS || 3,
    processTimeout: 30 * 60 * 1000, // 30 minutes
    heartbeatInterval: 30000,
    memoryThreshold: 1024 * 1024 * 1024 // 1GB
  },
  paths: {
    uploadDir: process.env.UPLOAD_DIR || '/tmp/uploads',
    outputDir: process.env.OUTPUT_DIR || '/sdcard/Download'
  }
};

// ==================== ENHANCED LOGGING ====================
class Logger {
  static levels = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
  static currentLevel = Logger.levels[process.env.LOG_LEVEL || 'INFO'];

  static log(level, message, ...args) {
    if (Logger.levels[level] <= Logger.currentLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${level}]`;
      console.log(prefix, message, ...args);
    }
  }

  static error(message, ...args) { Logger.log('ERROR', message, ...args); }
  static warn(message, ...args) { Logger.log('WARN', message, ...args); }
  static info(message, ...args) { Logger.log('INFO', message, ...args); }
  static debug(message, ...args) { Logger.log('DEBUG', message, ...args); }
}

// ==================== ENHANCED SECURITY ====================
class SecurityManager {
  static validateFilePath(filePath) {
    const resolved = path.resolve(filePath);
    const allowedDirs = [CONFIG.paths.uploadDir, CONFIG.paths.outputDir, process.cwd()];
    
    return allowedDirs.some(dir => resolved.startsWith(path.resolve(dir)));
  }

  static sanitizeFilename(filename) {
    return filename.replace(/[<>:"\/\\|?*\x00-\x1f]/g, '_').substring(0, 255);
  }

  static validateAudioExtension(filename) {
    const allowedExtensions = ['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.mp4', '.mkv', '.mov', '.avi', '.webm'];
    return allowedExtensions.includes(path.extname(filename.toLowerCase()));
  }

  static generateSessionId() {
    return crypto.randomUUID();
  }

  static isValidSRTFile(filename) {
    return filename.toLowerCase().endsWith('.srt');
  }
}

// ==================== PROCESS MANAGER ====================
class ProcessManager {
  constructor() {
    this.transcriptionProcesses = new Map();
    this.translationProcesses = new Map();
    this.processTimeouts = new Map();
    this.activeJobs = new Map(); // Track job metadata
  }

  async spawnProcess(command, args, options, jobId, type) {
    const spawnOptions = {
      ...options,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    };

    const child = spawn(command, args, spawnOptions);
    
    if (type === 'transcription') {
      this.transcriptionProcesses.set(child.pid, child);
    } else {
      this.translationProcesses.set(child.pid, child);
    }

    // Set timeout for process
    const timeoutId = setTimeout(() => {
      Logger.warn(`Process ${child.pid} timed out, killing...`);
      this.killProcess(child.pid, type);
    }, CONFIG.processing.processTimeout);
    
    this.processTimeouts.set(child.pid, timeoutId);
    
    // Store job metadata
    this.activeJobs.set(child.pid, {
      jobId,
      type,
      startTime: Date.now(),
      command,
      args
    });

    Logger.info(`Spawned ${type} process`, { pid: child.pid, jobId });
    return child;
  }

  async killProcess(pid, type) {
    const processMap = type === 'transcription' ? this.transcriptionProcesses : this.translationProcesses;
    const process = processMap.get(pid);
    
    if (!process) {
      Logger.debug(`Process ${pid} not found for killing`);
      return false;
    }

    try {
      // Clear timeout
      const timeoutId = this.processTimeouts.get(pid);
      if (timeoutId) {
        clearTimeout(timeoutId);
        this.processTimeouts.delete(pid);
      }

      // Kill process tree
      const killed = this.tryKillProcessTree(process);
      
      // Cleanup tracking
      processMap.delete(pid);
      this.activeJobs.delete(pid);
      
      Logger.info(`Killed ${type} process ${pid}`);
      return killed;
    } catch (error) {
      Logger.error(`Error killing process ${pid}:`, error);
      return false;
    }
  }

  async killAllProcesses(type = null) {
    const processes = [];
    
    if (!type || type === 'transcription') {
      processes.push(...Array.from(this.transcriptionProcesses.keys()).map(pid => ({ pid, type: 'transcription' })));
    }
    
    if (!type || type === 'translation') {
      processes.push(...Array.from(this.translationProcesses.keys()).map(pid => ({ pid, type: 'translation' })));
    }

    const killPromises = processes.map(({ pid, type }) => this.killProcess(pid, type));
    await Promise.allSettled(killPromises);
    
    Logger.info(`Killed all ${type || 'active'} processes`);
  }

  tryKillProcessTree(proc) {
    if (!proc || !proc.pid) return false;
    
    const pid = proc.pid;
    Logger.debug(`Killing process tree for pid=${pid}`);

    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { 
          detached: true, 
          stdio: 'ignore', 
          shell: false 
        }).unref();
        return true;
      } catch (error) {
        Logger.error('taskkill failed:', error);
        try {
          proc.kill('SIGKILL');
          return true;
        } catch (fallbackError) {
          Logger.error('Fallback kill failed:', fallbackError);
          return false;
        }
      }
    }

    // POSIX systems
    try {
      process.kill(-pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch { /* ignore */ }
      }, 2000);
      return true;
    } catch {
      try {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch { /* ignore */ }
        }, 2000);
        return true;
      } catch {
        return false;
      }
    }
  }

  getProcessCount(type = null) {
    if (type === 'transcription') return this.transcriptionProcesses.size;
    if (type === 'translation') return this.translationProcesses.size;
    return this.transcriptionProcesses.size + this.translationProcesses.size;
  }

  getActiveJobs(type = null) {
    const jobs = Array.from(this.activeJobs.values());
    return type ? jobs.filter(job => job.type === type) : jobs;
  }
}

// ==================== RESOURCE MONITOR ====================
class ResourceMonitor {
  constructor() {
    this.metrics = {
      memoryUsage: [],
      activeConnections: 0,
      processedFiles: 0,
      errors: 0
    };
  }

  logMemoryUsage(label = '') {
    const usage = process.memoryUsage();
    const systemMem = {
      total: os.totalmem(),
      free: os.freemem(),
      used: os.totalmem() - os.freemem()
    };

    const memInfo = {
      timestamp: Date.now(),
      label,
      process: {
        rss: Math.round(usage.rss / 1024 / 1024), // MB
        heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
        heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
        external: Math.round(usage.external / 1024 / 1024) // MB
      },
      system: {
        total: Math.round(systemMem.total / 1024 / 1024), // MB
        free: Math.round(systemMem.free / 1024 / 1024), // MB
        used: Math.round(systemMem.used / 1024 / 1024) // MB
      }
    };

    this.metrics.memoryUsage.push(memInfo);
    
    // Keep only last 100 entries
    if (this.metrics.memoryUsage.length > 100) {
      this.metrics.memoryUsage.shift();
    }

    if (CONFIG.server.environment === 'development') {
      Logger.debug(`${label} - Memory:`, memInfo);
    }

    // Check memory threshold
    if (usage.rss > CONFIG.processing.memoryThreshold) {
      Logger.warn(`High memory usage detected: ${memInfo.process.rss}MB`);
      if (global.gc) {
        global.gc();
        Logger.debug('Forced garbage collection');
      }
    }

    return memInfo;
  }

  incrementMetric(metric) {
    if (metric in this.metrics) {
      this.metrics[metric]++;
    }
  }

  getMetrics() {
    return {
      ...this.metrics,
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform
    };
  }
}

// ==================== WEBSOCKET MANAGER ====================
class WebSocketManager {
  constructor() {
    this.clients = new Map();
    this.heartbeatInterval = null;
    this.messageHandlers = new Map();
    this.setupHandlers();
  }

  setupHandlers() {
    this.messageHandlers.set('stop_transcription', this.handleStopTranscription.bind(this));
    this.messageHandlers.set('stop_translation', this.handleStopTranslation.bind(this));
    this.messageHandlers.set('ping', this.handlePing.bind(this));
    this.messageHandlers.set('clear_translation', this.handleClearTranslation.bind(this));
    this.messageHandlers.set('clear_files', this.handleClearFiles.bind(this));
    this.messageHandlers.set('request_state', this.handleRequestState.bind(this));
  }

  startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    
    this.heartbeatInterval = setInterval(() => {
      for (const [ws, client] of this.clients.entries()) {
        if (!client.isAlive) {
          Logger.warn(`Terminating non-responsive client ${client.id}`);
          ws.terminate();
          continue;
        }
        
        client.isAlive = false;
        try {
          ws.ping();
        } catch (err) {
          Logger.error(`Error pinging client ${client.id}:`, err);
        }
      }
    }, CONFIG.processing.heartbeatInterval);
  }

  addClient(ws, req) {
    const clientId = SecurityManager.generateSessionId();
    const clientIp = req.socket.remoteAddress;
    
    const client = {
      id: clientId,
      ip: clientIp,
      isAlive: true,
      messageTimestamps: [],
      lastActivity: Date.now(),
      subscriptions: new Set(),
      connectionTime: Date.now()
    };
    
    this.clients.set(ws, client);
    resourceMonitor.metrics.activeConnections = this.clients.size;
    
    Logger.info(`New WebSocket connection: ${clientId} from ${clientIp}`);
    
    return client;
  }

  removeClient(ws) {
    const client = this.clients.get(ws);
    if (client) {
      Logger.info(`Client disconnected: ${client.id}`);
      this.clients.delete(ws);
      resourceMonitor.metrics.activeConnections = this.clients.size;
    }
  }

  rateLimit(ws) {
    const client = this.clients.get(ws);
    if (!client) return true; // Deny if client not found
    
    const now = Date.now();
    const windowStart = now - 1000; // 1 second window
    
    client.messageTimestamps = client.messageTimestamps.filter(t => t > windowStart);
    
    if (client.messageTimestamps.length >= CONFIG.security.websocketRateLimitMax) {
      Logger.warn(`Rate limit exceeded for client ${client.id}`);
      return true;
    }
    
    client.messageTimestamps.push(now);
    return false;
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    let sent = 0;
    let failed = 0;
    
    for (const [ws, client] of this.clients.entries()) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(payload);
          sent++;
        } catch (error) {
          Logger.error(`Failed to send to client ${client.id}:`, error);
          failed++;
        }
      }
    }
    
    Logger.debug(`Broadcast sent to ${sent} clients, ${failed} failures`);
  }

  async handleMessage(ws, rawMessage) {
    const client = this.clients.get(ws);
    if (!client) return;

    try {
      client.lastActivity = Date.now();
      
      if (this.rateLimit(ws)) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please slow down.'
        }));
        return;
      }

      const messageStr = rawMessage.toString();
      if (messageStr.length > 10240) { // 10KB max
        throw new Error('Message too large');
      }

      const message = JSON.parse(messageStr);
      
      if (!message || typeof message !== 'object' || !message.type) {
        throw new Error('Invalid message format');
      }

      const handler = this.messageHandlers.get(message.type);
      if (handler) {
        await handler(ws, message);
      } else {
        Logger.warn(`Unknown message type: ${message.type} from client ${client.id}`);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'UNKNOWN_MESSAGE_TYPE',
          message: `Unknown message type: ${message.type}`
        }));
      }
    } catch (error) {
      Logger.error(`Message processing error for client ${client.id}:`, error);
      resourceMonitor.incrementMetric('errors');
      
      try {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'PROCESSING_ERROR',
          message: 'Error processing message',
          details: error.message
        }));
      } catch (sendError) {
        Logger.error(`Failed to send error response to ${client.id}:`, sendError);
      }
    }
  }

  // Message handlers
  async handleStopTranscription(ws, message) {
    const client = this.clients.get(ws);
    Logger.info(`Client ${client.id} stopping transcription`);
    
    await processManager.killAllProcesses('transcription');
    appState.transcription = { filesList: [], isProcessing: false };
    this.broadcast({ type: 'state_update', state: appState.transcription });
  }

  async handleStopTranslation(ws, message) {
    const client = this.clients.get(ws);
    Logger.info(`Client ${client.id} stopping translation`);
    
    await processManager.killAllProcesses('translation');
    appState.translation = { translationQueue: [], isProcessing: false };
    this.broadcast({ type: 'translation_state', state: appState.translation });
  }

  async handlePing(ws, message) {
    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
  }

  async handleClearTranslation(ws, message) {
    const client = this.clients.get(ws);
    Logger.info(`Client ${client.id} clearing translation queue`);
    
    appState.translation.translationQueue = [];
    this.broadcast({ type: 'translation_state', state: appState.translation });
  }

  async handleClearFiles(ws, message) {
    const client = this.clients.get(ws);
    Logger.info(`Client ${client.id} clearing file list`);
    
    appState.transcription.filesList = [];
    this.broadcast({ type: 'state_update', state: appState.transcription });
  }

  async handleRequestState(ws, message) {
    const client = this.clients.get(ws);
    
    const status = {
      type: 'status',
      transcription: {
        running: processManager.getProcessCount('transcription') > 0,
        processCount: processManager.getProcessCount('transcription'),
        pids: Array.from(processManager.transcriptionProcesses.keys())
      },
      translation: {
        running: processManager.getProcessCount('translation') > 0,
        processCount: processManager.getProcessCount('translation'),
        pids: Array.from(processManager.translationProcesses.keys())
      },
      system: resourceMonitor.getMetrics()
    };
    
    ws.send(JSON.stringify(status));
    ws.send(JSON.stringify({ type: 'state_update', state: appState.transcription }));
    ws.send(JSON.stringify({ type: 'translation_state', state: appState.translation }));
  }
}

// ==================== INITIALIZATION ====================
// Enable explicit garbage collection
if (global.gc) {
  Logger.info('Garbage collection is enabled');
} else {
  Logger.warn('Garbage collection not enabled. Start with --expose-gc flag for better memory management');
}

// Initialize managers
const processManager = new ProcessManager();
const resourceMonitor = new ResourceMonitor();
const wsManager = new WebSocketManager();

// Application state
const appState = {
  transcription: { filesList: [] },
  translation: { translationQueue: [] }
};

// Track uploaded files for cleanup
const uploadedFiles = new Set();

// __dirname helper for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== EXPRESS APP SETUP ====================
const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for WebSocket connections
}));

// Compression middleware
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: CONFIG.security.rateLimitWindowMs,
  max: CONFIG.security.rateLimitMax,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.', {
  maxAge: CONFIG.server.environment === 'production' ? '1d' : 0
}));

// ==================== API ROUTES ====================

// Enhanced file upload endpoint
app.post('/api/upload', uploadSingleFile('file'), async (req, res) => {
  const startTime = Date.now();
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Security validation
    if (!SecurityManager.validateFilePath(req.file.path)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    if (!SecurityManager.validateAudioExtension(req.file.originalname)) {
      return res.status(400).json({ error: 'Unsupported file format' });
    }

    const filePath = path.resolve(req.file.path);
    const filename = SecurityManager.sanitizeFilename(req.file.originalname || path.basename(filePath));
    
    uploadedFiles.add(filePath);
    resourceMonitor.incrementMetric('processedFiles');
    
    Logger.info('File uploaded:', { filename, size: req.file.size, path: filePath });
    
    // Add to transcription state
    appState.transcription.filesList.push({ name: filename, status: 'pending' });
    wsManager.broadcast({ type: 'state_update', state: appState.transcription });
    wsManager.broadcast({ type: 'files_detected', files: [filename] });
    
    const processingTime = Date.now() - startTime;
    res.json({ 
      message: 'File uploaded successfully',
      filePath: filePath,
      filename: filename,
      processingTime
    });

    // Start transcription asynchronously
    setImmediate(() => processTranscription(filePath, filename));
    
  } catch (error) {
    Logger.error('Upload error:', error);
    resourceMonitor.incrementMetric('errors');
    res.status(500).json({ error: 'Failed to process upload' });
  }
});

// Enhanced SRT upload endpoint
app.post('/api/upload-srt', uploadSingleFile('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!SecurityManager.isValidSRTFile(req.file.originalname)) {
      return res.status(400).json({ error: 'Only SRT files are allowed' });
    }

    const filePath = path.resolve(req.file.path);
    const filename = SecurityManager.sanitizeFilename(req.file.originalname);
    
    uploadedFiles.add(filePath);
    Logger.info('SRT file uploaded:', { filename, size: req.file.size });
    
    appState.translation.translationQueue.push({ filename, status: 'pending' });
    wsManager.broadcast({ type: 'translation_state', state: appState.translation });
    
    res.json({ 
      message: 'SRT file uploaded successfully',
      filePath,
      filename
    });

    // Start translation asynchronously
    setImmediate(() => processTranslation(filePath, filename, 'auto', 'en'));
    
  } catch (error) {
    Logger.error('SRT upload error:', error);
    res.status(500).json({ error: 'Failed to process SRT upload' });
  }
});

// Enhanced transcription endpoint
app.post('/api/start', async (req, res) => {
  try {
    const { inputPath, model = 'senseVoice' } = req.body;
    const validModels = ['senseVoice', 'nemoCtc', 'transducer'];

    if (!inputPath || !SecurityManager.validateFilePath(inputPath)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    if (!validModels.includes(model)) {
      return res.status(400).json({ error: `Invalid model. Allowed: ${validModels.join(', ')}` });
    }

    const stats = await fs.stat(inputPath);
    let files = [];

    if (stats.isDirectory()) {
      const all = await fs.readdir(inputPath);
      files = all
        .filter(f => SecurityManager.validateAudioExtension(f))
        .map(f => path.join(inputPath, f));
    } else if (stats.isFile()) {
      if (!SecurityManager.validateAudioExtension(inputPath)) {
        return res.status(400).json({ error: 'Unsupported file format' });
      }
      files = [inputPath];
    }

    if (files.length === 0) {
      return res.status(400).json({ error: 'No valid audio files found' });
    }

    appState.transcription.filesList = files.map(f => ({ 
      name: path.basename(f), 
      status: 'pending' 
    }));
    
    wsManager.broadcast({ type: 'state_update', state: appState.transcription });
    wsManager.broadcast({ 
      type: 'files_detected', 
      files: appState.transcription.filesList.map(x => x.name) 
    });

    // Process files sequentially
    setImmediate(() => processMultipleTranscriptions(files, model));

    res.json({ 
      success: true, 
      message: 'Transcription started',
      fileCount: files.length 
    });

  } catch (error) {
    Logger.error('Transcription start error:', error);
    res.status(500).json({ error: 'Failed to start transcription' });
  }
});

// Enhanced translation endpoint
app.post('/api/translate', async (req, res) => {
  try {
    const { srtPath, sourceLang, targetLang } = req.body;

    if (!srtPath || !sourceLang || !targetLang) {
      return res.status(400).json({ 
        error: 'SRT path, source language, and target language are required' 
      });
    }

    if (!SecurityManager.validateFilePath(srtPath)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    const stats = await fs.stat(srtPath);
    let files = [];

    if (stats.isDirectory()) {
      const all = await fs.readdir(srtPath);
      files = all
        .filter(f => SecurityManager.isValidSRTFile(f))
        .map(f => path.join(srtPath, f));
    } else if (stats.isFile()) {
      if (!SecurityManager.isValidSRTFile(srtPath)) {
        return res.status(400).json({ error: 'File is not an SRT file' });
      }
      files = [srtPath];
    }

    appState.translation.translationQueue = files.map(f => ({ 
      filename: path.basename(f), 
      status: 'queued' 
    }));
    
    wsManager.broadcast({ type: 'translation_state', state: appState.translation });

    // Process files sequentially
    setImmediate(() => processMultipleTranslations(files, sourceLang, targetLang));

    res.json({ 
      success: true, 
      message: 'Translation started',
      fileCount: files.length 
    });

  } catch (error) {
    Logger.error('Translation start error:', error);
    res.status(500).json({ error: 'Failed to start translation' });
  }
});

// System info endpoint with enhanced metrics
app.get('/system-info', async (req, res) => {
  try {
    const systemInfo = await getCachedSystemInfo();
    const metrics = resourceMonitor.getMetrics();
    
    res.json({
      ...systemInfo,
      process: {
        ...metrics,
        activeProcesses: {
          transcription: processManager.getProcessCount('transcription'),
          translation: processManager.getProcessCount('translation'),
          total: processManager.getProcessCount()
        }
      }
    });
  } catch (error) {
    Logger.error('System info error:', error);
    res.status(500).json({ error: 'Failed to get system info' });
  }
});

// Language endpoint with caching
app.get('/language.json', async (req, res) => {
  try {
    const data = await fs.readFile(path.join(__dirname, 'language.json'), 'utf8');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.json(JSON.parse(data));
  } catch (error) {
    Logger.error('Language file error:', error);
    res.status(500).json({ error: 'Failed to load languages' });
  }
});

// ==================== PROCESSING FUNCTIONS ====================

async function processTranscription(filePath, filename) {
  const jobId = SecurityManager.generateSessionId();
  
  try {
    // Update status
    const index = appState.transcription.filesList.findIndex(x => x.name === filename);
    if (index !== -1) {
      appState.transcription.filesList[index].status = 'processing';
      wsManager.broadcast({ type: 'state_update', state: appState.transcription });
    }

    wsManager.broadcast({ type: 'file_start', filename });
    resourceMonitor.logMemoryUsage(`Starting transcription: ${filename}`);

    const transcriberPath = path.join(__dirname, 'gensrt.js');
    const isUploaded = uploadedFiles.has(filePath);
    const args = [transcriberPath, filePath, '--model', 'senseVoice'];
    if (isUploaded) args.push('--uploaded');

    const transcriber = await processManager.spawnProcess('node', args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LD_LIBRARY_PATH: path.join(__dirname, 'node_modules', 'sherpa-onnx-linux-arm64') + ':' + (process.env.LD_LIBRARY_PATH || '')
      }
    }, jobId, 'transcription');

    let finalSrtPath = null;
    const startTime = Date.now();
    let lastProgress = -1;

    // Handle stdout
    if (transcriber.stdout) {
      transcriber.stdout.on('data', (chunk) => {
        const output = chunk.toString();
        wsManager.broadcast({ type: 'debug_output', output });

        // Parse progress
        if (output.includes('Progress:')) {
          const match = output.match(/Progress:\s*(\d+)%.*?(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)s.*?Speed:\s*(\d+(?:\.\d+)?)x.*?Elapsed:\s*(\d+(?:\.\d+)?)s.*?Remaining:\s*(\d+(?:\.\d+)?)s/);
          if (match) {
            const progress = Number(match[1]);
            const processed = Number(match[2]);
            const total = Number(match[3]);
            const speed = Number(match[4]);
            const elapsed = Number(match[5]);
            const remaining = Number(match[6]);
            
            if (progress !== lastProgress) {
              lastProgress = progress;

              wsManager.broadcast({
                type: 'transcription_progress',
                filename,
                progress,
                processed,
                duration: total,
                elapsed,
                remaining,
                speed
              });
            }
          } else {
            // Fallback to original parsing if enhanced format is not available
            const fallbackMatch = output.match(/Progress:\s*(\d+)%.*?(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)s/);
            if (fallbackMatch) {
              const progress = Number(fallbackMatch[1]);
              const processed = Number(fallbackMatch[2]);
              const total = Number(fallbackMatch[3]);
              
              if (progress !== lastProgress) {
                lastProgress = progress;
                const elapsed = (Date.now() - startTime) / 1000;
                const speed = elapsed > 0 ? processed / elapsed : 0;
                const remaining = progress >= 100 ? 0 : Math.max(0, (total - processed) / speed);

                wsManager.broadcast({
                  type: 'transcription_progress',
                  filename,
                  progress,
                  processed,
                  duration: total,
                  elapsed,
                  remaining,
                  speed
                });
              }
            }
          }
        }

        // Parse output path
        const pathMatch = output.match(/(?:SRT file saved to:|Done!\s*Output:)\s*(.+)/);
        if (pathMatch) {
          finalSrtPath = path.resolve(pathMatch[1].trim());
          Logger.debug(`Detected output path: ${finalSrtPath}`);
        }
      });
    }

    if (transcriber.stderr) {
      transcriber.stderr.on('data', (chunk) => {
        wsManager.broadcast({ type: 'debug_output', output: chunk.toString() });
      });
    }

    // Handle process completion
    transcriber.on('close', (code, signal) => {
      Logger.info(`Transcription completed: ${filename}`, { code, signal });
      
      const fileIndex = appState.transcription.filesList.findIndex(x => x.name === filename);
      
      if (code === 0) {
        if (fileIndex !== -1) {
          appState.transcription.filesList[fileIndex].status = 'completed';
        }
        
        if (!finalSrtPath) {
          const baseName = SecurityManager.sanitizeFilename(path.basename(filePath, path.extname(filePath)));
          finalSrtPath = isUploaded 
            ? path.join(CONFIG.paths.outputDir, `${baseName}.srt`)
            : path.join(path.dirname(filePath), `${baseName}.srt`);
        }
        
        wsManager.broadcast({ type: 'file_complete', filename, srtPath: finalSrtPath });
        resourceMonitor.logMemoryUsage(`Completed: ${filename}`);
      } else {
        if (fileIndex !== -1) {
          appState.transcription.filesList[fileIndex].status = 'error';
        }
        wsManager.broadcast({ 
          type: 'file_error', 
          filename, 
          error: `Transcription failed with code ${code}` 
        });
      }
      
      wsManager.broadcast({ type: 'state_update', state: appState.transcription });
      
      // Cleanup uploaded file
      if (isUploaded && uploadedFiles.has(filePath)) {
        uploadedFiles.delete(filePath);
        cleanupUploadedFiles([filePath]).catch(err => {
          Logger.warn(`Failed to cleanup ${filePath}:`, err);
        });
      }
    });

    transcriber.on('error', (error) => {
      Logger.error(`Transcription process error: ${filename}`, error);
      const fileIndex = appState.transcription.filesList.findIndex(x => x.name === filename);
      if (fileIndex !== -1) {
        appState.transcription.filesList[fileIndex].status = 'error';
      }
      wsManager.broadcast({ 
        type: 'file_error', 
        filename, 
        error: `Process error: ${error.message}` 
      });
    });

  } catch (error) {
    Logger.error(`Failed to start transcription: ${filename}`, error);
    const fileIndex = appState.transcription.filesList.findIndex(x => x.name === filename);
    if (fileIndex !== -1) {
      appState.transcription.filesList[fileIndex].status = 'error';
    }
    wsManager.broadcast({ 
      type: 'file_error', 
      filename, 
      error: `Failed to start: ${error.message}` 
    });
  }
}

async function processTranslation(filePath, filename, sourceLang, targetLang) {
  const jobId = SecurityManager.generateSessionId();
  
  try {
    const index = appState.translation.translationQueue.findIndex(x => x.filename === filename);
    if (index !== -1) {
      appState.translation.translationQueue[index].status = 'processing';
      wsManager.broadcast({ type: 'translation_state', state: appState.translation });
    }

    wsManager.broadcast({ type: 'translation_start', filename });
    resourceMonitor.logMemoryUsage(`Starting translation: ${filename}`);

    const translatorPath = path.join(__dirname, 'srt-gtk.js');
    const translator = await processManager.spawnProcess('node', [translatorPath, filePath, sourceLang, targetLang], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LD_LIBRARY_PATH: path.join(__dirname, 'node_modules', 'sherpa-onnx-linux-arm64') + ':' + (process.env.LD_LIBRARY_PATH || '')
      }
    }, jobId, 'translation');

    let translatedPath = null;

    if (translator.stdout) {
      translator.stdout.on('data', (chunk) => {
        const output = chunk.toString();
        wsManager.broadcast({ type: 'debug_output', output });

        const pathMatch = output.match(/Saved:\s*(.+)$/);
        if (pathMatch) {
          translatedPath = path.join(CONFIG.paths.outputDir, pathMatch[1].trim());
        }
      });
    }

    if (translator.stderr) {
      translator.stderr.on('data', (chunk) => {
        wsManager.broadcast({ type: 'debug_output', output: chunk.toString() });
      });
    }

    translator.on('close', (code) => {
      Logger.info(`Translation completed: ${filename}`, { code });
      
      const fileIndex = appState.translation.translationQueue.findIndex(x => x.filename === filename);
      
      if (code === 0) {
        if (fileIndex !== -1) {
          appState.translation.translationQueue[fileIndex].status = 'completed';
        }
        
        if (!translatedPath) {
          const baseName = SecurityManager.sanitizeFilename(path.basename(filePath, '.srt'));
          translatedPath = path.join(CONFIG.paths.outputDir, `${baseName}-${targetLang}.srt`);
        }
        
        wsManager.broadcast({ type: 'translation_complete', filename, outPath: translatedPath });
      } else {
        if (fileIndex !== -1) {
          appState.translation.translationQueue[fileIndex].status = 'error';
        }
        wsManager.broadcast({ 
          type: 'translation_error', 
          filename, 
          error: `Translation failed with code ${code}` 
        });
      }
      
      wsManager.broadcast({ type: 'translation_state', state: appState.translation });
      
      // Cleanup
      if (uploadedFiles.has(filePath)) {
        uploadedFiles.delete(filePath);
        cleanupUploadedFiles([filePath]).catch(err => {
          Logger.warn(`Failed to cleanup ${filePath}:`, err);
        });
      }
    });

    translator.on('error', (error) => {
      Logger.error(`Translation process error: ${filename}`, error);
      const fileIndex = appState.translation.translationQueue.findIndex(x => x.filename === filename);
      if (fileIndex !== -1) {
        appState.translation.translationQueue[fileIndex].status = 'error';
      }
      wsManager.broadcast({ 
        type: 'translation_error', 
        filename, 
        error: `Process error: ${error.message}` 
      });
    });

  } catch (error) {
    Logger.error(`Failed to start translation: ${filename}`, error);
    const fileIndex = appState.translation.translationQueue.findIndex(x => x.filename === filename);
    if (fileIndex !== -1) {
      appState.translation.translationQueue[fileIndex].status = 'error';
    }
    wsManager.broadcast({ 
      type: 'translation_error', 
      filename, 
      error: `Failed to start: ${error.message}` 
    });
  }
}

async function processMultipleTranscriptions(files, model) {
  for (const file of files) {
    const filename = path.basename(file);
    await processTranscription(file, filename);
    
    // Check if we should stop processing
    if (processManager.getProcessCount('transcription') === 0) break;
  }
  
  wsManager.broadcast({ type: 'all_complete', totalTime: 0 });
}

async function processMultipleTranslations(files, sourceLang, targetLang) {
  for (const file of files) {
    const filename = path.basename(file);
    await processTranslation(file, filename, sourceLang, targetLang);
    
    // Check if we should stop processing
    if (processManager.getProcessCount('translation') === 0) break;
  }
}

// ==================== SERVER STARTUP ====================

const server = app.listen(CONFIG.server.port, CONFIG.server.host, () => {
  Logger.info(`Server running at http://${CONFIG.server.host}:${CONFIG.server.port}`);
  Logger.info(`Environment: ${CONFIG.server.environment}`);
  resourceMonitor.logMemoryUsage('Server started');
});

// WebSocket Server
const wss = new WebSocketServer({ 
  server,
  clientTracking: true,
  maxPayload: 10 * 1024 * 1024, // 10MB
  perMessageDeflate: {
    threshold: 1024,
    concurrencyLimit: 10
  }
});

wss.on('connection', (ws, req) => {
  const client = wsManager.addClient(ws, req);
  
  // Send initial state
  try {
    ws.send(JSON.stringify({ type: 'state_update', state: appState.transcription }));
    ws.send(JSON.stringify({ type: 'translation_state', state: appState.translation }));
  } catch (error) {
    Logger.error(`Error sending initial state to ${client.id}:`, error);
  }

  // Handle heartbeat
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
    client.lastActivity = Date.now();
  });

  // Handle messages
  ws.on('message', (rawMessage) => {
    wsManager.handleMessage(ws, rawMessage);
  });

  // Handle disconnection
  ws.on('close', (code, reason) => {
    Logger.info(`Client ${client.id} disconnected:`, { code, reason: reason?.toString() });
    wsManager.removeClient(ws);
    resourceMonitor.logMemoryUsage(`Client ${client.id} disconnect`);
  });

  ws.on('error', (error) => {
    Logger.error(`WebSocket error for ${client.id}:`, error);
    wsManager.removeClient(ws);
  });
});

// Start heartbeat
wsManager.startHeartbeat();

// ==================== GRACEFUL SHUTDOWN ====================

async function gracefulShutdown(signal) {
  Logger.info(`Received ${signal}. Shutting down gracefully...`);
  
  try {
    // Stop accepting new connections
    server.close();
    
    // Kill all active processes
    await processManager.killAllProcesses();
    
    // Close WebSocket connections
    wss.clients.forEach(client => client.terminate());
    
    // Clear file cache
    await clearFileCache();
    
    // Cleanup uploaded files
    if (uploadedFiles.size > 0) {
      await cleanupUploadedFiles(Array.from(uploadedFiles));
    }
    
    Logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    Logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  Logger.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  Logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit on unhandled rejections in production, but log them
  if (CONFIG.server.environment !== 'production') {
    gracefulShutdown('unhandledRejection');
  }
});

export { CONFIG, Logger, processManager, resourceMonitor, wsManager };