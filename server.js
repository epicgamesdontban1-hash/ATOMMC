const express = require('express');
const MinecraftBot = require('./minecraft-bot');
const DiscordClient = require('./discord-client');
const config = require('./config');
const logger = require('./logger');

console.log(`
██████╗  ██████╗  ██████╗  ██████╗  ██████╗ 
██╔══██╗██╔═══██╗██╔════╝ ██╔════╝ ██╔═══██╗
██║  ██║██║   ██║██║  ███╗██║  ███╗██║   ██║
██║  ██║██║   ██║██║   ██║██║   ██║██║   ██║
██████╔╝╚██████╔╝╚██████╔╝╚██████╔╝╚██████╔╝
╚═════╝  ╚═════╝  ╚═════╝  ╚═════╝  ╚═════╝ 
`);

class MinecraftDiscordBridge {
    constructor() {
        this.discordClient = null;
        this.minecraftBot = null;
        this.isShuttingDown = false;
        this.app = express();
        this.server = null;
        this.startTime = Date.now();
        this.authSent = false;
        
        // Setup web server IMMEDIATELY in constructor for Render.com
        this.setupWebServer();
    }

    async initialize() {
        try {
            logger.info('Initializing Minecraft Discord Bridge...');

            if (config.discord.enabled) {
                logger.info('Connecting to Discord...');
                this.discordClient = new DiscordClient();
                await this.discordClient.connect();
                await this.discordClient.setStatus('disconnected');
            } else {
                logger.info('Discord integration disabled - running in web-only mode');
                this.discordClient = null;
            }

            this.minecraftBot = new MinecraftBot(this.discordClient);

            if (this.discordClient) {
                this.discordClient.setMinecraftBot(this.minecraftBot);
            }

            this.setupConsoleCapture();

            logger.info('Starting Minecraft bot connection...');
            
            // Don't await - let connection happen in background
            // This prevents the app from crashing during authentication
            this.minecraftBot.connect().catch((error) => {
                const errorMsg = error?.message || error?.toString() || '';
                
                // Check if this is an authentication error
                if (errorMsg.includes('authenticate') || 
                    errorMsg.includes('sign in') || 
                    errorMsg.includes('First time signing in')) {
                    logger.info('Bot connection requires authentication - waiting for user to complete auth');
                    if (this.discordClient && this.discordClient.setStatus) {
                        this.discordClient.setStatus('authentication');
                    }
                } else {
                    logger.error('Bot connection error:', errorMsg);
                }
            });

            this.setupGracefulShutdown();
            logger.info('Minecraft Discord Bridge initialized successfully');
            logger.info('Bridge is ready - waiting for Minecraft authentication if needed');
            
        } catch (error) {
            logger.error('Failed to initialize bridge:', error);
            // Don't exit - keep web server running for health checks
            logger.info('Web server will continue running for health checks');
        }
    }

    setupConsoleCapture() {
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalInfo = console.info;
        const self = this;
        
        const captureAuth = function(message, method) {
            if (!self.authSent && message.includes('microsoft.com/link')) {
                const codeMatch = message.match(/code ([A-Z0-9]{8})/i) || message.match(/otc=([A-Z0-9]{8})/i);
                
                if (codeMatch && self.discordClient) {
                    self.authSent = true;
                    const authCode = codeMatch[1];
                    const authUrl = `https://www.microsoft.com/link?otc=${authCode}`;
                    originalLog(`✓ [${new Date().toLocaleTimeString('en-US', { hour12: false })}] Sending authentication to Discord - code: ${authCode}`);
                    self.discordClient.sendLoginEmbed(authCode, authUrl);
                }
            }
        };
        
        console.log = function(...args) {
            const message = args.join(' ');
            captureAuth(message, 'log');
            originalLog.apply(console, args);
        };
        
        console.warn = function(...args) {
            const message = args.join(' ');
            captureAuth(message, 'warn');
            originalWarn.apply(console, args);
        };
        
        console.info = function(...args) {
            const message = args.join(' ');
            captureAuth(message, 'info');
            originalInfo.apply(console, args);
        };
    }

    resetAuthFlag() {
        this.authSent = false;
        logger.debug('Authentication flag reset for re-authentication');
    }

