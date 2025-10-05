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
        this.detectedUsername = null; // Auto-detected username after login
        this.connectionState = 'idle'; // idle, connecting, authenticating, connected, disconnecting, reconnecting, error
        this.shouldReconnect = true; // Manual control for reconnection
        this.connectTimeout = null;
        this.reconnectTimeout = null;
        this.closestPlayer = null; // Track the player closest to the bot
        this.closestPlayerDistance = Infinity; // Track the distance to the closest player
        this.playerTrackingInterval = null; // Interval for tracking player positions
        this.statusUpdateInterval = null; // Interval for status updates
        this.connectionStartTime = null; // Track when connection was established
    }

    async connect() {
        try {
            // Prevent overlapping connection attempts
            if (this.connectionState === 'connecting' || this.connectionState === 'connected') {
                logger.warn('Connection already in progress or established, skipping');
                return;
            }

            // Set connection state
            this.connectionState = 'connecting';

            logger.info('Connecting to Minecraft server...');

            // Setup Microsoft authentication with username fallback
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

            // Add error handling for the underlying client to catch packet parsing errors
            this.bot._client.on('error', (error) => {
                const errorStr = error.toString();
                if (errorStr.includes('PartialReadError') || 
                    errorStr.includes('packet_world_particles') || 
                    errorStr.includes('Particle') ||
                    errorStr.includes('protodef/src/compiler.js') ||
                    errorStr.includes('CompiledProtodef.read') ||
                    errorStr.includes('ExtendableError') ||
                    errorStr.includes('Read error for undefined') ||
                    errorStr.includes('unknown chat format code')) {
                    // Silently ignore packet parsing errors - these are protocol mismatches
                    return;
                }
                logger.error('Client error:', error);
            });

            // Add error handler for chat parsing errors before setting up event handlers
            this.bot._client.on('chat', (packet) => {
                // Suppress chat parsing errors that would otherwise crash the bot
            });

            this.setupEventHandlers();

            return new Promise((resolve, reject) => {
                this.connectTimeout = setTimeout(() => {
                    this.connectionState = 'error';
                    reject(new Error('Connection timeout - server may be offline or unreachable'));
                }, 60000); // Increased timeout for authentication

                this.bot.once('spawn', () => {
                    clearTimeout(this.connectTimeout);
                    this.isConnected = true;
                    this.connectionState = 'connected';
                    this.reconnectAttempts = 0;

                    // Auto-detect username after successful login
                    this.detectedUsername = this.bot.username;
                    logger.info(`Successfully connected to ${config.minecraft.host}:${config.minecraft.port} as ${this.detectedUsername}`);
                    this.discordClient.sendStatusEmbed('Connected', `Successfully connected to ${config.minecraft.host}`, 0x00FF00);

                    // Start automatic status updates every minute
                    this.startStatusUpdates();

                    resolve();
                });

                this.bot.once('end', (reason) => {
                    clearTimeout(this.connectTimeout);
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

            // Check if this is an authentication prompt
            if (errorStr.includes('To sign in, use a web browser') || errorStr.includes('microsoft.com/link')) {
                this.connectionState = 'authenticating';
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
            // Track when connection was established to prevent initial player flood
            this.connectionStartTime = Date.now();

            // Update Discord bot status to connected
            if (this.discordClient && this.discordClient.setStatus) {
                this.discordClient.setStatus('connected', ` - ${this.bot.game.dimension}`);
            }

            // Initialize player list (this will handle adding the bot properly)
            this.initializePlayerList();

            // Update player list when bot joins server (with slight delay to ensure Discord is ready)
            setTimeout(() => {
                this.updatePlayerList();
            }, 1000);

            // Start anti-AFK behavior only if enabled
            if (config.minecraft.enableAntiAfk) {
                this.startAntiAfk();
                logger.info('Anti-AFK system enabled');
            } else {
                logger.info('Anti-AFK system disabled by configuration');
            }

            // Start tracking player positions
            this.startPlayerTracking();

            // Start status update interval (every minute)
            this.startStatusUpdates();
        });

        this.bot.on('end', (reason) => {
            this.isConnected = false;
            this.stopAntiAfk(); // Stop anti-AFK when disconnected
            this.stopPlayerTracking(); // Stop player tracking when disconnected
            this.stopStatusUpdates(); // Stop status updates when disconnected
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
            try {
                this.handleChatMessage(message, messagePosition, jsonMsg, sender);
            } catch (err) {
                logger.debug('Error handling chat message:', err?.message);
            }
        });

        // Add global error handler for chat parsing errors
        this.bot.on('message', (jsonMsg, position) => {
            // Silent handler to prevent crashes from chat parsing errors
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
            // Set the detected username after login
            this.detectedUsername = this.bot.username;
            logger.info(`Logged in as ${this.detectedUsername}`);
        });

        // Player join/leave events
        this.bot.on('playerJoined', (player) => {
            // Only add players with valid usernames
            if (player && player.username && typeof player.username === 'string' && player.username.trim() !== '') {
                const username = player.username.trim();
                // Don't add the bot itself to the player list
                if (username !== this.bot.username) {
                    // Check if player is already in our list (to prevent duplicate join messages)
                    const wasAlreadyOnline = this.players.has(username);
                    this.players.add(username);

                    // Only send join message if this is a NEW player AND we've been connected for more than 30 seconds
                    // Extended delay to ensure all initial player sync is complete before sending join messages
                    const hasBeenConnectedLongEnough = this.isConnected && this.connectionStartTime && (Date.now() - this.connectionStartTime) > 30000;

                    // Additional check: Only send if we're not in the initial connection phase
                    const isNotInitialConnection = this.connectionState === 'connected' && hasBeenConnectedLongEnough;

                    if (!wasAlreadyOnline && isNotInitialConnection) {
                        logger.info(`New player joined: ${username} (Total: ${this.players.size})`);

                        // Send join message to Discord as server message (only for actual new joins)
                        const joinMessage = `${username} joined the game`;
                        this.discordClient.sendChatMessage('Server', joinMessage, true);
                    } else {
                        if (wasAlreadyOnline) {
                            logger.debug(`Player ${username} already tracked, ignoring duplicate join event`);
                        } else {
                            logger.debug(`Player ${username} detected during initial sync/connection phase, skipping join message (connection age: ${this.connectionStartTime ? Date.now() - this.connectionStartTime : 0}ms)`);
                        }
                    }

                    // Update player list immediately
                    setTimeout(() => this.updatePlayerList(), 1000);
                }
            } else {
                logger.warn('Attempted to add player with invalid username:', player);
            }
        });

        this.bot.on('playerLeft', (player) => {
            // Only remove players with valid usernames
            if (player && player.username && typeof player.username === 'string' && player.username.trim() !== '') {
                const username = player.username.trim();
                const wasRemoved = this.players.delete(username);

                // Only send leave message if player was actually in our list AND we're fully connected
                // Additional check to prevent false leave messages during initial connection
                const hasBeenConnectedLongEnough = this.isConnected && this.connectionStartTime && (Date.now() - this.connectionStartTime) > 30000;
                const isNotInitialConnection = this.connectionState === 'connected' && hasBeenConnectedLongEnough;

                if (wasRemoved && isNotInitialConnection) {
                    logger.info(`Player left: ${username} (Total: ${this.players.size})`);

                    // Send leave message to Discord as server message
                    const leaveMessage = `${username} left the game`;
                    this.discordClient.sendChatMessage('Server', leaveMessage, true);
                } else {
                    if (!wasRemoved) {
                        logger.debug(`Player ${username} was not in list, skipping leave message`);
                    } else {
                        logger.debug(`Player ${username} left during initial connection phase, skipping leave message (connection age: ${this.connectionStartTime ? Date.now() - this.connectionStartTime : 0}ms)`);
                    }
                }

                // Update player list immediately
                setTimeout(() => this.updatePlayerList(), 1000);
            } else {
                logger.warn('Attempted to remove player with invalid username:', player);
            }
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
        try {
            // Filter out certain message types
            if (messagePosition === 2) return; // Action bar messages

            // Validate message
            if (!message || typeof message !== 'string') {
                logger.debug('Invalid chat message received');
                return;
            }

            // Log all chat messages
            logger.info(`Chat: ${message}`);

            // Check for keywords in player chat (not system messages)
            if (sender && typeof message === 'string') {
                const lowerMessage = message.toLowerCase();
                if (lowerMessage.includes('lootedbycgy') || lowerMessage.includes('doggo')) {
                    // DM user ID 915483308522086460 with message link
                    if (this.discordClient) {
                        this.discordClient.sendKeywordAlert(sender, message, '915483308522086460').catch(err => {
                            logger.debug('Failed to send keyword alert:', err?.message);
                        });
                    }
                }
            }

            // Send messages to Discord
            if (!this.discordClient) {
                return;
            }

            if (sender) {
                // Player message - send immediately (no batching for player messages)
                this.discordClient.sendChatMessage(sender, message, false).catch(err => {
                    logger.error('Failed to send player chat to Discord:', err?.message);
                });
            } else {
                // Server message - filter out ALL join/leave messages to prevent duplicates
                // (these are handled by playerJoined/playerLeft events which are more reliable)
                if (message.includes(' joined the game') || message.includes(' left the game')) {
                    logger.debug(`Filtering out join/leave chat message: ${message}`);
                    return; // Don't send these, they're handled by proper events
                }

                // Try to batch server messages that arrive at the same time
                try {
                    const wasBatched = this.discordClient.batchMessage(message, true);
                    if (!wasBatched) {
                        // If batching failed or isn't appropriate, send immediately
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
        this.shouldReconnect = false; // Prevent auto-reconnect

        // Clear any pending timeouts
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        // Stop anti-AFK
        this.stopAntiAfk();

        // Disconnect the bot
        if (this.bot) {
            try {
                // Remove all listeners to prevent memory leaks
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

        // Update Discord status
        this.discordClient.sendStatusEmbed('⏸️ Disconnected', 'Bot manually disconnected', 0xFFAA00);
    }

    async handleReconnect() {
        // Check if reconnection is disabled
        if (!this.shouldReconnect) {
            logger.info('Auto-reconnect is disabled, skipping reconnection');
            return;
        }

        if (this.isReconnecting) return;

        this.connectionState = 'reconnecting';
        this.isReconnecting = true;
        this.reconnectAttempts++;

        if (this.reconnectAttempts > config.minecraft.maxReconnectAttempts) {
            logger.error(`Max reconnection attempts reached (${config.minecraft.maxReconnectAttempts})`);
            this.discordClient.sendStatusEmbed('❌ Failed', `Failed to reconnect after ${config.minecraft.maxReconnectAttempts} attempts`, 0xFF0000);
            this.connectionState = 'error';
            this.isReconnecting = false;
            return; // Don't exit process, just stop reconnecting
        }

        logger.info(`Attempting to reconnect... (${this.reconnectAttempts}/${config.minecraft.maxReconnectAttempts})`);

        // Calculate exponential backoff with jitter
        const baseDelay = config.minecraft.reconnectDelay;
        const exponentialDelay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts - 1), 300000); // Cap at 5 minutes
        const jitter = Math.random() * 5000; // Add up to 5 seconds of jitter
        const totalDelay = exponentialDelay + jitter;

        this.reconnectTimeout = setTimeout(async () => {
            try {
                await this.connect();
                this.isReconnecting = false;
                logger.info(`Reconnection successful after ${this.reconnectAttempts} attempts`);
            } catch (error) {
                logger.error(`Reconnection attempt ${this.reconnectAttempts} failed:`, error.message);
                this.discordClient.sendStatusEmbed('🔄 Reconnecting...', `Attempt ${this.reconnectAttempts}/${config.minecraft.maxReconnectAttempts} failed. Retrying in ${Math.round(totalDelay/1000)}s...`, 0xFFAA00);
                this.isReconnecting = false;
                this.handleReconnect();
            }
        }, totalDelay);
    }

    // Method to manually enable reconnection (called from Discord reactions)
    resumeReconnect() {
        this.shouldReconnect = true;
        this.reconnectAttempts = 0; // Reset attempts for fresh start
        logger.info('Auto-reconnect resumed, attempting to connect...');

        // If not currently connected, try to connect
        if (!this.isConnected && this.connectionState !== 'connecting') {
            this.connect().catch((error) => {
                logger.warn('Resume reconnect connection attempt failed:', error.message);
            });
        }
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

        // Get all currently online players from the bot's player registry
        if (this.bot.players) {
            Object.values(this.bot.players).forEach(player => {
                // Only add players with valid usernames and exclude undefined/null values
                if (player && player.username && typeof player.username === 'string' && player.username.trim() !== '') {
                    const username = player.username.trim();
                    // Don't add the bot itself to the player list
                    if (username !== this.bot.username) {
                        this.players.add(username);
                        logger.debug(`Initial sync: Added existing player ${username}`);
                    }
                }
            });
        }

        logger.info(`Synced player list with server - ${this.players.size} players currently online: [${Array.from(this.players).join(', ')}]`);
        this.updatePlayerList();
    }

    updatePlayerList() {
        if (!this.discordClient || !this.isConnected) return;

        try {
            // Filter out any invalid entries and sort the list
            const playerArray = Array.from(this.players)
                .filter(player => player && typeof player === 'string' && player.trim() !== '')
                .map(player => player.trim())
                .sort();

            // Remove duplicates (just in case)
            const uniquePlayers = [...new Set(playerArray)];

            logger.debug(`Updating player list: [${uniquePlayers.join(', ')}] (${uniquePlayers.length} players)`);
            this.discordClient.sendPlayerListEmbed(uniquePlayers);
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

    async walkForward(blocks) {
        if (!this.bot || !this.isConnected) {
            throw new Error('Bot is not connected to Minecraft server');
        }

        try {
            logger.info(`Starting to walk ${blocks} blocks forward`);

            // Calculate approximate time needed (1 block takes about 1 second at normal walking speed)
            const walkTimePerBlock = 1000; // milliseconds
            const totalWalkTime = blocks * walkTimePerBlock;

            // Start walking forward
            this.bot.setControlState('forward', true);

            // Stop walking after the calculated time
            setTimeout(() => {
                if (this.bot && this.isConnected) {
                    this.bot.setControlState('forward', false);
                    logger.info(`Finished walking ${blocks} blocks forward`);

                    // Send status update to Discord
                    if (this.discordClient) {
                        this.discordClient.sendStatusEmbed(
                            '🚶 Walk Complete', 
                            `Bot finished walking ${blocks} blocks forward`, 
                            0x00FF00
                        );
                    }
                }
            }, totalWalkTime);

            // Send immediate status update
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
                await new Promise(resolve => setTimeout(resolve, 200)); // Jump duration
                this.bot.setControlState('jump', false);

                if (i < times - 1) {
                    await new Promise(resolve => setTimeout(resolve, 300)); // Pause between jumps
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
                    yaw = -Math.PI / 2; // -90 degrees
                    break;
                case 'south':
                    yaw = Math.PI / 2; // 90 degrees
                    break;
                case 'east':
                    yaw = 0; // 0 degrees
                    break;
                case 'west':
                    yaw = Math.PI; // 180 degrees
                    break;
                case 'up':
                    yaw = this.bot.entity.yaw;
                    pitch = -Math.PI / 2; // Look up
                    break;
                case 'down':
                    yaw = this.bot.entity.yaw;
                    pitch = Math.PI / 2; // Look down
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
            // Clear all control states
            this.bot.clearControlStates();

            // Stop any anti-AFK actions
            if (this.afkInterval) {
                clearInterval(this.afkInterval);
                this.afkInterval = null;
                logger.info('Stopped anti-AFK system');
            }

            logger.info('All bot actions stopped');

            // Restart anti-AFK if it was enabled
            if (config.minecraft.enableAntiAfk) {
                setTimeout(() => {
                    this.startAntiAfk();
                    logger.info('Anti-AFK system restarted');
                }, 2000); // Wait 2 seconds before restarting
            }

        } catch (error) {
            logger.error('Failed to stop bot actions:', error);
            throw error;
        }
    }


    async disconnect() {
        if (this.bot && this.isConnected) {
            logger.info('Disconnecting from Minecraft server...');
            this.stopAntiAfk(); // Stop anti-AFK when disconnecting
            this.stopPlayerTracking(); // Stop player tracking when disconnected
            this.stopStatusUpdates(); // Stop status updates when disconnected
            this.bot.quit('Bot shutting down');
            this.isConnected = false;
        }
    }

    // Start tracking player positions to find the closest one
    startPlayerTracking() {
        if (!this.bot || !this.isConnected) return;

        // Clear any existing interval to prevent duplicates
        this.stopPlayerTracking();

        // Update closest player every second
        this.playerTrackingInterval = setInterval(() => {
            if (!this.bot || !this.isConnected) return;

            this.updateClosestPlayer();
            // Update status message periodically, e.g., every 10 seconds
            if (this.closestPlayer) {
                const statusMessage = `Closest player: ${this.closestPlayer}`;
                this.discordClient.setStatus('online', statusMessage);
                logger.debug(statusMessage);
            } else {
                this.discordClient.setStatus('connected', ` - ${this.bot.game.dimension}`);
            }
        }, 1000); // Check every second

        logger.info('Player tracking started');
    }

    // Stop player tracking
    stopPlayerTracking() {
        if (this.playerTrackingInterval) {
            clearInterval(this.playerTrackingInterval);
            this.playerTrackingInterval = null;
            logger.info('Player tracking stopped');
        }
        // Keep last detected player info instead of resetting
    }

    // Update the closest player to the bot
    updateClosestPlayer() {
        if (!this.bot || !this.isConnected || !this.bot.players) return;

        let closestPlayer = null;
        let minDistance = Infinity;

        // Iterate over all online players
        for (const playerName in this.bot.players) {
            const player = this.bot.players[playerName];
            if (player && player.entity && player.username !== this.bot.username) {
                const distance = this.bot.entity.position.distanceTo(player.entity.position);
                if (distance < minDistance) {
                    minDistance = distance;
                    closestPlayer = player.username;
                }
            }
        }

        this.closestPlayer = closestPlayer;
        this.closestPlayerDistance = minDistance;
    }

    // Method to get closest player info for Discord status
    getClosestPlayerInfo() {
        if (!this.closestPlayer) {
            return null;
        }

        return {
            name: this.closestPlayer,
            distance: Math.round(this.closestPlayerDistance)
        };
    }

    // Start status updates every minute
    startStatusUpdates() {
        if (!this.discordClient || !this.isConnected) return;

        // Clear any existing interval
        this.stopStatusUpdates();

        // Update status every minute
        this.statusUpdateInterval = setInterval(() => {
            if (!this.isConnected || !this.discordClient) return;

            // Send the actual connection status instead of generic message
            const displayUsername = this.detectedUsername || this.bot?.username || config.minecraft.username || 'Unknown';
            this.discordClient.sendStatusEmbed('Connected', `Successfully connected to ${config.minecraft.host}`, 0x00FF00);
        }, 60000); // 60 seconds

        logger.info('Status updates started (every minute)');
    }

    // Stop status updates
    stopStatusUpdates() {
        if (this.statusUpdateInterval) {
            clearInterval(this.statusUpdateInterval);
            this.statusUpdateInterval = null;
            logger.info('Status updates stopped');
        }
    }
}

module.exports = MinecraftBot;
