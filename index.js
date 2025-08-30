const MinecraftBot = require('./minecraft-bot');
const DiscordClient = require('./discord-client');
const config = require('./config');
const logger = require('./logger');

class MinecraftDiscordBridge {
    constructor() {
        this.minecraftBot = null;
        this.discordClient = null;
        this.isShuttingDown = false;
    }

    async initialize() {
        try {
            logger.info('Initializing Minecraft Discord Bridge...');

            // Initialize Discord client
            this.discordClient = new DiscordClient();
            await this.discordClient.connect();

            // Initialize Minecraft bot
            this.minecraftBot = new MinecraftBot(this.discordClient);
            
            // Capture console output for authentication prompts
            this.setupConsoleCapture();
            
            await this.minecraftBot.connect();

            // Setup graceful shutdown
            this.setupGracefulShutdown();

            logger.info('Minecraft Discord Bridge initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize bridge:', error);
            process.exit(1);
        }
    }

    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            if (this.isShuttingDown) return;
            this.isShuttingDown = true;

            logger.info(`Received ${signal}, shutting down gracefully...`);

            try {
                if (this.minecraftBot) {
                    await this.minecraftBot.disconnect();
                }
                if (this.discordClient) {
                    await this.discordClient.disconnect();
                }
                logger.info('Shutdown complete');
                process.exit(0);
            } catch (error) {
                logger.error('Error during shutdown:', error);
                process.exit(1);
            }
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('uncaughtException', (error) => {
            logger.error('Uncaught exception:', error);
            shutdown('uncaughtException');
        });
        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled rejection at:', promise, 'reason:', reason);
            shutdown('unhandledRejection');
        });
    }

    setupConsoleCapture() {
        const originalLog = console.log;
        const self = this;
        
        console.log = function(...args) {
            const message = args.join(' ');
            
            // Check for Microsoft authentication prompts
            if (message.includes('[msa] First time signing in') || 
                message.includes('To sign in, use a web browser')) {
                
                const codeMatch = message.match(/code ([A-Z0-9]+)/i);
                if (codeMatch) {
                    const authCode = codeMatch[1];
                    const authUrl = `https://www.microsoft.com/link?otc=${authCode}`;
                    logger.info(`Authentication prompt detected. Code: ${authCode}`);
                    self.discordClient.sendLoginEmbed(authCode, authUrl);
                }
            } else if (message.includes('[msa] Signed in with Microsoft')) {
                logger.info('Microsoft authentication successful');
                self.discordClient.sendStatusEmbed('\ud83d\udd11 Authenticated', 'Successfully signed in with Microsoft account', 0x00FF00);
            }
            
            // Call original console.log
            originalLog.apply(console, args);
        };
    }
}

// Start the application
const bridge = new MinecraftDiscordBridge();
bridge.initialize().catch((error) => {
    logger.error('Failed to start application:', error);
    process.exit(1);
});
