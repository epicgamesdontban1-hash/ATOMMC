const mineflayer = require('mineflayer');
const { Authflow, Titles } = require('prismarine-auth');
const config = require('./config');
const logger = require('./logger');
const fetch = require('node-fetch');

class MinecraftBot {
    constructor(discordClient, bridge = null) {
        this.bot = null;
        this.discordClient = discordClient;
        this.bridge = bridge;
        this.reconnectAttempts = 0;
        this.isConnected = false;
        this.isReconnecting = false;
        this.afkInterval = null;
        this.players = new Set();
    }

    async connect() {
        try {
            logger.info('Connecting to Minecraft server...');

            // Setup Microsoft authentication
            const authflow = new Authflow(config.minecraft.username, './cache');

            const botOptions = {
                host: config.minecraft.host,
                port: config.minecraft.port,
                username: config.minecraft.username,
                version: config.minecraft.version,
                auth: 'microsoft',
                authflow: authflow
            };

            this.bot = mineflayer.createBot(botOptions);

            // Add error handling for the underlying client to catch packet parsing errors
            this.bot._client.on('error', (error) => {
                const errorStr = error.toString();
                if (errorStr.includes('PartialReadError') || 
                    errorStr.includes('packet_world_particles') || 
                    errorStr.includes('Particle') ||
                    errorStr.includes('protodef/src/compiler.js') ||
                    errorStr.includes('CompiledProtodef.read') ||
                    errorStr.includes('ExtendableError') ||
                    errorStr.includes('Read error for undefined')) {
                    // Silently ignore packet parsing errors - these are protocol mismatches
                    return;
                }
                logger.error('Client error:', error);
            });

            this.setupEventHandlers();

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Connection timeout - server may be offline or unreachable'));
                }, 60000); // Increased timeout for authentication

                this.bot.once('spawn', () => {
                    clearTimeout(timeout);
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    logger.info(`Successfully connected to ${config.minecraft.host}:${config.minecraft.port}`);
                    resolve();
                });

                this.bot.once('error', (error) => {
                    clearTimeout(timeout);
                    logger.error('Bot connection error:', error.message || error);
                    reject(error);
                });

