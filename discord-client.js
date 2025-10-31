const { Client, GatewayIntentBits, ChannelType, EmbedBuilder, SlashCommandBuilder, REST, Routes, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fetch = require('node-fetch');
const config = require('./config');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');

// ============================================================================
// DISCORD CLIENT CLASS
// ============================================================================

class DiscordClient {
    constructor(bridge = null) {
        this.client = null;
        this.channels = {
            logs: null,
            login: null,
            status: null,
            playerList: null
        };
        this.webhook = null;
        this.isConnected = false;
        this.messageQueue = [];
        this.isProcessingQueue = false;
        this.pendingMessages = new Map();
        this.batchTimeout = null;
        this.minecraftBot = null;
        this.bridge = bridge;
        this.statusUpdateInProgress = false;
        this.playerListUpdateInProgress = false;
        this.authMessageId = null;
        this.queueRetries = new Map();
        this.maxQueueRetries = 3;
        
        // Use instance-specific cache file to prevent conflicts
        this.instanceId = process.env.DISCORD_INSTANCE_ID || 'default';
        this.messageIdsFile = path.join('./cache', `discord-message-ids-${this.instanceId}.json`);
        
        this.loadMessageIds();
    }

    // ========================================================================
    // MESSAGE ID PERSISTENCE
    // ========================================================================
    
    loadMessageIds() {
        try {
            if (!fs.existsSync('./cache')) {
                fs.mkdirSync('./cache', { recursive: true });
            }
            
            if (fs.existsSync(this.messageIdsFile)) {
                const data = fs.readFileSync(this.messageIdsFile, 'utf8');
                const ids = JSON.parse(data);
                this.statusMessageId = ids.statusMessageId || config.discord.statusMessageId || null;
                this.playerListMessageId = ids.playerListMessageId || config.discord.playerListMessageId || null;
                logger.info(`Loaded persisted message IDs from file`);
            } else {
                this.statusMessageId = config.discord.statusMessageId || null;
                this.playerListMessageId = config.discord.playerListMessageId || null;
                logger.info(`No persisted message IDs file found, using config values`);
            }
            
            if (this.statusMessageId) {
                logger.info(`Status message ID: ${this.statusMessageId}`);
            }
            if (this.playerListMessageId) {
                logger.info(`Player list message ID: ${this.playerListMessageId}`);
            }
        } catch (error) {
            logger.error('Failed to load message IDs:', error.message);
            this.statusMessageId = config.discord.statusMessageId || null;
            this.playerListMessageId = config.discord.playerListMessageId || null;
        }
    }
    
    saveMessageIds() {
        try {
            if (!fs.existsSync('./cache')) {
                fs.mkdirSync('./cache', { recursive: true });
            }
            
            const data = {
                statusMessageId: this.statusMessageId,
                playerListMessageId: this.playerListMessageId,
                lastUpdated: new Date().toISOString()
            };
            
            fs.writeFileSync(this.messageIdsFile, JSON.stringify(data, null, 2), 'utf8');
            logger.debug('Saved message IDs to file');
        } catch (error) {
            logger.error('Failed to save message IDs:', error.message);
        }
    }

    // ========================================================================
    // CONNECTION MANAGEMENT
    // ========================================================================

    async connect() {
        if (config.discord.webhook) {
            this.webhook = config.discord.webhook;
            this.isConnected = true;
            logger.info('Using Discord webhook for message sending');
            return;
        }

        try {
            logger.info('Connecting to Discord...');

            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages
                ],
                partials: [
                    Partials.Message,
                    Partials.Channel
                ]
            });

            this.client.once('clientReady', async () => {
                logger.info(`Discord bot logged in as ${this.client.user.tag}`);
                await this.setupSlashCommands();
                try {
                    await this.setupChannels();
                } catch (error) {
                    logger.warn('Continuing without full channel setup:', error.message);
                }
                this.isConnected = true;
                await this.setStatus('startup');
            });

            this.client.on('error', (error) => {
                logger.error('Discord client error:', error);
            });

            this.client.on('disconnect', () => {
                logger.warn('Discord client disconnected');
                this.isConnected = false;
            });

            this.client.on('interactionCreate', async (interaction) => {
                if (interaction.isChatInputCommand()) {
                    await this.handleSlashCommand(interaction);
                } else if (interaction.isButton()) {
                    await this.handleButtonInteraction(interaction);
                }
            });

            await this.client.login(config.discord.token);
        } catch (error) {
            logger.error('Failed to connect to Discord:', error);
            throw error;
        }
    }

    // ========================================================================
    // BUTTON INTERACTIONS
    // ========================================================================

    async handleButtonInteraction(interaction) {
        try {
            if (!interaction.customId.startsWith('bot_')) return;

            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            if (!member || (!member.permissions.has('Administrator') && !member.permissions.has('ManageGuild'))) {
                return await interaction.reply({ 
                    content: '❌ You need Administrator or Manage Server permissions to control the bot', 
                    ephemeral: true 
                });
            }

            if (interaction.customId === 'bot_connect') {
                logger.info(`${interaction.user.username} requested bot connection via button`);
                
                if (this.minecraftBot && !this.minecraftBot.isConnected) {
                    this.minecraftBot.shouldReconnect = true;
                    this.minecraftBot.resumeReconnect();
                    await interaction.reply({ 
                        content: '🔄 Attempting to connect...', 
                        ephemeral: true 
                    });
                    await this.sendStatusEmbed('🔄 Connecting...', 'Connection requested via Discord button', 0xFFAA00);
                } else if (this.minecraftBot && this.minecraftBot.isConnected) {
                    await interaction.reply({ 
                        content: '✅ Bot is already connected', 
                        ephemeral: true 
                    });
                }
            } else if (interaction.customId === 'bot_disconnect') {
                logger.info(`${interaction.user.username} requested bot shutdown via button`);
                
                if (this.minecraftBot) {
                    this.minecraftBot.shouldReconnect = false;
                    if (this.minecraftBot.isConnected) {
                        await this.minecraftBot.disconnect();
                    }
                    await interaction.reply({ 
                        content: '⛔ Bot has been stopped', 
                        ephemeral: true 
                    });
                    await this.sendStatusEmbed('⛔ Shutdown', 'Bot manually stopped via Discord button', 0xE74C3C);
                }
            }
        } catch (error) {
            logger.error('Error handling button interaction:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ 
                    content: '❌ An error occurred', 
                    ephemeral: true 
                }).catch(() => {});
            }
        }
    }

    // ========================================================================
    // SLASH COMMAND SETUP
    // ========================================================================

    async setupSlashCommands() {
        if (!this.client || !this.client.user) {
            logger.debug('Skipping slash command registration (webhook mode or client not ready)');
            return;
        }
        
        try {
            const commands = [
                new SlashCommandBuilder()
                    .setName('message')
                    .setDescription('Send a message to the Minecraft server')
                    .addStringOption(option =>
                        option.setName('content')
                            .setDescription('The message to send')
                            .setRequired(true)
                    ),
                new SlashCommandBuilder()
                    .setName('walk')
                    .setDescription('Make the bot walk forward a specified number of blocks')
                    .addIntegerOption(option =>
                        option.setName('blocks')
                            .setDescription('Number of blocks to walk forward')
                            .setRequired(true)
                            .setMinValue(1)
                            .setMaxValue(100)
                    ),
                new SlashCommandBuilder()
                    .setName('players')
                    .setDescription('Show the list of online players'),
                new SlashCommandBuilder()
                    .setName('status')
                    .setDescription('Show bot status and server information'),
                new SlashCommandBuilder()
                    .setName('ping')
                    .setDescription('Check bot connectivity and response time'),
                new SlashCommandBuilder()
                    .setName('help')
                    .setDescription('Show available commands and their usage'),
                new SlashCommandBuilder()
                    .setName('location')
                    .setDescription('Show bot\'s current position in the world'),
                new SlashCommandBuilder()
                    .setName('health')
                    .setDescription('Show bot\'s current health and hunger status'),
                new SlashCommandBuilder()
                    .setName('jump')
                    .setDescription('Make the bot jump')
                    .addIntegerOption(option =>
                        option.setName('times')
                            .setDescription('Number of times to jump (1-5)')
                            .setRequired(false)
                            .setMinValue(1)
                            .setMaxValue(5)
                    ),
                new SlashCommandBuilder()
                    .setName('look')
                    .setDescription('Make the bot look in a specific direction')
                    .addStringOption(option =>
                        option.setName('direction')
                            .setDescription('Direction to look')
                            .setRequired(true)
                            .addChoices(
                                { name: 'North', value: 'north' },
                                { name: 'South', value: 'south' },
                                { name: 'East', value: 'east' },
                                { name: 'West', value: 'west' },
                                { name: 'Up', value: 'up' },
                                { name: 'Down', value: 'down' },
                                { name: 'Random', value: 'random' }
                            )
                    ),
                new SlashCommandBuilder()
                    .setName('stop')
                    .setDescription('Stop all bot movement and actions')
            ];

            const rest = new REST({ version: '10' }).setToken(config.discord.token);

            logger.info('Registering slash commands...');
            await rest.put(
                Routes.applicationCommands(this.client.user.id),
                { body: commands.map(command => command.toJSON()) }
            );
            logger.info('Slash commands registered successfully');
        } catch (error) {
            logger.error('Failed to register slash commands:', error);
        }
    }

    async setupChannels() {
        try {
            const criticalChannels = ['logs', 'login', 'status'];
            const optionalChannels = ['playerList'];

            for (const type of criticalChannels) {
                const channelId = config.discord.channels[type];
                this.channels[type] = await this.client.channels.fetch(channelId);

                if (!this.channels[type]) {
                    throw new Error(`${type.toUpperCase()} channel with ID ${channelId} not found`);
                }

                if (this.channels[type].type !== ChannelType.GuildText) {
                    throw new Error(`${type.toUpperCase()} channel must be a text channel`);
                }

                logger.info(`Connected to Discord ${type} channel: #${this.channels[type].name}`);
            }

            for (const type of optionalChannels) {
                try {
                    const channelId = config.discord.channels[type];
                    if (channelId) {
                        this.channels[type] = await this.client.channels.fetch(channelId);
                        
                        if (this.channels[type] && this.channels[type].type === ChannelType.GuildText) {
                            logger.info(`Connected to Discord ${type} channel: #${this.channels[type].name}`);
                        } else {
                            logger.warn(`${type.toUpperCase()} channel is not a text channel, skipping`);
                            this.channels[type] = null;
                        }
                    } else {
                        logger.warn(`${type.toUpperCase()} channel ID not provided, skipping`);
                    }
                } catch (channelError) {
                    logger.warn(`Failed to setup ${type} channel:`, channelError.message);
                    this.channels[type] = null;
                }
            }

            await this.sendStatusEmbed('Starting up', 'Minecraft bot is initializing...', 0xFFFF00);
            this.processMessageQueue();
        } catch (error) {
            logger.error('Failed to setup Discord channels:', error);
            throw error;
        }
    }

    // ========================================================================
    // MESSAGE SENDING
    // ========================================================================

    async sendMessage(message, channelType = 'logs') {
        if (!message || typeof message !== 'string') {
            logger.warn('Invalid message provided to sendMessage');
            return;
        }

        if (message.length > 1900) {
            message = message.substring(0, 1900) + '... (truncated)';
        }

        if (!this.isConnected) {
            this.messageQueue.push({message, channelType});
            logger.debug('Message queued (Discord not connected)');
            return;
        }

        try {
            if (this.webhook) {
                await this.sendWebhookMessage(message);
            } else if (this.channels[channelType]) {
                await this.channels[channelType].send(message);
            } else {
                this.messageQueue.push({message, channelType});
            }
        } catch (error) {
            logger.error('Failed to send Discord message:', error);
            this.messageQueue.unshift({message, channelType});
        }
    }

    async sendChatMessage(playerName, message, isServerMessage = false) {
        // Log to bridge for web interface
        if (this.bridge && this.bridge.logChatMessage) {
            this.bridge.logChatMessage(playerName, message, isServerMessage);
        }
        
        if (!this.isConnected) {
            this.messageQueue.push({message: `**${playerName}**: ${message}`, channelType: 'logs'});
            return;
        }

        try {
            if (!playerName || !message) {
                logger.warn('Invalid chat message: missing playerName or message');
                return;
            }

            if (typeof message !== 'string') {
                logger.warn('Invalid chat message: message is not a string');
                return;
            }

            if (message.length > 2000) {
                message = message.substring(0, 2000);
            }

            if (this.channels.logs) {
                if (!isServerMessage) {
                    const rankMatch = message.match(/^\[([^\]]+)\]/);
                    const cleanMessage = rankMatch ? message.replace(/^\[[^\]]+\]\s*/, '') : message;
                    const playerRank = rankMatch ? rankMatch[1] : null;
                    
                    let playerColor = 0x5865F2;
                    if (playerRank) {
                        if (playerRank.includes('AGENT')) playerColor = 0xFF0000;
                        else if (playerRank.includes('Pioneer')) playerColor = 0x9B59B6;
                        else if (playerRank.includes('Scout')) playerColor = 0x2ECC71;
                        else if (playerRank.includes('VIP')) playerColor = 0xF1C40F;
                    }
                    
                    const embed = new EmbedBuilder()
                        .setColor(playerColor)
                        .setAuthor({
                            name: playerRank ? `${playerName} [${playerRank}]` : playerName,
                            iconURL: `https://mc-heads.net/avatar/${playerName}/32`
                        })
                        .setDescription(`💬 ${cleanMessage}`)
                        .setTimestamp()
                        .setFooter({ 
                            text: `🎮 ${config.minecraft.host} • Player Chat`, 
                            iconURL: 'https://mc-heads.net/avatar/MHF_Steve/16'
                        });

                    await this.channels.logs.send({ embeds: [embed] }).catch(err => {
                        logger.error('Failed to send player message embed:', err);
                        throw err;
                    });
                } else {
                    let messageColor = 0x57F287;
                    let messageCategory = 'Server Message';
                    let authorName = 'Server System';
                    let authorIcon = 'https://mc-heads.net/avatar/MHF_Question/32';
                    
                    let detectedPlayer = null;
                    
                    if (message.includes('joined the game')) {
                        const joinMatch = message.match(/^(\w+) joined the game/);
                        detectedPlayer = joinMatch ? joinMatch[1] : null;
                        messageColor = 0x2ECC71;
                        messageCategory = 'Player Joined';
                    } else if (message.includes('left the game')) {
                        const leaveMatch = message.match(/^(\w+) left the game/);
                        detectedPlayer = leaveMatch ? leaveMatch[1] : null;
                        messageColor = 0xE67E22;
                        messageCategory = 'Player Left';
                    } else if (message.includes('vote') || message.includes('Vote')) {
                        messageColor = 0x3498DB;
                        messageCategory = 'Vote Reminder';
                    } else if (message.includes('PLAYERWARPS') || message.includes('warp')) {
                        messageColor = 0x9B59B6;
                        messageCategory = 'Player Warp';
                    } else if (message.includes('death') || message.includes('killed') || message.includes('died')) {
                        const deathMatch = message.match(/^(\w+) (was|died|killed)/);
                        detectedPlayer = deathMatch ? deathMatch[1] : null;
                        messageColor = 0xE74C3C;
                        messageCategory = 'Death Event';
                    } else if (message.includes('achievement') || message.includes('advancement')) {
                        const achievementMatch = message.match(/^(\w+) has (made the advancement|completed the challenge|reached the goal)/);
                        detectedPlayer = achievementMatch ? achievementMatch[1] : null;
                        messageColor = 0xF1C40F;
                        messageCategory = 'Achievement';
                    }
                    
                    if (detectedPlayer) {
                        authorName = detectedPlayer;
                        authorIcon = `https://mc-heads.net/avatar/${detectedPlayer}/32`;
                    }

                    const embed = new EmbedBuilder()
                        .setColor(messageColor)
                        .setAuthor({
                            name: authorName,
                            iconURL: authorIcon
                        })
                        .setDescription(`${message}`)
                        .setTimestamp()
                        .setFooter({ 
                            text: `${messageCategory} • ${config.minecraft.host}`, 
                            iconURL: 'https://mc-heads.net/avatar/MHF_Exclamation/16'
                        });

                    await this.channels.logs.send({ embeds: [embed] }).catch(err => {
                        logger.error('Failed to send server message embed:', err);
                        throw err;
                    });
                }
            }
        } catch (error) {
            logger.error('Failed to send chat message:', error?.message || JSON.stringify(error) || 'Unknown error');
        }
    }

    async sendBatchedMessages(messages) {
        if (!this.isConnected || !this.channels.logs) return;

        try {
            let description = messages.join('\n');
            if (description.length > 1900) {
                description = description.substring(0, 1900) + '... (truncated)';
            }

            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setAuthor({
                    name: 'Server System',
                    iconURL: 'https://mc-heads.net/avatar/MHF_Question/32'
                })
                .setDescription(`${description}`)
                .setTimestamp()
                .setFooter({ 
                    text: `${messages.length} messages • ${config.minecraft.host}`, 
                    iconURL: 'https://mc-heads.net/avatar/MHF_Exclamation/16'
                });

            await this.channels.logs.send({ embeds: [embed] });
            logger.debug(`Successfully sent ${messages.length} batched server messages`);
        } catch (error) {
            logger.error('Failed to send batched messages:', error.message || error);
        }
    }

    batchMessage(message, isServerMessage = false) {
        if (!isServerMessage) {
            return false;
        }

        const now = Date.now();
        const batchKey = Math.floor(now / 2000);

        if (!this.pendingMessages.has(batchKey)) {
            this.pendingMessages.set(batchKey, []);
        }

        this.pendingMessages.get(batchKey).push(message);

        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
        }

        this.batchTimeout = setTimeout(() => {
            this.flushBatchedMessages();
        }, 1500);

        logger.debug(`Batched server message: "${message}" (${this.pendingMessages.get(batchKey).length} messages in batch)`);
        return true;
    }

    async flushBatchedMessages() {
        try {
            for (const [timestamp, messages] of this.pendingMessages.entries()) {
                if (messages.length === 1) {
                    await this.sendChatMessage('Server', messages[0], true);
                } else if (messages.length > 1) {
                    logger.info(`Sending ${messages.length} batched server messages`);
                    await this.sendBatchedMessages(messages);
                }
            }
        } catch (error) {
            logger.error('Failed to flush batched messages:', error);
        } finally {
            this.pendingMessages.clear();
            this.batchTimeout = null;
        }
    }

    // ========================================================================
    // EMBED MESSAGES
    // ========================================================================

    async sendStatusEmbed(title, description, color = 0x00FF00) {
        if (this.statusUpdateInProgress) {
            logger.debug('Status update already in progress, skipping duplicate');
            return;
        }
        
        this.statusUpdateInProgress = true;
        
        try {
            const bot = this.minecraftBot;
            const isOnline = bot?.isConnected;
            const playerCount = bot?.players?.size || 0;
            const displayUsername = bot?.detectedUsername || bot?.bot?.username || config.minecraft.username || 'Unknown';
            const position = bot?.bot?.entity?.position;
            const dimension = bot?.bot?.game?.dimension || 'Unknown';
            
            let statusText = description;
            let embedColor = color;
            let statusIcon = '🔴';
            
            if (title.includes('Connected') || description.includes('connected') || description.includes('online')) {
                statusText = `🟢 **ONLINE & ACTIVE** • Successfully connected to \`${config.minecraft.host}\`\n✨ Bot is monitoring chat and ready for commands`;
                embedColor = 0x00FF41;
                statusIcon = '🟢';
            } else if (title.includes('Disconnected') || description.includes('disconnected') || description.includes('offline')) {
                statusText = `🔴 **OFFLINE** • Lost connection to \`${config.minecraft.host}\`\n🔄 Auto-reconnect will attempt to restore connection`;
                embedColor = 0xFF4757;
                statusIcon = '🔴';
            } else if (title.includes('Starting') || description.includes('initializing') || description.includes('starting')) {
                statusText = `🟡 **INITIALIZING** • Establishing secure connection to \`${config.minecraft.host}\`\n⏳ Please wait while the bot connects...`;
                embedColor = 0xFFA502;
                statusIcon = '🟡';
            } else if (title.includes('Authentication') || description.includes('authenticate')) {
                statusText = `🟣 **AUTH REQUIRED** • Microsoft authentication needed\n🔐 Please complete authentication to continue`;
                embedColor = 0x9B59B6;
                statusIcon = '🟣';
            } else if (title.includes('Error') || title.includes('Failed') || description.includes('error') || description.includes('failed')) {
                statusText = `🔴 **CONNECTION FAILED** • Unable to reach \`${config.minecraft.host}\`\n❌ ${description}`;
                embedColor = 0xFF3838;
                statusIcon = '🔴';
            } else if (title.includes('Kicked')) {
                statusText = `⚠️ **KICKED FROM SERVER** • \`${config.minecraft.host}\`\n🚫 ${description}`;
                embedColor = 0xFF8C00;
                statusIcon = '⚠️';
            } else if (title.includes('Walk') || title.includes('walking')) {
                statusText = `🚶 **MOVEMENT ACTIVE** • Bot is executing movement command\n📍 ${description}`;
                embedColor = 0x3498DB;
                statusIcon = '🚶';
            } else if (title.includes('Respawn') || title.includes('Died')) {
                statusText = `💀 **RESPAWNED** • Bot died and has been automatically respawned\n🏥 Health restored, continuing operations`;
                embedColor = 0xFF6B6B;
                statusIcon = '💀';
            }

            const embed = new EmbedBuilder()
            .setColor(embedColor)
            .setTitle(`${statusIcon} ${displayUsername}`)
            .setDescription(statusText)
            .addFields(
                { 
                    name: 'Server', 
                    value: `\`${config.minecraft.host}\``, 
                    inline: true 
                },
                { 
                    name: 'Players', 
                    value: `${playerCount} online`, 
                    inline: true 
                },
                { 
                    name: 'Dimension', 
                    value: isOnline ? dimension : 'N/A', 
                    inline: true 
                }
            );

            if (isOnline && position) {
                embed.addFields({
                    name: 'Coordinates',
                    value: `X: ${Math.round(position.x)}, Y: ${Math.round(position.y)}, Z: ${Math.round(position.z)}`,
                    inline: false
                });
            }

            embed.setTimestamp();

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('bot_connect')
                        .setLabel('Connect')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('✅'),
                    new ButtonBuilder()
                        .setCustomId('bot_disconnect')
                        .setLabel('Disconnect')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('❌')
                );

            if (!this.isConnected) {
                this.messageQueue.push({embed, row, channelType: 'status', isStatusUpdate: true});
                return;
            }

            if (this.channels.status) {
                if (this.statusMessageId) {
                    try {
                        const message = await this.channels.status.messages.fetch(this.statusMessageId);
                        await message.edit({ embeds: [embed], components: [row] });
                        logger.debug('Updated existing status message');
                        return;
                    } catch (fetchError) {
                        logger.warn(`Failed to fetch existing status message (ID: ${this.statusMessageId}), creating new one`);
                        this.statusMessageId = null;
                    }
                }
                
                const message = await this.channels.status.send({ embeds: [embed], components: [row] });
                this.statusMessageId = message.id;
                this.saveMessageIds();
                logger.info(`Created and persisted status message with ID: ${this.statusMessageId}`);
            }
        } catch (error) {
            logger.error('Failed to send status embed:', error.message || error);
        } finally {
            this.statusUpdateInProgress = false;
        }
    }

    async sendPlayerListEmbed(players) {
        if (this.playerListUpdateInProgress) {
            logger.debug('Player list update already in progress, skipping duplicate');
            return;
        }
        
        this.playerListUpdateInProgress = true;
        
        try {
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`👥 Players (${players.length})`)
                .setDescription(players.length > 0 ? players.map(p => `• ${p}`).join('\n') : 'No players online')
                .setTimestamp();

            if (!this.isConnected) {
                this.messageQueue.push({embed, channelType: 'playerList'});
                return;
            }

            if (this.channels.playerList) {
                if (this.playerListMessageId) {
                    try {
                        const message = await this.channels.playerList.messages.fetch(this.playerListMessageId);
                        await message.edit({ embeds: [embed] });
                        logger.debug('Player list updated successfully');
                        return;
                    } catch (fetchError) {
                        logger.warn(`Failed to fetch existing player list message (ID: ${this.playerListMessageId}), creating new one`);
                        this.playerListMessageId = null;
                    }
                }
                
                const sentMessage = await this.channels.playerList.send({ embeds: [embed] });
                this.playerListMessageId = sentMessage.id;
                this.saveMessageIds();
                logger.info(`Created and persisted player list message with ID: ${this.playerListMessageId}`);
            }
        } catch (error) {
            logger.error('Failed to send player list embed:', error.message || error);
        } finally {
            this.playerListUpdateInProgress = false;
        }
    }

    async sendLoginEmbed(authCode, authUrl) {
        const embed = new EmbedBuilder()
            .setColor(0xFF9900)
            .setDescription(`🔐 **Auth Required**\n\n[Click to authenticate](${authUrl})\n\nCode: \`${authCode}\``);

        if (!this.isConnected) {
            this.messageQueue.push({embed, channelType: 'login'});
            return;
        }

        if (this.channels.login) {
            try {
                const messageContent = config.discord.pingUserId ? `<@${config.discord.pingUserId}>` : '';
                    
                const sentMessage = await this.channels.login.send({ 
                    content: messageContent,
                    embeds: [embed] 
                });
                
                this.authMessageId = sentMessage.id;
                logger.info('Auth embed sent to Discord');
            } catch (error) {
                logger.error('Failed to send auth embed:', error);
            }
        }
    }

    async deleteAuthMessage() {
        if (this.authMessageId && this.channels.login) {
            try {
                const message = await this.channels.login.messages.fetch(this.authMessageId);
                await message.delete();
                logger.info('Auth message deleted');
                this.authMessageId = null;
            } catch (error) {
                logger.debug('Failed to delete auth message:', error.message);
            }
        }
    }

    async sendWebhookMessage(message) {
        try {
            const response = await fetch(this.webhook, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    content: message,
                    username: 'Minecraft Bot'
                })
            });

            if (!response.ok) {
                throw new Error(`Webhook request failed: ${response.status} ${response.statusText}`);
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            logger.error('Failed to send webhook message:', error);
            throw error;
        }
    }

    async processMessageQueue() {
        if (this.isProcessingQueue || this.messageQueue.length === 0) {
            return;
        }

        if (this.messageQueue.length > 100) {
            logger.warn(`Message queue overflow detected (${this.messageQueue.length} messages), clearing old messages`);
            this.messageQueue.splice(0, this.messageQueue.length - 50);
        }

        this.isProcessingQueue = true;
        logger.info(`Processing ${this.messageQueue.length} queued messages`);

        while (this.messageQueue.length > 0 && this.isConnected) {
            const item = this.messageQueue.shift();
            const retryKey = JSON.stringify(item);
            const retryCount = this.queueRetries.get(retryKey) || 0;
            
            try {
                if (this.webhook) {
                    await this.sendWebhookMessage(item.message || item.embed?.data?.description || 'Message');
                } else if (item.embed) {
                    const channel = this.channels[item.channelType] || this.channels.logs;
                    if (item.row) {
                        await channel.send({ embeds: [item.embed], components: [item.row] });
                    } else {
                        await channel.send({ embeds: [item.embed] });
                    }
                } else if (item.message) {
                    const channel = this.channels[item.channelType] || this.channels.logs;
                    await channel.send(item.message);
                }
                
                this.queueRetries.delete(retryKey);
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                logger.error('Failed to send queued message:', error);
                
                if (retryCount < this.maxQueueRetries) {
                    this.queueRetries.set(retryKey, retryCount + 1);
                    this.messageQueue.push(item);
                    const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 30000);
                    logger.warn(`Requeued message (attempt ${retryCount + 1}/${this.maxQueueRetries}), backing off ${backoffDelay}ms`);
                    await new Promise(resolve => setTimeout(resolve, backoffDelay));
                } else {
                    logger.error(`CRITICAL: Message dropped after ${this.maxQueueRetries} retries - Discord may be experiencing issues`);
                    this.queueRetries.delete(retryKey);
                    
                    if (this.minecraftBot && this.minecraftBot.isConnected) {
                        try {
                            this.minecraftBot.bot.chat('[Bot] Warning: Discord message queue experiencing failures');
                        } catch (e) {
                            logger.debug('Failed to send in-game alert:', e.message);
                        }
                    }
                }
                break;
            }
        }

        this.isProcessingQueue = false;
    }

    // ========================================================================
    // SLASH COMMAND HANDLING
    // ========================================================================

    async handleSlashCommand(interaction) {
        const { commandName } = interaction;
        const startTime = Date.now();

        const requiresConnection = ['message', 'walk', 'location', 'health', 'jump', 'look', 'stop'];
        if (requiresConnection.includes(commandName) && (!this.minecraftBot || !this.minecraftBot.isConnected || !this.minecraftBot.bot)) {
            return await interaction.reply({ 
                content: '❌ Bot is not connected to Minecraft server', 
                ephemeral: true 
            });
        }

        try {
            switch (commandName) {
                case 'message': {
                    const content = interaction.options.getString('content');
                    await this.minecraftBot.sendChatMessage(content);
                    await interaction.reply({ 
                        content: `📨 Message sent: "${content}"`, 
                        ephemeral: true 
                    });
                    logger.info(`Discord user sent message to Minecraft: "${content}"`);
                    break;
                }

                case 'walk': {
                    const blocks = interaction.options.getInteger('blocks');
                    await this.minecraftBot.walkForward(blocks);
                    await interaction.reply({ 
                        content: `🚶 Bot is walking ${blocks} blocks forward`, 
                        ephemeral: true 
                    });
                    logger.info(`Discord user commanded bot to walk ${blocks} blocks forward`);
                    break;
                }

                case 'players': {
                    const players = this.minecraftBot ? Array.from(this.minecraftBot.players) : [];
                    const embed = new EmbedBuilder()
                        .setColor(0x00FF00)
                        .setTitle('🎮 Online Players')
                        .setDescription(players.length > 0 ? players.map(player => `👤 ${player}`).join('\n') : '🚫 No players online')
                        .addFields({ name: '📊 Total Players', value: `${players.length}`, inline: true })
                        .setTimestamp();
                    
                    await interaction.reply({ embeds: [embed], ephemeral: true });
                    break;
                }

                case 'status': {
                    const bot = this.minecraftBot;
                    const isOnline = bot?.isConnected;
                    const playerCount = bot?.players?.size || 0;
                    const displayUsername = bot?.detectedUsername || bot?.bot?.username || config.minecraft.username || 'Unknown';
                    const position = bot?.bot?.entity?.position;
                    const dimension = bot?.bot?.game?.dimension || 'Unknown';
                    
                    const embed = new EmbedBuilder()
                        .setColor(isOnline ? 0x2ECC71 : 0xE74C3C)
                        .setTitle('Bot Status')
                        .setDescription(isOnline ? 
                            `Connected to **${config.minecraft.host}** as **${displayUsername}**` : 
                            `Disconnected from **${config.minecraft.host}**`
                        )
                        .addFields(
                            { 
                                name: 'Server Info', 
                                value: `**Host:** ${config.minecraft.host}\n**Port:** ${config.minecraft.port}\n**Version:** ${config.minecraft.version}`, 
                                inline: true 
                            },
                            { 
                                name: 'Connection', 
                                value: `**Status:** ${isOnline ? 'Online' : 'Offline'}\n**Players:** ${playerCount}\n**Reconnect Attempts:** ${bot?.reconnectAttempts || 0}`, 
                                inline: true 
                            },
                            { 
                                name: 'Features', 
                                value: `**Anti-AFK:** ${config.minecraft.enableAntiAfk ? 'Enabled' : 'Disabled'}\n**Auth:** Microsoft\n**Auto-Reconnect:** Enabled`, 
                                inline: true 
                            }
                        );

                    if (isOnline && position) {
                        embed.addFields({
                            name: 'Current Position',
                            value: `**Dimension:** ${dimension}\n**X:** ${Math.round(position.x)}, **Y:** ${Math.round(position.y)}, **Z:** ${Math.round(position.z)}`,
                            inline: false
                        });
                    }

                    embed.setFooter({ text: `Bot Username: ${displayUsername}` })
                        .setTimestamp();
                    
                    await interaction.reply({ embeds: [embed], ephemeral: true });
                    break;
                }

                case 'ping': {
                    const responseTime = Date.now() - startTime;
                    const embed = new EmbedBuilder()
                        .setColor(0x00FFFF)
                        .setTitle('🏓 Pong!')
                        .addFields(
                            { name: '⚡ Discord Response', value: `${responseTime}ms`, inline: true },
                            { name: '🌐 WebSocket Ping', value: `${this.client.ws.ping}ms`, inline: true },
                            { name: '🔌 Bot Status', value: this.minecraftBot?.isConnected ? '🟢 Online' : '🔴 Offline', inline: true }
                        )
                        .setTimestamp();
                    
                    await interaction.reply({ embeds: [embed], ephemeral: true });
                    break;
                }

                case 'help': {
                    const embed = new EmbedBuilder()
                        .setColor(0x0099FF)
                        .setTitle('🎮 Bot Commands')
                        .setDescription('Here are all the available commands:')
                        .addFields(
                            { name: '💬 Chat Commands', value: '`/message` - Send a message to the server', inline: false },
                            { name: '🚶 Movement Commands', value: '`/walk` - Walk forward\n`/jump` - Jump in place\n`/look` - Look in a direction\n`/stop` - Stop all movement', inline: false },
                            { name: '📊 Information Commands', value: '`/players` - Show online players\n`/status` - Show bot status\n`/ping` - Check connectivity\n`/location` - Show bot position\n`/health` - Show bot health', inline: false },
                            { name: '❓ Utility Commands', value: '`/help` - Show this help message', inline: false }
                        )
                        .setFooter({ text: 'Use these commands to control the Minecraft bot!' })
                        .setTimestamp();
                    
                    await interaction.reply({ embeds: [embed], ephemeral: true });
                    break;
                }

                case 'location': {
                    if (!this.minecraftBot.bot?.entity?.position) {
                        return await interaction.reply({ content: '❌ Unable to get bot location', ephemeral: true });
                    }
                    
                    const pos = this.minecraftBot.bot.entity.position;
                    const embed = new EmbedBuilder()
                        .setColor(0xFF9900)
                        .setTitle('📍 Bot Location')
                        .addFields(
                            { name: '🌍 Dimension', value: this.minecraftBot.bot.game?.dimension || 'Unknown', inline: true },
                            { name: '📐 Coordinates', value: `X: ${Math.round(pos.x)}\nY: ${Math.round(pos.y)}\nZ: ${Math.round(pos.z)}`, inline: true },
                            { name: '🧭 Direction', value: this.getDirectionFromYaw(this.minecraftBot.bot.entity.yaw), inline: true }
                        )
                        .setTimestamp();
                    
                    await interaction.reply({ embeds: [embed], ephemeral: true });
                    break;
                }

                case 'health': {
                    const bot = this.minecraftBot.bot;
                    if (!bot) {
                        return await interaction.reply({ content: '❌ Bot data unavailable', ephemeral: true });
                    }
                    
                    const healthColor = bot.health > 15 ? 0x00FF00 : bot.health > 10 ? 0xFFAA00 : 0xFF0000;
                    const embed = new EmbedBuilder()
                        .setColor(healthColor)
                        .setTitle('💖 Bot Health Status')
                        .addFields(
                            { name: '❤️ Health', value: `${bot.health || 0}/20`, inline: true },
                            { name: '🍗 Food', value: `${bot.food || 0}/20`, inline: true },
                            { name: '💨 Saturation', value: `${Math.round(bot.foodSaturation || 0)}`, inline: true },
                            { name: '🎚️ Experience', value: `Level ${bot.experience?.level || 0} (${bot.experience?.points || 0} points)`, inline: false }
                        )
                        .setTimestamp();
                    
                    await interaction.reply({ embeds: [embed], ephemeral: true });
                    break;
                }

                case 'jump': {
                    const times = interaction.options.getInteger('times') || 1;
                    await this.minecraftBot.performJump(times);
                    await interaction.reply({ 
                        content: `🦘 Bot is jumping ${times} time${times > 1 ? 's' : ''}!`, 
                        ephemeral: true 
                    });
                    break;
                }

                case 'look': {
                    const direction = interaction.options.getString('direction');
                    await this.minecraftBot.lookDirection(direction);
                    await interaction.reply({ 
                        content: `👀 Bot is looking ${direction}`, 
                        ephemeral: true 
                    });
                    break;
                }

                case 'stop': {
                    await this.minecraftBot.stopAllActions();
                    await interaction.reply({ 
                        content: '🛑 All bot actions stopped', 
                        ephemeral: true 
                    });
                    break;
                }

                default:
                    await interaction.reply({ 
                        content: '❌ Unknown command', 
                        ephemeral: true 
                    });
            }
        } catch (error) {
            logger.error(`Failed to execute command ${commandName}:`, error);
            const errorMessage = error.message || 'An unknown error occurred';
            
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ 
                    content: `❌ Command failed: ${errorMessage}`, 
                    ephemeral: true 
                });
            } else {
                await interaction.reply({ 
                    content: `❌ Command failed: ${errorMessage}`, 
                    ephemeral: true 
                });
            }
        }
    }

    // ========================================================================
    // UTILITY FUNCTIONS
    // ========================================================================

    getDirectionFromYaw(yaw) {
        const angle = ((yaw * 180) / Math.PI + 180) % 360;
        const directions = ['South', 'Southwest', 'West', 'Northwest', 'North', 'Northeast', 'East', 'Southeast'];
        return directions[Math.round(angle / 45) % 8];
    }

    setMinecraftBot(minecraftBot) {
        this.minecraftBot = minecraftBot;
    }

    // ========================================================================
    // BOT STATUS MANAGEMENT
    // ========================================================================

    async setStatus(state, additionalInfo = '') {
        if (!this.client || !this.client.user) return;

        try {
            let status, activity;

            switch (state) {
                case 'startup':
                    activity = {
                        name: 'Starting up...',
                        type: 0
                    };
                    status = 'idle';
                    break;
                case 'authentication':
                    activity = {
                        name: 'Authentication Mode',
                        type: 0
                    };
                    status = 'dnd';
                    break;
                case 'disconnected':
                    activity = {
                        name: 'Not connected',
                        type: 0
                    };
                    status = 'dnd';
                    break;
                case 'connected':
                    activity = {
                        name: `Connected${additionalInfo}`,
                        type: 0
                    };
                    status = 'online';
                    break;
                case 'error':
                    activity = {
                        name: 'Connection Error',
                        type: 0
                    };
                    status = 'dnd';
                    break;
                default:
                    activity = {
                        name: 'Minecraft Bridge Bot',
                        type: 0
                    };
                    status = 'online';
            }

            await this.client.user.setPresence({
                activities: [activity],
                status: status
            });

            logger.info(`Discord status updated: ${activity.name} (${status})`);
        } catch (error) {
            logger.error('Failed to set Discord status:', error);
        }
    }

    async disconnect() {
        if (this.client && this.isConnected) {
            logger.info('Disconnecting from Discord...');

            if (this.channels.status) {
                try {
                    await this.sendStatusEmbed('🔴 Shutting Down', 'Minecraft bot is shutting down...', 0xFF0000);
                } catch (error) {
                    logger.error('Failed to send shutdown message:', error);
                }
            }

            this.client.destroy();
            this.isConnected = false;
        }
    }

    async sendKeywordAlert(sender, message, userId) {
        try {
            if (!this.client) {
                logger.warn('Cannot send DM - Discord client not available');
                return;
            }

            const user = await this.client.users.fetch(userId);
            const messageLink = `Message from **${sender}**: ${message}`;
            
            await user.send(messageLink);
            logger.info(`Keyword alert sent to user ${userId}: ${sender} mentioned keywords`);
        } catch (error) {
            logger.error('Failed to send keyword alert DM:', error);
        }
    }
}

module.exports = DiscordClient;
