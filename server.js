// server-ultra-simple.js - Pure connection layer, delegates everything to CLI tools
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { uploadSingleFile } from './fileupload.js';

// __dirname helper for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Basic middleware
app.use(express.static('.'));
app.use(express.json());

// WebSocket clients
const clients = new Set();

// Active processes (just for tracking, CLI handles everything)
const activeProcesses = new Map();

// Broadcast to all WebSocket clients
function broadcast(message) {
  const payload = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === client.OPEN) {
      try {
        client.send(payload);
      } catch {
        clients.delete(client);
      }
    }
  });
}

// Force kill a process with escalating signals
function forceKillProcess(process, processId) {
  if (!process || process.killed) {
    activeProcesses.delete(processId);
    return;
  }

  console.log(`Terminating process ${process.pid} (${processId})...`);
  
  try {
    // First try SIGTERM
    process.kill('SIGTERM');
    
    // If process doesn't exit in 2 seconds, use SIGKILL
    const forceKillTimeout = setTimeout(() => {
      if (!process.killed) {
        console.log(`Force killing process ${process.pid} with SIGKILL...`);
        try {
          process.kill('SIGKILL');
        } catch (_error) {
          console.error(`Failed to SIGKILL process ${process.pid}:`, _error.message);
        }
      }
    }, 2000);
    
    // Clean up when process actually exits
    process.on('exit', () => {
      clearTimeout(forceKillTimeout);
      activeProcesses.delete(processId);
      console.log(`Process ${process.pid} (${processId}) terminated`);
    });
    
  } catch (error) {
    console.error(`Error killing process ${process.pid}:`, error.message);
    activeProcesses.delete(processId);
  }
}