    setupWebServer() {
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));

        this.app.get('/', (req, res) => {
            const status = this.getStatus();
            res.json(status);
        });

        this.app.get('/status', (req, res) => {
            const status = this.getStatus();
            res.json(status);
        });

        this.app.get('/players', (req, res) => {
            const players = this.minecraftBot && this.minecraftBot.players 
                ? Array.from(this.minecraftBot.players) 
                : [];
            res.json({
                count: players.length,
                players: players
            });
        });

        this.app.post('/message', (req, res) => {
            if (!this.minecraftBot || !this.minecraftBot.isConnected) {
                return res.status(503).json({
                    error: 'Bot not connected to Minecraft server'
                });
            }

            const { message } = req.body;
            if (!message) {
                return res.status(400).json({
                    error: 'Message required'
                });
            }

            try {
                this.minecraftBot.sendChatMessage(message);
                res.json({
                    success: true,
                    message: 'Message sent'
                });
            } catch (error) {
                res.status(500).json({
                    error: error.message
                });
            }
        });

        this.app.get('/health', (req, res) => {
            const health = this.minecraftBot && this.minecraftBot.bot
                ? {
                    health: this.minecraftBot.bot.health,
                    food: this.minecraftBot.bot.food,
                    position: this.minecraftBot.bot.entity?.position
                }
                : null;
            res.json({ 
                status: 'healthy',
                webServer: 'running',
                health 
            });
        });

        const PORT = process.env.PORT || 10000;
        this.server = this.app.listen(PORT, '0.0.0.0', () => {
            logger.info(`✓ Web server running on http://0.0.0.0:${PORT}`);
            logger.info(`✓ Health check endpoint ready at http://0.0.0.0:${PORT}/health`);
        });
    }

    getStatus() {
        const uptime = Math.floor((Date.now() - this.startTime) / 1000);
        const status = {
            server: {
                host: config.minecraft.host,
                port: config.minecraft.port,
                version: config.minecraft.version
            },
            bot: {
                connected: this.minecraftBot?.isConnected || false,
                username: this.minecraftBot?.detectedUsername || config.minecraft.username,
                state: this.minecraftBot?.connectionState || 'idle'
            },
            discord: {
                enabled: config.discord.enabled,
                connected: this.discordClient?.isConnected || false
            },
            uptime: uptime,
            players: this.minecraftBot && this.minecraftBot.players 
                ? Array.from(this.minecraftBot.players)
                : []
        };
        return status;
    }

    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            if (this.isShuttingDown) return;
            this.isShuttingDown = true;

            logger.info(`Received ${signal}, shutting down gracefully...`);

            try {
                if (this.server) {
                    this.server.close();
                }
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
            const errorStr = error?.toString() || '';
            const stackStr = error?.stack || '';
            let errorMsg = error?.message || error?.code || '';
            
            if (!errorMsg && typeof error === 'object') {
                try {
                    errorMsg = JSON.stringify(error, Object.getOwnPropertyNames(error));
                } catch (e) {
                    errorMsg = errorStr;
                }
            }
            
            if (errorStr.includes('unknown chat format code') || 
                stackStr.includes('ChatMessage.fromNetwork') ||
                stackStr.includes('prismarine-chat') ||
                errorStr.includes('PartialReadError') ||
                errorStr.includes('packet_world_particles')) {
                logger.warn('Ignoring non-critical parsing error:', errorMsg || 'chat format error');
                return;
            }
            
            logger.error('Uncaught exception:', error);
            logger.error('Stack:', error?.stack);
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            const reasonStr = reason?.toString() || '';
            
            if (reasonStr.includes('Connection timeout') ||
                reasonStr.includes('Connection ended') ||
                reasonStr.includes('ECONNREFUSED') ||
                reasonStr.includes('ENOTFOUND')) {
                logger.warn('Connection issue (will auto-reconnect):', reason?.message || reasonStr);
                return;
            }
            
            logger.error('Unhandled rejection:', reason);
            logger.error('Stack:', reason?.stack);
        });
    }
}

const bridge = new MinecraftDiscordBridge();
bridge.initialize().catch((error) => {
    logger.error('Failed to start application:', error);
    // Don't exit - web server is already running
    logger.info('Web server continues running despite initialization error');
});

module.exports = bridge;
