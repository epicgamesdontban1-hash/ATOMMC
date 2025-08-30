
const express = require('express');
const MinecraftBot = require('./minecraft-bot');
const DiscordClient = require('./discord-client');
const config = require('./config');
const logger = require('./logger');

// Suppress specific console errors from packet parsing
const originalConsoleError = console.error;
console.error = function(...args) {
    const message = args.join(' ');
    if (message.includes('PartialReadError') || 
        message.includes('packet_world_particles') || 
        message.includes('Particle') ||
        message.includes('protodef/src/compiler.js') ||
        message.includes('CompiledProtodef.read') ||
        message.includes('ExtendableError') ||
        message.includes('Read error for undefined') ||
        message.includes('f32') ||
        message.includes('numeric.js') ||
        message.includes('eval at compile')) {
        // Silently ignore these packet parsing errors
        return;
    }
    originalConsoleError.apply(console, args);
};

// Override console.trace as well since some errors use it
const originalConsoleTrace = console.trace;
console.trace = function(...args) {
    const message = args.join(' ');
    if (message.includes('PartialReadError') || 
        message.includes('packet_world_particles') || 
        message.includes('Particle') ||
        message.includes('protodef/src/compiler.js')) {
        return;
    }
    originalConsoleTrace.apply(console, args);
};

// Also suppress uncaught exceptions from these specific errors
process.on('uncaughtException', (error) => {
    const errorStr = error.toString();
    const stackStr = error.stack ? error.stack.toString() : '';
    if (errorStr.includes('PartialReadError') || 
        errorStr.includes('packet_world_particles') || 
        errorStr.includes('Particle') ||
        errorStr.includes('protodef/src/compiler.js') ||
        stackStr.includes('numeric.js') ||
        stackStr.includes('f32') ||
        stackStr.includes('eval at compile')) {
        // Silently ignore packet parsing uncaught exceptions
        return;
    }
    logger.error('Uncaught exception:', error);
});

class MinecraftDiscordBridge {
    constructor() {
        this.discordClient = null;
        this.minecraftBot = null;
        this.isShuttingDown = false;
        this.app = express();
        this.server = null;
    }

    async initialize() {
        try {
            logger.info('Initializing Minecraft Discord Bridge...');

            // Setup simple web server
            this.setupWebServer();

            // Initialize Discord client
            this.discordClient = new DiscordClient();
            await this.discordClient.connect();

            // Initialize Minecraft bot
            this.minecraftBot = new MinecraftBot(this.discordClient);

            // Setup console capture for authentication prompts
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

    setupWebServer() {
        // Simple status endpoint
        this.app.get('/', (req, res) => {
            const isOnline = this.minecraftBot && this.minecraftBot.isConnected;
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Minecraft Bot Status</title>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            text-align: center;
                            margin-top: 50px;
                            background-color: #f0f0f0;
                        }
                        .status {
                            font-size: 48px;
                            font-weight: bold;
                            padding: 20px;
                            border-radius: 10px;
                            display: inline-block;
                            margin: 20px;
                        }
                        .online {
                            color: #00ff00;
                            background-color: #004400;
                        }
                        .offline {
                            color: #ff0000;
                            background-color: #440000;
                        }
                    </style>
                </head>
                <body>
                    <h1>Minecraft Bot Status</h1>
                    <div class="status ${isOnline ? 'online' : 'offline'}">
                        ${isOnline ? 'ONLINE' : 'OFFLINE'}
                    </div>
                    <p>Server: ${config.minecraft.host}:${config.minecraft.port}</p>
                    <p>Username: ${config.minecraft.username}</p>
                </body>
                </html>
            `);
        });

        // Start web server
        const PORT = process.env.PORT || 5000;
        this.server = this.app.listen(PORT, '0.0.0.0', () => {
            logger.info(`Web server running on port ${PORT}`);
        });
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
                if (this.server) {
                    this.server.close();
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
                message.includes('To sign in, use a web browser') ||
                message.includes('microsoft.com/link')) {

                logger.info('🔍 DEBUG: Authentication message detected in console:', message);

                const codeMatch = message.match(/code ([A-Z0-9]+)/i);
                if (codeMatch) {
                    const authCode = codeMatch[1];
                    const authUrl = `https://www.microsoft.com/link?otc=${authCode}`;
                    logger.info(`🔑 Authentication prompt detected. Code: ${authCode}, URL: ${authUrl}`);

                    // Debug Discord client state
                    logger.info('🔍 DEBUG: Discord client state check:');
                    logger.info(`  - Discord client exists: ${!!self.discordClient}`);
                    logger.info(`  - Discord client connected: ${self.discordClient?.isConnected}`);
                    logger.info(`  - Discord channels object: ${!!self.discordClient?.channels}`);
                    logger.info(`  - Login channel exists: ${!!self.discordClient?.channels?.login}`);
                    logger.info(`  - Login channel name: ${self.discordClient?.channels?.login?.name}`);
                    logger.info(`  - Login channel ID: ${self.discordClient?.channels?.login?.id}`);

                    // Force send to Discord immediately
                    if (self.discordClient && self.discordClient.channels && self.discordClient.channels.login) {
                        logger.info('📤 Sending authentication embed to Discord login channel...');
                        self.discordClient.sendLoginEmbed(authCode, authUrl).then(() => {
                            logger.info('✅ Authentication embed sent successfully to Discord!');
                        }).catch((error) => {
                            logger.error('❌ Failed to send authentication embed to Discord:', error);
                            logger.error('❌ Error details:', error.stack || error.message || error);
                        });
                    } else {
                        logger.warn('⚠️ Discord login channel not available, queuing message');
                        logger.info('🔍 DEBUG: Attempting to queue message...');
                        if (self.discordClient && self.discordClient.messageQueue) {
                            logger.info('✅ Message queue exists, adding auth embed to queue');
                            self.discordClient.messageQueue.push({
                                embed: {
                                    color: 0xFF9900,
                                    title: '🔑 Microsoft Authentication Required',
                                    description: 'Please authenticate your Minecraft account to continue',
                                    fields: [
                                        { name: '🌐 Authentication URL', value: `[Click here to authenticate](${authUrl})`, inline: false },
                                        { name: '🔢 Authentication Code', value: `\`\`\`${authCode}\`\`\``, inline: false },
                                        { name: '📝 Instructions', value: '1. Click the link above\n2. Enter the code shown\n3. Sign in with your Minecraft account', inline: false }
                                    ],
                                    timestamp: new Date().toISOString(),
                                    footer: { text: 'One-time authentication' }
                                },
                                channelType: 'login'
                            });
                        }
                    }
                }
            } else if (message.includes('[msa] Signed in with Microsoft')) {
                logger.info('Microsoft authentication successful');
                self.discordClient.sendStatusEmbed('🔑 Authenticated', 'Successfully signed in with Microsoft account', 0x00FF00);
            }

            // Call original console.log
            originalLog.apply(console, args);
        };
    }
}

// Start the bridge
const bridge = new MinecraftDiscordBridge();
bridge.initialize().catch((error) => {
    logger.error('Failed to start bridge:', error);
    process.exit(1);
});