// Spawn CLI process and handle its output
function spawnCliProcess(command, args, type, filename) {
  console.log(`[SPAWN] Starting ${type} process for ${filename}`);
  console.log(`[SPAWN] Command: node ${command} ${args.join(' ')}`);
  
  const childProcess = spawn('node', [command, ...args], {
    cwd: __dirname,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: path.join(__dirname, 'node_modules', 'sherpa-onnx-linux-arm64') + ':' + (process.env.LD_LIBRARY_PATH || '')
    }
  });

  const processId = `${type}_${Date.now()}`;
  activeProcesses.set(processId, { process: childProcess, type, filename });
  
  console.log(`[SPAWN] Process started with PID: ${childProcess.pid}, ID: ${processId}`);

  // Forward CLI output to WebSocket clients AND terminal
  if (childProcess.stdout) {
    childProcess.stdout.on('data', (data) => {
      const output = data.toString();
      
      // Show output in server terminal with process info
      console.log(`[${type.toUpperCase()}:${filename}] ${output.trim()}`);
      
      // Send to WebSocket clients
      broadcast({ type: 'debug_output', output, filename, processType: type });
      
      // Parse detailed progress from gensrt.js output
      // Look for progress bar format: "   ████████████████████████████████████████ | 45% | Time: 12.3/27.8s | Speed: 1.2x"
      const progressMatch = output.match(/\|\s*(\d+)%\s*\|\s*Time:\s*([\d.]+)\/([\d.]+)s\s*\|\s*Speed:\s*([\d.]+|N\/A)x/);
      if (progressMatch) {
        const progress = parseInt(progressMatch[1]);
        const timeUsed = parseFloat(progressMatch[2]);
        const timeRemaining = parseFloat(progressMatch[3]);
        const speed = progressMatch[4] === 'N/A' ? 'N/A' : parseFloat(progressMatch[4]);
        
        console.log(`[PROGRESS:${filename}] ${progress}% | Elapsed: ${timeUsed}s | Remaining: ${timeRemaining}s | Speed: ${speed}x`);
        
        broadcast({ 
          type: 'transcription_progress', 
          filename, 
          progress,
          processed: timeUsed,
          duration: timeUsed + timeRemaining,
          elapsed: timeUsed,
          remaining: timeRemaining,
          speed
        });
      }
      
      // Also parse Logger output for additional info
      // Look for "Starting: filename" messages
      if (output.includes('[TRANSCRIBE] Starting:')) {
        const startMatch = output.match(/\[TRANSCRIBE\]\s*Starting:\s*(.+)/);
        if (startMatch) {
          const startedFile = startMatch[1].trim();
          console.log(`[START] Transcription started for: ${startedFile}`);
          broadcast({ type: 'file_start', filename: startedFile });
        }
      }
      
      // Look for "Done! Output:" messages
      if (output.includes('[TRANSCRIBE] Done! Output:')) {
        const doneMatch = output.match(/\[TRANSCRIBE\]\s*Done!\s*Output:\s*(.+)/);
        if (doneMatch) {
          const srtPath = doneMatch[1].trim();
          console.log(`[COMPLETE] Transcription completed for ${filename}: ${srtPath}`);
          broadcast({ type: 'file_complete', filename, srtPath });
        }
      }
      
      // Look for "SRT file saved to:" messages
      if (output.includes('SRT file saved to:')) {
        const srtMatch = output.match(/SRT file saved to:\s*(.+)/);
        if (srtMatch) {
          const srtPath = srtMatch[1].trim();
          console.log(`[SAVED] SRT file saved for ${filename}: ${srtPath}`);
          broadcast({ type: 'file_complete', filename, srtPath });
        }
      }
      
      // Look for error messages
      if (output.includes('[TRANSCRIBE] Error') || output.includes('Error:')) {
        console.log(`[ERROR:${filename}] ${output.trim()}`);
        broadcast({ type: 'file_error', filename, error: output.trim() });
      }
    });
  }

  if (childProcess.stderr) {
    childProcess.stderr.on('data', (data) => {
      const errorOutput = data.toString();
      
      // Show error output in server terminal
      console.error(`[${type.toUpperCase()}:${filename}:ERROR] ${errorOutput.trim()}`);
      
      // Send to WebSocket clients
      broadcast({ type: 'debug_output', output: errorOutput, filename, processType: type, isError: true });
      
      // If it's a critical error, mark the file as failed
      if (errorOutput.includes('Error:') || errorOutput.includes('Failed')) {
        broadcast({ type: 'file_error', filename, error: errorOutput.trim() });
      }
    });
  }

  childProcess.on('close', (code) => {
    activeProcesses.delete(processId);
    
    if (code === 0) {
      console.log(`[CLOSE] ${type} process completed successfully for ${filename} (PID: ${childProcess.pid})`);
      // Don't send generic completion here, let the output parsing handle it
      // This prevents duplicate messages
    } else {
      console.log(`[CLOSE] ${type} process failed for ${filename} with exit code ${code} (PID: ${childProcess.pid})`);
      broadcast({ 
        type: type === 'transcription' ? 'file_error' : 'translation_error', 
        filename, 
        error: `Process failed with code ${code}` 
      });
    }
  });

  childProcess.on('error', (error) => {
    activeProcesses.delete(processId);
    console.error(`[ERROR] ${type} process error for ${filename}: ${error.message}`);
    broadcast({ 
      type: type === 'transcription' ? 'file_error' : 'translation_error', 
      filename, 
      error: error.message 
    });
  });

  return processId;
}

// File upload endpoint
app.post('/api/upload', uploadSingleFile('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const filename = req.file.originalname || path.basename(req.file.path);
  
  // Start transcription using gensrt.js CLI
  spawnCliProcess('gensrt.js', [req.file.path, '--model', 'senseVoice', '--uploaded'], 'transcription', filename);
  
  broadcast({ type: 'file_start', filename });
  
  res.json({ 
    message: 'File uploaded successfully',
    filePath: req.file.path 
  });
});

