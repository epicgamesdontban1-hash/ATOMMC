const mineflayer = require('mineflayer');
const { Authflow, Titles } = require('prismarine-auth');
const config = require('./config');
const logger = require('./logger');
const fetch = require('node-fetch');

// ============================================================================
// MINECRAFT BOT CLASS
// ============================================================================

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
        this.detectedUsername = null;
        this.connectionState = 'idle';
        this.shouldReconnect = true;
        this.connectTimeout = null;
        this.reconnectTimeout = null;
        this.statusUpdateInterval = null;
        this.connectionStartTime = null;
    }

    // ========================================================================
    // TIMER AND INTERVAL MANAGEMENT
    // ========================================================================

    clearAllTimersAndIntervals() {
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        if (this.afkInterval) {
            clearInterval(this.afkInterval);
            this.afkInterval = null;
        }

        if (this.statusUpdateInterval) {
            clearInterval(this.statusUpdateInterval);
            this.statusUpdateInterval = null;
        }
        
        logger.debug('All timers and intervals cleared');
    }

    // ========================================================================
    // CONNECTION MANAGEMENT
    // ========================================================================

    async connect() {
        try {
            if (this.connectionState === 'connecting' || this.connectionState === 'connected') {
                logger.warn('Connection already in progress or established, skipping');
                return;
            }

            this.connectionState = 'connecting';
            logger.info('Connecting to Minecraft server...');

            const username = config.minecraft.username || 'MinecraftBridgeBot';
            const authflow = new Authflow(username, './cache');

            const botOptions = {
                host: config.minecraft.host,
                port: config.minecraft.port,
                username: username,
                version: config.minecraft.version,
                auth: 'microsoft',
                authflow: authflow
            };

            this.bot = mineflayer.createBot(botOptions);

            this.bot._client.on('error', (error) => {
                const errorStr = error?.toString() || '';
                const errorMsg = error?.message || error?.code || errorStr || 'Unknown error';
                
                if (errorStr.includes('PartialReadError') || 
                    errorStr.includes('packet_world_particles') || 
                    errorStr.includes('Particle') ||
                    errorStr.includes('protodef/src/compiler.js') ||
                    errorStr.includes('CompiledProtodef.read') ||
                    errorStr.includes('ExtendableError') ||
                    errorStr.includes('Read error for undefined') ||
                    errorStr.includes('unknown chat format code')) {
                    return;
                }
                
                if (!error?.message && !error?.code && !error?.stack && errorStr === '[object Object]') {
                    return;
                }
                
                logger.error('Client error:', errorMsg);
            });

            this.bot._client.on('chat', (packet) => {
                // Suppress chat parsing errors
            });

            this.setupEventHandlers();

            return new Promise((resolve, reject) => {
                this.connectTimeout = setTimeout(() => {
                    this.connectionState = 'error';
                    reject(new Error('Connection timeout - server may be offline or unreachable'));
                }, 60000);

                this.bot.once('spawn', () => {
                    clearTimeout(this.connectTimeout);
                    this.connectTimeout = null;
                    this.isConnected = true;
                    this.connectionState = 'connected';
                    this.reconnectAttempts = 0;
                    this.detectedUsername = this.bot.username;
                    
                    if (this.bridge && this.bridge.resetAuthFlag) {
                        this.bridge.resetAuthFlag();
                    }

                    logger.info(`Successfully connected to ${config.minecraft.host}:${config.minecraft.port} as ${this.detectedUsername}`);
                    
                    if (this.discordClient) {
                        this.discordClient.sendStatusEmbed('Connected', `Successfully connected to ${config.minecraft.host}`, 0x00FF00);
                        if (this.discordClient.deleteAuthMessage) {
                            this.discordClient.deleteAuthMessage();
                        }
                    }

                    this.startStatusUpdates();
                    resolve();
                });

                this.bot.once('end', (reason) => {
                    if (this.connectTimeout) {
                        clearTimeout(this.connectTimeout);
                        this.connectTimeout = null;
                    }
                    
                    if (!this.isConnected) {
                        this.connectionState = 'error';
                        logger.error('Connection ended before spawn:', reason);
                        reject(new Error(`Connection ended: ${reason}`));
                    }
                });
            });
        } catch (error) {
            this.connectionState = 'error';
            const errorStr = error.toString();

            if (errorStr.includes('To sign in, use a web browser') || errorStr.includes('microsoft.com/link')) {
                this.connectionState = 'authenticating';
                const codeMatch = errorStr.match(/code ([A-Z0-9]+)/i);
                if (codeMatch && this.discordClient) {
                    const authCode = codeMatch[1];
                    const authUrl = `https://www.microsoft.com/link?otc=${authCode}`;
                    logger.info(`Authentication required. Code: ${authCode}`);
                    this.discordClient.sendLoginEmbed(authCode, authUrl);
                }
            }

            if (errorStr.includes('ENOTFOUND') || errorStr.includes('ECONNREFUSED')) {
                logger.error('Server connection failed - server may be offline or unreachable');
                if (this.discordClient) {
                    this.discordClient.sendStatusEmbed('❌ Connection Failed', `Cannot reach ${config.minecraft.host}:${config.minecraft.port} - server may be offline`, 0xFF0000);
                }
            } else if (errorStr.includes('Connection timeout')) {
                logger.error('Connection timeout - server is not responding');
                if (this.discordClient) {
                    this.discordClient.sendStatusEmbed('⏰ Connection Timeout', 'Server is not responding - may be overloaded or offline', 0xFF0000);
                }
            } else {
                logger.error('Failed to connect to Minecraft server:', error.message || error);
                if (this.discordClient) {
                    this.discordClient.sendStatusEmbed('❌ Connection Error', `Connection failed: ${error.message || 'Unknown error'}`, 0xFF0000);
                }
            }

            if (error.stack) {
                logger.debug('Error stack:', error.stack);
            }
            throw error;
        }
    }

    // ========================================================================
    // EVENT HANDLERS
    // ========================================================================

    setupEventHandlers() {
        this.bot.on('spawn', () => {
            logger.info(`Bot spawned in world: ${this.bot.game.dimension}`);
            this.connectionStartTime = Date.now();

            if (this.discordClient && this.discordClient.setStatus) {
                const position = this.bot.entity?.position;
                const coords = position ? ` | X:${Math.round(position.x)} Y:${Math.round(position.y)} Z:${Math.round(position.z)}` : '';
                this.discordClient.setStatus('connected', ` - ${this.bot.game.dimension}${coords}`);
            }

            this.initializePlayerList();

            setTimeout(() => {
                this.updatePlayerList();
            }, 1000);

            if (config.minecraft.enableAntiAfk) {
                this.startAntiAfk();
                logger.info('Anti-AFK system enabled');
            } else {
                logger.info('Anti-AFK system disabled by configuration');
            }

            this.startStatusUpdates();
        });

        this.bot.on('end', (reason) => {
            this.isConnected = false;
            this.clearAllTimersAndIntervals();
            
            logger.warn(`Bot disconnected: ${reason}`);
            
            if (this.discordClient) {
                this.discordClient.sendStatusEmbed('Disconnected', `Bot lost connection: ${reason}`, 0xFF0000);
            }

            if (!this.isReconnecting && this.shouldReconnect) {
                this.handleReconnect();
            }
        });

        this.bot.on('error', (error) => {
            const errorStr = error?.toString() || '';
            const errorMsg = error?.message || error?.code || errorStr || 'Unknown error';
            
            if (errorStr.includes('PartialReadError') || 
                errorStr.includes('packet_world_particles') || 
                errorStr.includes('Particle') ||
                errorStr.includes('protodef/src/compiler.js') ||
                errorStr.includes('CompiledProtodef.read') ||
                errorStr.includes('ExtendableError') ||
                errorStr.includes('Read error for undefined')) {
                return;
            }

            if (!error?.message && !error?.code && !error?.stack && errorStr === '[object Object]') {
                return;
            }

            logger.error('Bot error:', errorMsg);
            if (this.discordClient) {
                this.discordClient.sendStatusEmbed('Error', `Bot encountered an error: ${errorMsg}`, 0xFF0000);
            }
        });

        this.bot.on('kicked', (reason, loggedIn) => {
            logger.warn(`Bot was kicked: ${reason}`);
            if (this.discordClient) {
                this.discordClient.sendStatusEmbed('Kicked', `Bot was kicked from server: ${reason}`, 0xFFAA00);
            }
        });

        this.bot.on('messagestr', (message, messagePosition, jsonMsg, sender, verified) => {
            try {
                this.handleChatMessage(message, messagePosition, jsonMsg, sender);
            } catch (err) {
                logger.debug('Error handling chat message:', err?.message);
            }
        });

        this.bot.on('message', (jsonMsg, position) => {
            // Silent handler to prevent crashes from chat parsing errors
        });

        this.bot.on('whisper', (username, message, translate, jsonMsg, matches) => {
            logger.info(`Whisper from ${username}: ${message}`);
            if (this.discordClient) {
                this.discordClient.sendChatMessage(username, `**Whisper to ${this.bot.username}:** ${message}`, false);
            }
        });

        this.bot.on('health', () => {
            if (this.bot.health <= 0) {
                logger.warn('Bot died, respawning...');
                this.bot.respawn();
                if (this.discordClient) {
                    this.discordClient.sendStatusEmbed('Respawned', 'Bot died and has been respawned', 0xFFAA00);
                }
            }
        });

        this.bot.on('death', () => {
            logger.info('Bot died');
            if (this.discordClient) {
                this.discordClient.sendStatusEmbed('Died', 'Bot has died in-game', 0xFF0000);
            }
        });

        this.bot.on('login', () => {
            this.detectedUsername = this.bot.username;
            logger.info(`Logged in as ${this.detectedUsername}`);
        });

        this.bot.on('playerJoined', (player) => {
            if (player && player.username && typeof player.username === 'string' && player.username.trim() !== '') {
                const username = player.username.trim();
                if (username !== this.bot.username) {
                    const wasAlreadyOnline = this.players.has(username);
                    this.players.add(username);

                    const hasBeenConnectedLongEnough = this.isConnected && this.connectionStartTime && (Date.now() - this.connectionStartTime) > 30000;
                    const isNotInitialConnection = this.connectionState === 'connected' && hasBeenConnectedLongEnough;

                    if (!wasAlreadyOnline && isNotInitialConnection && this.discordClient) {
                        logger.info(`New player joined: ${username} (Total: ${this.players.size})`);
                        const joinMessage = `${username} joined the game`;
                        this.discordClient.sendChatMessage('Server', joinMessage, true);
                    } else {
                        logger.debug(`Player ${username} detected during initial sync, skipping join message`);
                    }

                    setTimeout(() => this.updatePlayerList(), 1000);
                }
            }
        });

        this.bot.on('playerLeft', (player) => {
            if (player && player.username && typeof player.username === 'string' && player.username.trim() !== '') {
                const username = player.username.trim();
                const wasRemoved = this.players.delete(username);

                const hasBeenConnectedLongEnough = this.isConnected && this.connectionStartTime && (Date.now() - this.connectionStartTime) > 30000;
                const isNotInitialConnection = this.connectionState === 'connected' && hasBeenConnectedLongEnough;

                if (wasRemoved && isNotInitialConnection && this.discordClient) {
                    logger.info(`Player left: ${username} (Total: ${this.players.size})`);
                    const leaveMessage = `${username} left the game`;
                    this.discordClient.sendChatMessage('Server', leaveMessage, true);
                }

                setTimeout(() => this.updatePlayerList(), 1000);
            }
        });

        this.bot._client.on('msa', (data) => {
            if (data.user_code && data.verification_uri && this.discordClient) {
                const authUrl = `${data.verification_uri}?otc=${data.user_code}`;
                logger.info(`Authentication required: ${data.verification_uri} code: ${data.user_code}`);
                this.discordClient.sendLoginEmbed(data.user_code, authUrl);
            }
        });
    }

    handleChatMessage(message, messagePosition, jsonMsg, sender) {
        try {
            if (messagePosition === 2) return;

            if (!message || typeof message !== 'string') {
                logger.debug('Invalid chat message received');
                return;
            }

            logger.info(`Chat: ${message}`);

            if (sender && typeof message === 'string') {
                const lowerMessage = message.toLowerCase();
                if ((lowerMessage.includes('lootedbycgy') || lowerMessage.includes('doggo')) && this.discordClient) {
                    this.discordClient.sendKeywordAlert(sender, message, '915483308522086460').catch(err => {
                        logger.debug('Failed to send keyword alert:', err?.message);
                    });
                }
            }

            if (!this.discordClient) {
                return;
            }

            if (sender) {
                this.discordClient.sendChatMessage(sender, message, false).catch(err => {
                    logger.error('Failed to send player chat to Discord:', err?.message);
                });
            } else {
                if (message.includes(' joined the game') || message.includes(' left the game')) {
                    logger.debug(`Filtering out join/leave chat message: ${message}`);
                    return;
                }

                try {
                    const wasBatched = this.discordClient.batchMessage(message, true);
                    if (!wasBatched) {
                        this.discordClient.sendChatMessage('Server', message, true).catch(err => {
                            logger.error('Failed to send server chat to Discord:', err?.message);
                        });
                    }
                } catch (batchErr) {
                    logger.error('Error batching message:', batchErr?.message);
                }
            }
        } catch (error) {
            logger.error('Error in handleChatMessage:', error?.message || JSON.stringify(error) || 'Unknown error');
        }
    }

    async disconnect() {
        logger.info('Manually disconnecting from Minecraft server...');
        this.connectionState = 'disconnecting';
        this.shouldReconnect = false;

        this.clearAllTimersAndIntervals();

        if (this.bot) {
            try {
                this.bot.removeAllListeners();
                this.bot.quit('Manual disconnect');
                this.bot = null;
            } catch (error) {
                logger.warn('Error during bot disconnect:', error.message);
            }
        }

        this.isConnected = false;
        this.connectionState = 'idle';
        logger.info('Successfully disconnected from Minecraft server');

        if (this.discordClient) {
            this.discordClient.sendStatusEmbed('⏸️ Disconnected', 'Bot manually disconnected', 0xFFAA00);
        }
    }

    // ========================================================================
    // RECONNECTION LOGIC
    // ========================================================================

    async handleReconnect() {
        if (!this.shouldReconnect) {
            logger.info('Auto-reconnect is disabled, skipping reconnection');
            return;
        }

        if (this.isReconnecting) {
            logger.debug('Reconnection already in progress, skipping duplicate');
            return;
        }

        this.connectionState = 'reconnecting';
        this.isReconnecting = true;
        this.reconnectAttempts++;

        logger.info(`Attempting to reconnect... (Attempt #${this.reconnectAttempts})`);

        const baseDelay = config.minecraft.reconnectDelay;
        const exponentialDelay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts - 1), 300000);
        const jitter = Math.random() * 5000;
        const totalDelay = exponentialDelay + jitter;

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }

        this.reconnectTimeout = setTimeout(async () => {
            this.reconnectTimeout = null;
            
            try {
                await this.connect();
                this.isReconnecting = false;
                logger.info(`Reconnection successful after ${this.reconnectAttempts} attempts`);
            } catch (error) {
                logger.error(`Reconnection attempt ${this.reconnectAttempts} failed:`, error.message);
                if (this.discordClient) {
                    this.discordClient.sendStatusEmbed('🔄 Reconnecting...', `Attempt #${this.reconnectAttempts} failed. Retrying in ${Math.round(totalDelay/1000)}s...`, 0xFFAA00);
                }
                this.isReconnecting = false;
                this.handleReconnect();
            }
        }, totalDelay);
    }

    resumeReconnect() {
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        logger.info('Auto-reconnect resumed, attempting to connect...');

        if (!this.isConnected && this.connectionState !== 'connecting') {
            this.connect().catch((error) => {
                logger.warn('Resume reconnect connection attempt failed:', error.message);
            });
        }
    }

    // ========================================================================
    // ANTI-AFK SYSTEM
    // ========================================================================

    startAntiAfk() {
        if (this.afkInterval) {
            clearInterval(this.afkInterval);
        }

        this.afkInterval = setInterval(() => {
            if (!this.bot || !this.isConnected) return;

            try {
                const actions = [
                    () => this.randomMovement(),
                    () => this.randomLook(),
                    () => this.randomJump(),
                    () => this.randomRotation()
                ];

                const numActions = Math.floor(Math.random() * 3) + 1;
                for (let i = 0; i < numActions; i++) {
                    const randomAction = actions[Math.floor(Math.random() * actions.length)];
                    setTimeout(() => randomAction(), i * 200);
                }

                logger.debug('Anti-AFK actions performed');
            } catch (error) {
                logger.debug('Anti-AFK action failed:', error.message);
            }
        }, 30000);

        logger.info('Anti-AFK system started');
    }

    randomMovement() {
        if (!this.bot || !this.isConnected) return;

        const movements = [
            { forward: true, back: false, left: false, right: false },
            { forward: false, back: true, left: false, right: false },
            { forward: false, back: false, left: true, right: false },
            { forward: false, back: false, left: false, right: true },
            { forward: true, back: false, left: true, right: false },
            { forward: true, back: false, left: false, right: true }
        ];

        const movement = movements[Math.floor(Math.random() * movements.length)];

        this.bot.setControlState('forward', movement.forward);
        this.bot.setControlState('back', movement.back);
        this.bot.setControlState('left', movement.left);
        this.bot.setControlState('right', movement.right);

        const duration = Math.random() * 1500 + 500;
        setTimeout(() => {
            if (this.bot && this.isConnected) {
                this.bot.clearControlStates();
            }
        }, duration);
    }

    randomLook() {
        if (!this.bot || !this.isConnected) return;
        const yaw = (Math.random() - 0.5) * 2 * Math.PI;
        const pitch = (Math.random() - 0.5) * 0.5;
        this.bot.look(yaw, pitch, true);
    }

    randomJump() {
        if (!this.bot || !this.isConnected) return;
        if (Math.random() < 0.3) {
            this.bot.setControlState('jump', true);
            setTimeout(() => {
                if (this.bot && this.isConnected) {
                    this.bot.setControlState('jump', false);
                }
            }, 200);
        }
    }

    randomRotation() {
        if (!this.bot || !this.isConnected) return;
        const startYaw = this.bot.entity.yaw;
        const endYaw = startYaw + (Math.random() - 0.5) * Math.PI;
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
        }, 50);
    }

    // ========================================================================
    // PLAYER LIST MANAGEMENT
    // ========================================================================

    initializePlayerList() {
        if (!this.bot || !this.isConnected) return;

        this.players.clear();

        if (this.bot.players) {
            Object.values(this.bot.players).forEach(player => {
                if (player && player.username && typeof player.username === 'string' && player.username.trim() !== '') {
                    const username = player.username.trim();
                    this.players.add(username);
                    logger.debug(`Initial sync: Added existing player ${username}`);
                }
            });
        }
        
        if (this.bot.username) {
            this.players.add(this.bot.username);
        }

        logger.info(`Synced player list with server - ${this.players.size} players currently online: [${Array.from(this.players).join(', ')}]`);
        this.updatePlayerList();
    }

    updatePlayerList() {
        if (!this.discordClient || !this.isConnected) return;

        try {
            const playerArray = Array.from(this.players)
                .filter(player => player && typeof player === 'string' && player.trim() !== '')
                .map(player => player.trim())
                .sort();

            const uniquePlayers = [...new Set(playerArray)];

            logger.debug(`Updating player list: [${uniquePlayers.join(', ')}] (${uniquePlayers.length} players)`);
            this.discordClient.sendPlayerListEmbed(uniquePlayers);
        } catch (error) {
            logger.error('Failed to update player list:', error.message || error);
        }
    }

    // ========================================================================
    // BOT ACTIONS & COMMANDS
    // ========================================================================

    async sendChatMessage(message) {
        if (!this.bot || !this.isConnected) {
            throw new Error('Bot is not connected to Minecraft server');
        }

        try {
            this.bot.chat(message);
            logger.info(`Bot sent message to Minecraft: "${message}"`);
        } catch (error) {
            logger.error('Failed to send message to Minecraft:', error);
            throw error;
        }
    }

    async walkForward(blocks) {
        if (!this.bot || !this.isConnected) {
            throw new Error('Bot is not connected to Minecraft server');
        }

        try {
            logger.info(`Starting to walk ${blocks} blocks forward`);

            const walkTimePerBlock = 1000;
            const totalWalkTime = blocks * walkTimePerBlock;

            this.bot.setControlState('forward', true);

            setTimeout(() => {
                if (this.bot && this.isConnected) {
                    this.bot.setControlState('forward', false);
                    logger.info(`Finished walking ${blocks} blocks forward`);

                    if (this.discordClient) {
                        this.discordClient.sendStatusEmbed(
                            '🚶 Walk Complete', 
                            `Bot finished walking ${blocks} blocks forward`, 
                            0x00FF00
                        );
                    }
                }
            }, totalWalkTime);

            if (this.discordClient) {
                this.discordClient.sendStatusEmbed(
                    '🚶 Walking', 
                    `Bot is now walking ${blocks} blocks forward`, 
                    0xFFAA00
                );
            }

        } catch (error) {
            logger.error('Failed to make bot walk:', error);
            throw error;
        }
    }

    async performJump(times = 1) {
        if (!this.bot || !this.isConnected) {
            throw new Error('Bot is not connected to Minecraft server');
        }

        try {
            logger.info(`Performing ${times} jump(s)`);

            for (let i = 0; i < times; i++) {
                this.bot.setControlState('jump', true);
                await new Promise(resolve => setTimeout(resolve, 200));
                this.bot.setControlState('jump', false);

                if (i < times - 1) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }

            logger.info(`Completed ${times} jump(s)`);
        } catch (error) {
            logger.error('Failed to make bot jump:', error);
            throw error;
        }
    }

    async lookDirection(direction) {
        if (!this.bot || !this.isConnected) {
            throw new Error('Bot is not connected to Minecraft server');
        }

        try {
            let yaw, pitch = 0;

            switch (direction.toLowerCase()) {
                case 'north':
                    yaw = -Math.PI / 2;
                    break;
                case 'south':
                    yaw = Math.PI / 2;
                    break;
                case 'east':
                    yaw = 0;
                    break;
                case 'west':
                    yaw = Math.PI;
                    break;
                case 'up':
                    yaw = this.bot.entity.yaw;
                    pitch = -Math.PI / 2;
                    break;
                case 'down':
                    yaw = this.bot.entity.yaw;
                    pitch = Math.PI / 2;
                    break;
                case 'random':
                    yaw = Math.random() * 2 * Math.PI;
                    pitch = (Math.random() - 0.5) * Math.PI;
                    break;
                default:
                    throw new Error(`Invalid direction: ${direction}`);
            }

            this.bot.look(yaw, pitch, true);
            logger.info(`Bot looking ${direction}`);

        } catch (error) {
            logger.error('Failed to make bot look:', error);
            throw error;
        }
    }

    async stopAllActions() {
        if (!this.bot || !this.isConnected) {
            throw new Error('Bot is not connected to Minecraft server');
        }

        try {
            this.bot.clearControlStates();

            if (this.afkInterval) {
                clearInterval(this.afkInterval);
                this.afkInterval = null;
                logger.info('Stopped anti-AFK system');
            }

            logger.info('All bot actions stopped');

            if (config.minecraft.enableAntiAfk) {
                setTimeout(() => {
                    this.startAntiAfk();
                    logger.info('Anti-AFK system restarted');
                }, 2000);
            }

        } catch (error) {
            logger.error('Failed to stop bot actions:', error);
            throw error;
        }
    }

    // ========================================================================
    // STATUS UPDATE MANAGEMENT
    // ========================================================================

    startStatusUpdates() {
        if (!this.discordClient || !this.isConnected) return;

        if (this.statusUpdateInterval) {
            clearInterval(this.statusUpdateInterval);
        }

        this.statusUpdateInterval = setInterval(() => {
            if (!this.isConnected || !this.discordClient) return;

            const displayUsername = this.detectedUsername || this.bot?.username || config.minecraft.username || 'Unknown';
            this.discordClient.sendStatusEmbed('Connected', `Successfully connected to ${config.minecraft.host}`, 0x00FF00);
        }, 60000);

        logger.info('Status updates started (every minute)');
    }
}

module.exports = MinecraftBot;