                this.bot.once('end', (reason) => {
                    clearTimeout(timeout);
                    if (!this.isConnected) {
                        logger.error('Connection ended before spawn:', reason);
                        reject(new Error(`Connection ended: ${reason}`));
                    }
                });
            });
        } catch (error) {
            const errorStr = error.toString();

            // Check if this is an authentication prompt
            if (errorStr.includes('To sign in, use a web browser') || errorStr.includes('microsoft.com/link')) {
                const codeMatch = errorStr.match(/code ([A-Z0-9]+)/i);
                if (codeMatch) {
                    const authCode = codeMatch[1];
                    const authUrl = `https://www.microsoft.com/link?otc=${authCode}`;
                    logger.info(`Authentication required. Code: ${authCode}`);
                    this.discordClient.sendLoginEmbed(authCode, authUrl);

                    // Also set auth data on web server if bridge reference exists
                    if (this.bridge && typeof this.bridge.setAuthData === 'function') {
                        this.bridge.setAuthData(authCode, authUrl);
                    }
                }
            }

            // Check for common connection issues
            if (errorStr.includes('ENOTFOUND') || errorStr.includes('ECONNREFUSED')) {
                logger.error('Server connection failed - server may be offline or unreachable');
                this.discordClient.sendStatusEmbed('❌ Connection Failed', `Cannot reach ${config.minecraft.host}:${config.minecraft.port} - server may be offline`, 0xFF0000);
            } else if (errorStr.includes('Connection timeout')) {
                logger.error('Connection timeout - server is not responding');
                this.discordClient.sendStatusEmbed('⏰ Connection Timeout', 'Server is not responding - may be overloaded or offline', 0xFF0000);
            } else {
                logger.error('Failed to connect to Minecraft server:', error.message || error);
                this.discordClient.sendStatusEmbed('❌ Connection Error', `Connection failed: ${error.message || 'Unknown error'}`, 0xFF0000);
            }

            if (error.stack) {
                logger.debug('Error stack:', error.stack);
            }
            throw error;
        }
    }

    setupEventHandlers() {
        // Connection events
        this.bot.on('spawn', () => {
            logger.info(`Bot spawned in world: ${this.bot.game.dimension}`);
            this.discordClient.sendStatusEmbed('Connected', `Bot is now online on ${config.minecraft.host}`, 0x00FF00);

            // Add bot to player list when it joins
            this.players.add(this.bot.username);

            // Initialize player list
            this.initializePlayerList();

            // Start anti-AFK behavior only if enabled
            if (config.minecraft.enableAntiAfk) {
                this.startAntiAfk();
                logger.info('Anti-AFK system enabled');
            } else {
                logger.info('Anti-AFK system disabled by configuration');
            }
        });

        this.bot.on('end', (reason) => {
            this.isConnected = false;
            this.stopAntiAfk(); // Stop anti-AFK when disconnected
            logger.warn(`Bot disconnected: ${reason}`);
            this.discordClient.sendStatusEmbed('Disconnected', `Bot lost connection: ${reason}`, 0xFF0000);

            if (!this.isReconnecting) {
                this.handleReconnect();
            }
        });

        this.bot.on('error', (error) => {
            // Filter out common packet parsing errors that spam the console
            const errorStr = error.toString();
            if (errorStr.includes('PartialReadError') || 
                errorStr.includes('packet_world_particles') || 
                errorStr.includes('Particle') ||
                errorStr.includes('protodef/src/compiler.js') ||
                errorStr.includes('CompiledProtodef.read') ||
                errorStr.includes('ExtendableError') ||
                errorStr.includes('Read error for undefined')) {
                // Silently ignore packet parsing errors - these are protocol mismatches
                return;
            }

            logger.error('Bot error:', error);
            this.discordClient.sendStatusEmbed('Error', `Bot encountered an error: ${error.message}`, 0xFF0000);
        });

        this.bot.on('kicked', (reason, loggedIn) => {
            logger.warn(`Bot was kicked: ${reason}`);
            this.discordClient.sendStatusEmbed('Kicked', `Bot was kicked from server: ${reason}`, 0xFFAA00);
        });

        // Chat events - this is the main functionality
        this.bot.on('messagestr', (message, messagePosition, jsonMsg, sender, verified) => {
            this.handleChatMessage(message, messagePosition, jsonMsg, sender);
        });

        this.bot.on('whisper', (username, message, translate, jsonMsg, matches) => {
            logger.info(`Whisper from ${username}: ${message}`);
            this.discordClient.sendChatMessage(username, `**Whisper to ${this.bot.username}:** ${message}`, false);
        });

        // Health and game events
        this.bot.on('health', () => {
            if (this.bot.health <= 0) {
                logger.warn('Bot died, respawning...');
                this.bot.respawn();
                this.discordClient.sendStatusEmbed('Respawned', 'Bot died and has been respawned', 0xFFAA00);
            }
        });

        this.bot.on('death', () => {
            logger.info('Bot died');
            this.discordClient.sendStatusEmbed('Died', 'Bot has died in-game', 0xFF0000);
        });

        // Login sequence
        this.bot.on('login', () => {
            logger.info(`Logged in as ${this.bot.username}`);
        });

        // Player join/leave events
        this.bot.on('playerJoined', (player) => {
            this.players.add(player.username);
            logger.info(`Player joined: ${player.username}`);
            this.updatePlayerList();
        });

        this.bot.on('playerLeft', (player) => {
            this.players.delete(player.username);
            logger.info(`Player left: ${player.username}`);
            this.updatePlayerList();
        });

        // Handle authentication prompts
        this.bot._client.on('msa', (data) => {
            if (data.user_code && data.verification_uri) {
                const authUrl = `${data.verification_uri}?otc=${data.user_code}`;
                logger.info(`Authentication required: ${data.verification_uri} code: ${data.user_code}`);
                this.discordClient.sendLoginEmbed(data.user_code, authUrl);
            }
        });
    }

    handleChatMessage(message, messagePosition, jsonMsg, sender) {
        // Filter out certain message types
        if (messagePosition === 2) return; // Action bar messages

        // Log all chat messages
        logger.info(`Chat: ${message}`);

        // Send to Discord
        if (sender) {
            // Player message - send directly as bot message
            this.discordClient.sendChatMessage(sender, message, false);
        } else {
            // Server message - check if it should be batched
            const shouldBatch = this.discordClient.batchMessage(message, true);
            if (!shouldBatch) {
                this.discordClient.sendChatMessage('Server', message, true);
            }
        }


    }

    async handleReconnect() {
        if (this.isReconnecting) return;

        this.isReconnecting = true;
        this.reconnectAttempts++;

        if (this.reconnectAttempts > config.minecraft.maxReconnectAttempts) {
            logger.error(`Max reconnection attempts reached (${config.minecraft.maxReconnectAttempts})`);
            this.discordClient.sendStatusEmbed('❌ Failed', `Failed to reconnect after ${config.minecraft.maxReconnectAttempts} attempts`, 0xFF0000);
            process.exit(1);
        }

        logger.info(`Attempting to reconnect... (${this.reconnectAttempts}/${config.minecraft.maxReconnectAttempts})`);

        setTimeout(async () => {
            try {
                await this.connect();
                this.isReconnecting = false;
            } catch (error) {
                logger.error(`Reconnection attempt ${this.reconnectAttempts} failed:`, error);
                this.discordClient.sendStatusEmbed('🔄 Reconnecting...', `Attempt ${this.reconnectAttempts}/${config.minecraft.maxReconnectAttempts} failed. Retrying...`, 0xFFAA00);
                this.isReconnecting = false;
                this.handleReconnect();
            }
        }, config.minecraft.reconnectDelay);
    }



    startAntiAfk() {
        if (this.afkInterval) {
            clearInterval(this.afkInterval);
        }

        // Perform anti-AFK actions every 30 seconds
        this.afkInterval = setInterval(() => {
            if (!this.bot || !this.isConnected) return;

            try {
                // Random movement patterns like a real player
                const actions = [
                    () => this.randomMovement(),
                    () => this.randomLook(),
                    () => this.randomJump(),
                    () => this.randomRotation()
                ];

                // Execute 1-3 random actions
                const numActions = Math.floor(Math.random() * 3) + 1;
                for (let i = 0; i < numActions; i++) {
                    const randomAction = actions[Math.floor(Math.random() * actions.length)];
                    setTimeout(() => randomAction(), i * 200); // Stagger actions
                }

                logger.debug('Anti-AFK actions performed');
            } catch (error) {
                logger.debug('Anti-AFK action failed:', error.message);
            }
        }, 30000); // Every 30 seconds

        logger.info('Anti-AFK system started');
    }

    stopAntiAfk() {
        if (this.afkInterval) {
            clearInterval(this.afkInterval);
            this.afkInterval = null;
            logger.info('Anti-AFK system stopped');
        }
    }

    randomMovement() {
        if (!this.bot || !this.isConnected) return;

        // Random walk forward/backward and strafe
        const movements = [
            { forward: true, back: false, left: false, right: false },
            { forward: false, back: true, left: false, right: false },
            { forward: false, back: false, left: true, right: false },
            { forward: false, back: false, left: false, right: true },
            { forward: true, back: false, left: true, right: false },
            { forward: true, back: false, left: false, right: true }
        ];

        const movement = movements[Math.floor(Math.random() * movements.length)];

        // Start movement
        this.bot.setControlState('forward', movement.forward);
        this.bot.setControlState('back', movement.back);
        this.bot.setControlState('left', movement.left);
        this.bot.setControlState('right', movement.right);

        // Stop after random duration (0.5-2 seconds)
        const duration = Math.random() * 1500 + 500;
        setTimeout(() => {
            if (this.bot && this.isConnected) {
                this.bot.clearControlStates();
            }
        }, duration);
    }

    randomLook() {
        if (!this.bot || !this.isConnected) return;

        // Random look direction like a real player exploring
        const yaw = (Math.random() - 0.5) * 2 * Math.PI; // Full 360 degrees
        const pitch = (Math.random() - 0.5) * 0.5; // Limited up/down range

        this.bot.look(yaw, pitch, true);
    }

    randomJump() {
        if (!this.bot || !this.isConnected) return;

        // Random chance to jump (like players exploring)
        if (Math.random() < 0.3) { // 30% chance
            this.bot.setControlState('jump', true);
            setTimeout(() => {
                if (this.bot && this.isConnected) {
                    this.bot.setControlState('jump', false);
                }
            }, 200); // Short jump
        }
    }

    randomRotation() {
        if (!this.bot || !this.isConnected) return;

        // Smooth rotation like a player looking around
        const startYaw = this.bot.entity.yaw;
        const endYaw = startYaw + (Math.random() - 0.5) * Math.PI; // Up to 180 degree turn
        const steps = 10;
        const stepSize = (endYaw - startYaw) / steps;

        let step = 0;
        const rotateInterval = setInterval(() => {
            if (!this.bot || !this.isConnected) {
                clearInterval(rotateInterval);
                return;
            }

            step++;
            const currentYaw = startYaw + (stepSize * step);
            this.bot.look(currentYaw, this.bot.entity.pitch, true);

            if (step >= steps) {
                clearInterval(rotateInterval);
            }
        }, 50); // Smooth 500ms rotation
    }

    initializePlayerList() {
        if (!this.bot || !this.isConnected) return;

        // Clear existing player list to sync with current server state
        this.players.clear();

        // Get all currently online players (including bot)
        if (this.bot.players) {
            Object.values(this.bot.players).forEach(player => {
                if (player.username) {
                    this.players.add(player.username);
                }
            });
        }

        logger.info(`Synced player list with server - ${this.players.size} players currently online`);
        this.updatePlayerList();
    }

    updatePlayerList() {
        if (!this.discordClient || !this.isConnected) return;

        try {
            const playerArray = Array.from(this.players).sort();
            this.discordClient.sendPlayerListEmbed(playerArray);
        } catch (error) {
            logger.error('Failed to update player list:', error.message || error);
            // Don't crash the bot for player list updates
        }
    }

    async sendChatMessage(message) {
        if (!this.bot || !this.isConnected) {
            throw new Error('Bot is not connected to Minecraft server');
        }
        
        try {
            // Send message to Minecraft chat
            this.bot.chat(message);
            logger.info(`Bot sent message to Minecraft: "${message}"`);
        } catch (error) {
            logger.error('Failed to send message to Minecraft:', error);
            throw error;
        }
    }

    async disconnect() {
        if (this.bot && this.isConnected) {
            logger.info('Disconnecting from Minecraft server...');
            this.stopAntiAfk(); // Stop anti-AFK when disconnecting
            this.bot.quit('Bot shutting down');
            this.isConnected = false;
        }
    }
}

module.exports = MinecraftBot;