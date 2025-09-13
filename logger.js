// logger.js - Standardized logging utility
const chalk = (await import('chalk')).default;

/**
 * Standardized logging utility with consistent formatting
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
    if (process.env.NODE_ENV === 'development') {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [${component}] DEBUG: ${message}`, ...args);
    }
  }

  /**
   * Log a success message with green color
   * @param {string} component - Component name
   * @param {string} message - Success message
   * @param {...any} args - Additional arguments to log
   */
  static success(component, message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(chalk.green(`[${timestamp}] [${component}] SUCCESS: ${message}`), ...args);
  }

  /**
   * Log a process start message
   * @param {string} component - Component name
   * @param {string} processName - Name of the process
   * @param {string} details - Additional details
   */
  static processStart(component, processName, details = '') {
    const timestamp = new Date().toISOString();
    console.log(chalk.blue(`[${timestamp}] [${component}] STARTING: ${processName}`), details);
  }

  /**
   * Log a process completion message
   * @param {string} component - Component name
   * @param {string} processName - Name of the process
   * @param {string} details - Additional details
   */
  static processComplete(component, processName, details = '') {
    const timestamp = new Date().toISOString();
    console.log(chalk.green(`[${timestamp}] [${component}] COMPLETED: ${processName}`), details);
  }

  /**
   * Log a process error message
   * @param {string} component - Component name
   * @param {string} processName - Name of the process
   * @param {string} error - Error details
   */
  static processError(component, processName, error) {
    const timestamp = new Date().toISOString();
    console.error(chalk.red(`[${timestamp}] [${component}] FAILED: ${processName}`), `- ${error}`);
  }
}

export default Logger;