// SRT upload endpoint
app.post('/api/upload-srt', uploadSingleFile('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  if (!req.file.originalname.toLowerCase().endsWith('.srt')) {
    return res.status(400).json({ error: 'Only SRT files allowed' });
  }
  
  const filename = req.file.originalname || path.basename(req.file.path);
  const sourceLang = req.body.sourceLang || 'auto';
  const targetLang = req.body.targetLang || 'en';
  
  // Start translation using srt-gtk.js CLI
  spawnCliProcess('srt-gtk.js', [req.file.path, sourceLang, targetLang], 'translation', filename);
  
  broadcast({ type: 'translation_start', filename });
  
  res.json({ 
    message: 'SRT file uploaded successfully',
    filePath: req.file.path 
  });
});

// Transcription endpoint
app.post('/api/start', (req, res) => {
  const { inputPath, model = 'senseVoice' } = req.body;

  if (!inputPath) {
    return res.status(400).json({ error: 'File path required' });
  }

  const filename = path.basename(inputPath);
  
  // Start transcription using gensrt.js CLI
  spawnCliProcess('gensrt.js', [inputPath, '--model', model], 'transcription', filename);
  
  broadcast({ type: 'file_start', filename });

  res.json({ success: true, message: 'Transcription started' });
});

// Translation endpoint
app.post('/api/translate', (req, res) => {
  const { srtPath, sourceLang, targetLang } = req.body;
  
  if (!srtPath || !sourceLang || !targetLang) {
    return res.status(400).json({ error: 'SRT path, source and target languages required' });
  }

  const filename = path.basename(srtPath);
  
  // Start translation using srt-gtk.js CLI
  spawnCliProcess('srt-gtk.js', [srtPath, sourceLang, targetLang], 'translation', filename);
  
  broadcast({ type: 'translation_start', filename });

  res.json({ success: true, message: 'Translation started' });
});

// Language data endpoint
app.get('/language.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'language.json'));
});

// System info endpoint
app.get('/system-info', (req, res) => {
  const memoryUsage = process.memoryUsage();
  res.json({
    memory: {
      rss: Math.round(memoryUsage.rss / 1024 / 1024),
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      external: Math.round(memoryUsage.external / 1024 / 1024)
    }
  });
});

// Create HTTP server
const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.add(ws);
  
  // Handle incoming WebSocket messages
  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      
      // Handle stop commands by killing processes
      if (message.type === 'stop_transcription' || message.type === 'stop_process') {
        let stoppedCount = 0;
        for (const [id, { process, type }] of activeProcesses.entries()) {
          if (type === 'transcription') {
            forceKillProcess(process, id);
            stoppedCount++;
          }
        }
        broadcast({ type: 'info', message: `Transcription stopped (${stoppedCount} processes terminated)` });
      }
      
      if (message.type === 'stop_translation') {
        let stoppedCount = 0;
        for (const [id, { process, type }] of activeProcesses.entries()) {
          if (type === 'translation') {
            forceKillProcess(process, id);
            stoppedCount++;
          }
        }
        broadcast({ type: 'info', message: `Translation stopped (${stoppedCount} processes terminated)` });
      }
      
      if (message.type === 'clear_files') {
        // Clear all active transcription processes
        for (const [id, { process, type }] of activeProcesses.entries()) {
          if (type === 'transcription') {
            forceKillProcess(process, id);
          }
        }
        broadcast({ type: 'files_cleared' });
      }
      
      if (message.type === 'clear_translation') {
        // Clear all active translation processes
        for (const [id, { process, type }] of activeProcesses.entries()) {
          if (type === 'translation') {
            forceKillProcess(process, id);
          }
        }
        broadcast({ type: 'translation_cleared' });
      }
      
      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
      
    } catch {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });
  
  // Clean up on disconnect
  ws.on('close', () => {
    clients.delete(ws);
  });
  
  ws.on('error', () => {
    clients.delete(ws);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  
  // Kill all active processes
  for (const [, { process }] of activeProcesses.entries()) {
    process.kill('SIGTERM');
  }
  
  // Give processes time to terminate before closing server
  setTimeout(() => {
    server.close(() => {
      process.exit(0);
    });
  }, 3000);
});

process.on('SIGTERM', () => {
  process.emit('SIGINT');
});
