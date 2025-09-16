// logger.js - Universal logging utility for both browser and Node.js environments
// Uses chalk for colored output in Node.js and falls back to plain console in browser

/**
 * Check if we're running in a browser environment
 * @returns {boolean}
 */
function isBrowser() {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

/**
 * Check if we're running in development mode
 * @returns {boolean}
 */
function isDevelopment() {
  if (isBrowser()) {
    return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  } else {
    return process.env.NODE_ENV === 'development';
  }
}

/**
 * Get chalk instance (Node.js only) or fallback to identity function (browser)
 * @returns {Object|undefined}
 */
async function getChalk() {
  if (isBrowser()) {
    // In browser, return undefined to skip chalk
    return undefined;
  } else {
    try {
      // In Node.js, try to import chalk
      const chalkModule = await import('chalk');
      return chalkModule.default;
    } catch (error) {
      // If chalk is not available, return undefined
      // Log error in development mode only
      if (isDevelopment()) {
        console.warn('Failed to load chalk module:', error.message);
      }
      return undefined;
    }
  }
}

// Initialize chalk instance
let chalk;
getChalk().then(loadedChalk => {
  chalk = loadedChalk;
}).catch(() => {
  chalk = undefined;
});

/**
 * Apply color to text if chalk is available
 * @param {string|undefined} color - Color function name
 * @param {string} text - Text to colorize
 * @returns {string} - Colorized text or original text
 */
function applyColor(color, text) {
  if (chalk && color && typeof chalk[color] === 'function') {
    return chalk[color](text);
  }
  return text;
}

/**
 * Standardized logging utility with consistent formatting for both browser and Node.js
 */
class Logger {
  /**
   * Log a standard info message
   * @param {string} component - Component name (e.g., 'SERVER', 'UPLOAD', 'TRANSCRIBE')
   * @param {string} message - Message to log
   * @param {...any} args - Additional arguments to log
   */
  static log(component, message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${component}] ${message}`, ...args);
  }

  /**
   * Log a warning message
   * @param {string} component - Component name
   * @param {string} message - Warning message
   * @param {...any} args - Additional arguments to log
   */
  static warn(component, message, ...args) {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] [${component}] WARN: ${message}`, ...args);
  }

  /**
   * Log an error message
   * @param {string} component - Component name
   * @param {string} message - Error message
   * @param {...any} args - Additional arguments to log
   */
  static error(component, message, ...args) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [${component}] ERROR: ${message}`, ...args);
  }

  /**
   * Log a debug message (only in development)
   * @param {string} component - Component name
   * @param {string} message - Debug message
   * @param {...any} args - Additional arguments to log
   */
  static debug(component, message, ...args) {
    if (isDevelopment()) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [${component}] DEBUG: ${message}`, ...args);
    }
  }

  /**
   * Log a success message with green color in Node.js, plain in browser
   * @param {string} component - Component name
   * @param {string} message - Success message
   * @param {...any} args - Additional arguments to log
   */
  static success(component, message, ...args) {
    const timestamp = new Date().toISOString();
    const formattedMessage = applyColor('green', `[${timestamp}] [${component}] SUCCESS: ${message}`);
    console.log(formattedMessage, ...args);
  }

  /**
   * Log a process start message with blue color in Node.js, plain in browser
   * @param {string} component - Component name
   * @param {string} processName - Name of the process
   * @param {string} details - Additional details
   */
  static processStart(component, processName, details = '') {
    const timestamp = new Date().toISOString();
    const formattedMessage = applyColor('blue', `[${timestamp}] [${component}] STARTING: ${processName}`);
    console.log(formattedMessage, details);
  }

  /**
   * Log a process completion message with green color in Node.js, plain in browser
   * @param {string} component - Component name
   * @param {string} processName - Name of the process
   * @param {string} details - Additional details
   */
  static processComplete(component, processName, details = '') {
    const timestamp = new Date().toISOString();
    const formattedMessage = applyColor('green', `[${timestamp}] [${component}] COMPLETED: ${processName}`);
    console.log(formattedMessage, details);
  }

  /**
   * Log a process error message with red color in Node.js, plain in browser
   * @param {string} component - Component name
   * @param {string} processName - Name of the process
   * @param {string} error - Error details
   */
  static processError(component, processName, error) {
    const timestamp = new Date().toISOString();
    const formattedMessage = applyColor('red', `[${timestamp}] [${component}] FAILED: ${processName}`);
    console.error(formattedMessage, `- ${error}`);
  }
}

// Export Logger for Node.js modules
export default Logger;

// Make Logger available globally in browser environments
if (isBrowser()) {
  window.Logger = Logger;
}