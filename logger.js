const config = require('./config');

class Logger {
    constructor() {
        this.logLevel = this.getLogLevel(config.logging.level);
        this.enableConsole = config.logging.console;
    }

    getLogLevel(level) {
        const levels = {
            'error': 0,
            'warn': 1,
            'info': 2,
            'debug': 3
        };
        return levels[level.toLowerCase()] || 2;
    }

    formatMessage(level, message, ...args) {
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        const formattedArgs = args.map(arg => 
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg
        );
        const levelEmoji = {
            'ERROR': '❌',
            'WARN': '⚠️ ',
            'INFO': '📝',
            'DEBUG': '🔍'
        };
        return `${levelEmoji[level.toUpperCase()] || '📝'} [${timestamp}] ${message}${formattedArgs.length > 0 ? ' ' + formattedArgs.join(' ') : ''}`;
    }

    log(level, levelNum, message, ...args) {
        if (levelNum <= this.logLevel && this.enableConsole) {
            const formattedMessage = this.formatMessage(level, message, ...args);
            console.log(formattedMessage);
        }
    }

    error(message, ...args) {
        this.log('error', 0, message, ...args);
    }

    warn(message, ...args) {
        this.log('warn', 1, message, ...args);
    }

    info(message, ...args) {
        this.log('info', 2, message, ...args);
    }

    debug(message, ...args) {
        this.log('debug', 3, message, ...args);
    }
}

module.exports = new Logger();
