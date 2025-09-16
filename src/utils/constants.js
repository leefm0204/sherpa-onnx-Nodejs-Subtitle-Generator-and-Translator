// src/utils/constants.js - Centralized configuration constants
export const CONFIG = {
  // Server configuration
  SERVER: {
    PORT: process.env.PORT || 3000,
    HOST: process.env.HOST || 'localhost',
    MAX_FILE_SIZE: 500 * 1024 * 1024, // 500MB
    UPLOAD_TIMEOUT: 30 * 60 * 1000, // 30 minutes
  },

  // Audio processing configuration
  AUDIO: {
    SAMPLE_RATE: 16000,
    FEAT_DIM: 80,
    BUFFER_SIZE_SECONDS: 5,
    MAX_CONCURRENT: Math.max(1, require('os').cpus().length - 1),
  },

  // VAD configuration
  VAD: {
    THRESHOLD: 0.5,
    MIN_SPEECH_DURATION: 0.25,
    MIN_SILENCE_DURATION: 0.5,
    WINDOW_SIZE: 512,
    SAMPLE_RATE: 16000,
    DEBUG: false,
    NUM_THREADS: 1,
  },

  // Memory management
  MEMORY: {
    MAX_HEAP_MB: 1024,
    GC_INTERVAL: 10000,
    CLEANUP_INTERVAL: 10 * 60 * 1000, // 10 minutes
    MAX_UPLOAD_AGE: 30 * 60 * 1000, // 30 minutes
  },

  // Translation configuration
  TRANSLATION: {
    CHUNK_SIZE: 1000,
    REQUEST_GAP: 1200,
    CACHE_TTL: 24 * 60 * 60, // 24 hours
    MAX_RETRIES: 3,
    RETRY_DELAY: 2000,
  },

  // File paths
  PATHS: {
    TEMP_DIR: '/tmp/sherpa-temp',
    UPLOADS_DIR: './uploads',
    DOWNLOAD_DIR: process.env.DOWNLOAD_DIR || '/sdcard/Download',
    CACHE_DIR: '/tmp/genfast-cache',
    CACHE_FILE: './cache.json',
  },

  // Supported file extensions
  SUPPORTED_EXTENSIONS: new Set([
    '.wav', '.mp3', '.flac', '.m4a', '.ogg',
    '.mp4', '.mkv', '.mov', '.avi', '.webm'
  ]),
};

export const WEBSOCKET_EVENTS = {
  TRANSCRIPTION_START: 'transcription_start',
  TRANSCRIPTION_PROGRESS: 'transcription_progress',
  TRANSCRIPTION_COMPLETE: 'transcription_complete',
  TRANSCRIPTION_ERROR: 'transcription_error',
  TRANSLATION_START: 'translation_start',
  TRANSLATION_PROGRESS: 'translation_progress',
  TRANSLATION_COMPLETE: 'translation_complete',
  TRANSLATION_ERROR: 'translation_error',
  SYSTEM_INFO: 'system_info',
  PROCESS_CANCELLED: 'process_cancelled',
};

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};