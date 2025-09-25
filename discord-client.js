const { Client, GatewayIntentBits, ChannelType, EmbedBuilder, SlashCommandBuilder, REST, Routes, Partials } = require('discord.js');
const fetch = require('node-fetch');
const config = require('./config');
const logger = require('./logger');

class DiscordClient {
    constructor() {
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
        this.pendingMessages = new Map(); // For batching messages by timestamp
        this.batchTimeout = null;
        this.minecraftBot = null; // Reference to minecraft bot for sending messages
        this.statusMessageId = null; // Persistent status message for reactions
        this.playerListMessageId = null; // Persistent player list message
        this.reactionDebounce = new Map(); // Prevent reaction spam
    }

    async connect() {
        if (config.discord.webhook) {
            // Use webhook for sending messages
            this.webhook = config.discord.webhook;
            this.isConnected = true;
            logger.info('Using Discord webhook for message sending');
            return;
        }

        // Use Discord bot
        try {
            logger.info('Connecting to Discord...');

            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.GuildMessageReactions
                ],
                partials: [
                    Partials.Message,
                    Partials.Channel,
                    Partials.Reaction,
                    Partials.User
                ]
            });

            this.client.once('ready', async () => {
                logger.info(`Discord bot logged in as ${this.client.user.tag}`);
                await this.setupSlashCommands();
                try {
                    await this.setupChannels();
                } catch (error) {
                    logger.warn('Continuing without full channel setup:', error.message);
                }
                this.isConnected = true;
                // Set initial status
                await this.setStatus('startup');
            });

            this.client.on('error', (error) => {
                logger.error('Discord client error:', error);
            });

            this.client.on('disconnect', () => {
                logger.warn('Discord client disconnected');
                this.isConnected = false;
            });

            // Handle slash command interactions
            this.client.on('interactionCreate', async (interaction) => {
                if (!interaction.isChatInputCommand()) return;
                await this.handleSlashCommand(interaction);
            });

            // Handle reaction-based bot control
            this.client.on('messageReactionAdd', async (reaction, user) => {
                await this.handleReactionAdd(reaction, user);
            });

            await this.client.login(config.discord.token);
        } catch (error) {
            logger.error('Failed to connect to Discord:', error);
            throw error;
        }
    }

    async setupSlashCommands() {
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
            // Setup critical channels (required)
            const criticalChannels = ['logs', 'login', 'status'];
            // Setup optional channels
            const optionalChannels = ['playerList'];

            // Setup critical channels first
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

            // Setup optional channels (skip if they fail)
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

            // Send startup status embed
            await this.sendStatusEmbed('Starting up', 'Minecraft bot is initializing...', 0xFFFF00);

            // Process any queued messages
            this.processMessageQueue();
        } catch (error) {
            logger.error('Failed to setup Discord channels:', error);
            throw error;
        }
    }

    async handleReactionAdd(reaction, user) {
        try {
            // Handle partial reactions
            if (reaction.partial) {
                try {
                    await reaction.fetch();
                } catch (error) {
                    logger.warn('Failed to fetch partial reaction:', error.message);
                    return;
                }
            }
            
            // Ignore bot reactions
            if (user.bot) return;
            
            // Only handle reactions on our status message
            if (!this.statusMessageId || reaction.message.id !== this.statusMessageId) return;
            
            // Check if this is in the status channel
            if (!this.channels.status || reaction.message.channel.id !== this.channels.status.id) return;
            
            // Basic authorization - only allow members with admin permissions or manage server
            const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
            if (!member || (!member.permissions.has('Administrator') && !member.permissions.has('ManageGuild'))) {
                logger.warn(`${user.username} attempted to control bot without permissions`);
                // Remove the reaction
                try {
                    await reaction.users.remove(user.id);
                } catch (removeError) {
                    logger.debug('Failed to remove unauthorized reaction:', removeError.message);
                }
                return;
            }
            
            // Debounce to prevent reaction spam
            const userId = user.id;
            const debounceKey = `${userId}_${reaction.emoji.name}`;
            
            if (this.reactionDebounce.has(debounceKey)) {
                const lastReaction = this.reactionDebounce.get(debounceKey);
                if (Date.now() - lastReaction < 3000) { // 3 second cooldown
                    logger.debug(`Reaction debounced for user ${user.username}`);
                    return;
                }
            }
            
            this.reactionDebounce.set(debounceKey, Date.now());
            
            // Handle different reactions
            const emojiName = reaction.emoji.name;
            
            if (emojiName === '✅') {
                // Connect/Resume bot
                logger.info(`${user.username} requested bot connection via reaction`);
                
                if (this.minecraftBot && !this.minecraftBot.isConnected) {
                    this.minecraftBot.shouldReconnect = true;
                    this.minecraftBot.resumeReconnect();
                    await this.sendStatusEmbed('🔄 Connecting...', 'Connection requested via Discord reaction', 0xFFAA00);
                } else if (this.minecraftBot && this.minecraftBot.isConnected) {
                    logger.info('Bot is already connected');
                }
                
            } else if (emojiName === '❌') {
                // Shutdown bot - disable reconnection
                logger.info(`${user.username} requested bot shutdown via reaction`);
                
                if (this.minecraftBot) {
                    this.minecraftBot.shouldReconnect = false;
                    if (this.minecraftBot.isConnected) {
                        await this.minecraftBot.disconnect();
                    }
                    await this.sendStatusEmbed('⛔ Shutdown', 'Bot manually stopped via Discord reaction', 0xE74C3C);
                } else {
                    logger.info('Bot is already disconnected');
                }
            }
            
            // Remove the user's reaction for cleanliness (optional)
            try {
                await reaction.users.remove(user.id);
            } catch (removeError) {
                logger.debug('Failed to remove user reaction:', removeError.message);
            }
            
        } catch (error) {
            logger.error('Error handling reaction:', error);
        }
    }

    async sendMessage(message, channelType = 'logs') {
        if (!message || typeof message !== 'string') {
            logger.warn('Invalid message provided to sendMessage');
            return;
        }

        // Truncate very long messages
        if (message.length > 1900) {
            message = message.substring(0, 1900) + '... (truncated)';
        }

        if (!this.isConnected) {
            // Queue message if not connected
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
            // Re-queue message on failure
            this.messageQueue.unshift({message, channelType});
        }
    }

    async sendChatMessage(playerName, message, isServerMessage = false) {
        if (!this.isConnected) {
            this.messageQueue.push({message: `**${playerName}**: ${message}`, channelType: 'logs'});
            return;
        }

        try {
            if (this.channels.logs) {
                if (!isServerMessage) {
                    // Enhanced player message format with rank detection
                    const rankMatch = message.match(/^\[([^\]]+)\]/);
                    const cleanMessage = rankMatch ? message.replace(/^\[[^\]]+\]\s*/, '') : message;
                    const playerRank = rankMatch ? rankMatch[1] : null;
                    
                    // Determine color based on rank
                    let playerColor = 0x5865F2; // Default Discord blurple
                    if (playerRank) {
                        if (playerRank.includes('AGENT')) playerColor = 0xFF0000; // Red for agents
                        else if (playerRank.includes('Pioneer')) playerColor = 0x9B59B6; // Purple for pioneers
                        else if (playerRank.includes('Scout')) playerColor = 0x2ECC71; // Green for scouts
                        else if (playerRank.includes('VIP')) playerColor = 0xF1C40F; // Gold for VIP
                    }
                    
                    const embed = new EmbedBuilder()
                        .setColor(playerColor)
                        .setAuthor({
                            name: playerRank ? `${playerName} [${playerRank}]` : playerName,
                            iconURL: `https://mc-heads.net/avatar/${playerName}/32`
                        })
                        .setDescription(`💬 **${cleanMessage}**`)
                        .setTimestamp()
                        .setFooter({ 
                            text: `🎮 ${config.minecraft.host} • Player Chat`, 
                            iconURL: 'https://mc-heads.net/avatar/MHF_Steve/16'
                        });

                    await this.channels.logs.send({ embeds: [embed] });
                } else {
                    // Enhanced server message format with better categorization
                    let messageColor = 0x57F287; // Default green
                    let messageIcon = '📢';
                    let messageCategory = 'Server Message';
                    let authorName = 'Server System';
                    let authorIcon = 'https://mc-heads.net/avatar/MHF_Question/32';
                    
                    // Extract player name from server messages for avatar
                    let detectedPlayer = null;
                    
                    // Try to extract player name from various message formats
                    if (message.includes('joined the game')) {
                        const joinMatch = message.match(/^(\w+) joined the game/);
                        detectedPlayer = joinMatch ? joinMatch[1] : null;
                        messageColor = 0x2ECC71; // Green for joins
                        messageIcon = '📥';
                        messageCategory = 'Player Joined';
                    } else if (message.includes('left the game')) {
                        const leaveMatch = message.match(/^(\w+) left the game/);
                        detectedPlayer = leaveMatch ? leaveMatch[1] : null;
                        messageColor = 0xE67E22; // Orange for leaves
                        messageIcon = '📤';
                        messageCategory = 'Player Left';
                    } else if (message.includes('vote') || message.includes('Vote')) {
                        messageColor = 0x3498DB; // Blue for voting
                        messageIcon = '🗳️';
                        messageCategory = 'Vote Reminder';
                    } else if (message.includes('PLAYERWARPS') || message.includes('warp')) {
                        messageColor = 0x9B59B6; // Purple for warps
                        messageIcon = '🌀';
                        messageCategory = 'Player Warp';
                    } else if (message.includes('death') || message.includes('killed') || message.includes('died')) {
                        // Try to extract player name from death messages
                        const deathMatch = message.match(/^(\w+) (was|died|killed)/);
                        detectedPlayer = deathMatch ? deathMatch[1] : null;
                        messageColor = 0xE74C3C; // Red for death
                        messageIcon = '💀';
                        messageCategory = 'Death Event';
                    } else if (message.includes('achievement') || message.includes('advancement')) {
                        // Try to extract player name from advancement messages
                        const achievementMatch = message.match(/^(\w+) has (made the advancement|completed the challenge|reached the goal)/);
                        detectedPlayer = achievementMatch ? achievementMatch[1] : null;
                        messageColor = 0xF1C40F; // Yellow for achievements
                        messageIcon = '🏆';
                        messageCategory = 'Achievement';
                    }
                    
                    // If we detected a player, use their head as the icon
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
                        .setDescription(`**${message}**`)
                        .setTimestamp()
                        .setFooter({ 
                            text: `${messageCategory} • ${config.minecraft.host}`, 
                            iconURL: 'https://mc-heads.net/avatar/MHF_Exclamation/16'
                        });

                    await this.channels.logs.send({ embeds: [embed] });
                }
            }
        } catch (error) {
            logger.error('Failed to send chat message:', error.message || error);
            // Don't re-throw the error to prevent crashes
        }
    }

    async sendBatchedMessages(messages) {
        if (!this.isConnected || !this.channels.logs) return;

        try {
            // Create single embed with multiple messages
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setAuthor({
                    name: 'Server',
                    iconURL: 'https://imgs.search.brave.com/aUkZZuWoExfFjdH1fwS8tmTkcegNAcx9v32Cs3n3rmc/rs:fit:860:0:0:0/g:ce/aHR0cHM6Ly9pLnBp/bmltZy5jb20vb3Jp/Z2luYWxzLzVhL2Vk/L2ZmLzVhZWRmZjAz/NmNmMGI3MDQ5NTE2/ZTZhYzM1ODRmYWI2/LmpwZw'
                })
                .setDescription(messages.join('\n'))
                .setTimestamp()
                .setFooter({ text: 'Minecraft Chat' });

            await this.channels.logs.send({ embeds: [embed] });
        } catch (error) {
            logger.error('Failed to send batched messages:', error.message || error);
        }
    }

    batchMessage(message, isServerMessage = false) {
        if (!isServerMessage) {
            // Player messages send immediately and directly
            return false;
        }

        const now = Date.now();
        const batchKey = Math.floor(now / 1000); // Group by second

        if (!this.pendingMessages.has(batchKey)) {
            this.pendingMessages.set(batchKey, []);
        }

        this.pendingMessages.get(batchKey).push(message);

        // Clear old batch timeout
        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
        }

        // Set new timeout to send batched messages
        this.batchTimeout = setTimeout(() => {
            this.flushBatchedMessages();
        }, 1000);

        return true; // Message was batched
    }

    async flushBatchedMessages() {
        for (const [timestamp, messages] of this.pendingMessages.entries()) {
            if (messages.length === 1) {
                // Single message - send as regular embed
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setAuthor({
                        name: 'Server',
                        iconURL: 'https://i.imgur.com/5ZzpCmx.png'
                    })
                    .setDescription(messages[0])
                    .setTimestamp()
                    .setFooter({ text: 'Minecraft Chat' });

                if (this.channels.logs) {
                    await this.channels.logs.send({ embeds: [embed] });
                }
            } else if (messages.length > 1) {
                // Multiple messages - batch them
                await this.sendBatchedMessages(messages);
            }
        }

        this.pendingMessages.clear();
        this.batchTimeout = null;
    }

    async sendStatusEmbed(title, description, color = 0x00FF00) {
        // Create rich status embed using the same format as /status command
        const bot = this.minecraftBot;
        const isOnline = bot?.isConnected;
        const playerCount = bot?.players?.size || 0;
        
        // Use detected username if available, fallback to config, never hardcode
        const displayUsername = bot?.detectedUsername || bot?.bot?.username || config.minecraft.username || 'Unknown';
        
        // Get closest player info
        const closestPlayerInfo = bot?.getClosestPlayerInfo?.() || null;
        
        // Determine status and color based on connection state with enhanced descriptions
        let statusText = description;
        let embedColor = color;
        let statusIcon = '🔴';
        
        if (title.includes('Connected') || description.includes('connected') || description.includes('online')) {
            statusText = `🟢 **ONLINE & ACTIVE** • Successfully connected to \`${config.minecraft.host}\`\n✨ Bot is monitoring chat and ready for commands`;
            embedColor = 0x00FF41; // Bright green
            statusIcon = '🟢';
        } else if (title.includes('Disconnected') || description.includes('disconnected') || description.includes('offline')) {
            statusText = `🔴 **OFFLINE** • Lost connection to \`${config.minecraft.host}\`\n🔄 Auto-reconnect will attempt to restore connection`;
            embedColor = 0xFF4757; // Red
            statusIcon = '🔴';
        } else if (title.includes('Starting') || description.includes('initializing') || description.includes('starting')) {
            statusText = `🟡 **INITIALIZING** • Establishing secure connection to \`${config.minecraft.host}\`\n⏳ Please wait while the bot connects...`;
            embedColor = 0xFFA502; // Orange
            statusIcon = '🟡';
        } else if (title.includes('Authentication') || description.includes('authenticate')) {
            statusText = `🟣 **AUTH REQUIRED** • Microsoft authentication needed\n🔐 Please complete authentication to continue`;
            embedColor = 0x9B59B6; // Purple
            statusIcon = '🟣';
        } else if (title.includes('Error') || title.includes('Failed') || description.includes('error') || description.includes('failed')) {
            statusText = `🔴 **CONNECTION FAILED** • Unable to reach \`${config.minecraft.host}\`\n❌ ${description}`;
            embedColor = 0xFF3838; // Bright red
            statusIcon = '🔴';
        } else if (title.includes('Kicked')) {
            statusText = `⚠️ **KICKED FROM SERVER** • \`${config.minecraft.host}\`\n🚫 ${description}`;
            embedColor = 0xFF8C00; // Orange-red
            statusIcon = '⚠️';
        } else if (title.includes('Walk') || title.includes('walking')) {
            statusText = `🚶 **MOVEMENT ACTIVE** • Bot is executing movement command\n📍 ${description}`;
            embedColor = 0x3498DB; // Blue
            statusIcon = '🚶';
        } else if (title.includes('Respawn') || title.includes('Died')) {
            statusText = `💀 **RESPAWNED** • Bot died and has been automatically respawned\n🏥 Health restored, continuing operations`;
            embedColor = 0xFF6B6B; // Light red
            statusIcon = '💀';
        }

        const embed = new EmbedBuilder()
            .setColor(embedColor)
            .setTitle(`${statusIcon} Minecraft Bot Status`)
            .setDescription(statusText)
            .addFields(
                { 
                    name: '🎯 Bot Information', 
                    value: `**Username:** \`${displayUsername}\`\n**Version:** \`${config.minecraft.version}\`\n**Auth:** Microsoft Account`, 
                    inline: true 
                },
                { 
                    name: '🌐 Server Details', 
                    value: `**Host:** \`${config.minecraft.host}\`\n**Port:** \`${config.minecraft.port}\`\n**Status:** ${isOnline ? '🟢 Online' : '🔴 Offline'}`, 
                    inline: true 
                },
                { 
                    name: '👥 Players & Proximity', 
                    value: `**Online:** ${playerCount} player${playerCount !== 1 ? 's' : ''}\n**Closest:** ${closestPlayerInfo ? `${closestPlayerInfo.name} (${closestPlayerInfo.distance}m)` : 'None nearby'}`, 
                    inline: true 
                },
                { 
                    name: '🔧 System Status', 
                    value: `**Anti-AFK:** ${config.minecraft.enableAntiAfk ? '✅ Active' : '❌ Disabled'}\n**Reconnect:** ${bot?.reconnectAttempts || 0}/${config.minecraft.maxReconnectAttempts} attempts\n**Auto-Reconnect:** ✅ Enabled`, 
                    inline: false 
                }
            )
            .setFooter({ 
                text: `${displayUsername} • React ✅ to connect • React ❌ to disconnect`, 
                iconURL: 'https://mc-heads.net/avatar/' + displayUsername + '/16'
            })
            .setTimestamp();

        if (!this.isConnected) {
            this.messageQueue.push({embed, channelType: 'status', isStatusUpdate: true});
            return;
        }

        try {
            if (this.channels.status) {
                let message;
                
                if (this.statusMessageId) {
                    // Try to edit existing persistent status message
                    try {
                        message = await this.channels.status.messages.fetch(this.statusMessageId);
                        await message.edit({ embeds: [embed] });
                        logger.debug('Updated existing status message');
                    } catch (fetchError) {
                        logger.warn('Failed to fetch existing status message, creating new one');
                        message = await this.channels.status.send({ embeds: [embed] });
                        this.statusMessageId = message.id;
                        await this.addStatusReactions(message);
                    }
                } else {
                    // Create new persistent status message
                    message = await this.channels.status.send({ embeds: [embed] });
                    this.statusMessageId = message.id;
                    logger.info(`Created persistent status message with ID: ${this.statusMessageId}`);
                    await this.addStatusReactions(message);
                }
            }
        } catch (error) {
            logger.error('Failed to send status embed:', error.message || error);
        }
    }

    async addStatusReactions(message) {
        try {
            await message.react('✅'); // Connect/Resume
            await message.react('❌'); // Disconnect
            logger.debug('Added status control reactions to message');
        } catch (error) {
            logger.warn('Failed to add reactions to status message:', error.message);
        }
    }

    async sendPlayerListEmbed(players) {
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🎮 Online Players')
            .setDescription(players.length > 0 ? players.map(player => `👤 ${player}`).join('\n') : '🚫 No players online')
            .addFields(
                { name: '📊 Total Players', value: `${players.length}`, inline: true },
                { name: '🕒 Last Updated', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
            )
            .setTimestamp()
            .setFooter({ text: 'Player List • Updates automatically' });

        if (!this.isConnected) {
            this.messageQueue.push({embed, channelType: 'playerList'});
            return;
        }

        try {
            if (this.channels.playerList) {
                // Use hardcoded player list message ID from secrets if available, otherwise use stored ID
                const targetPlayerListMessageId = process.env.DISCORD_PLAYER_LIST_MESSAGE_ID || this.playerListMessageId;
                
                if (targetPlayerListMessageId) {
                    // Try to edit existing persistent player list message
                    try {
                        const message = await this.channels.playerList.messages.fetch(targetPlayerListMessageId);
                        await message.edit({ embeds: [embed] });
                        logger.debug('Player list updated successfully');
                        // Store the hardcoded message ID if we successfully used it
                        if (process.env.DISCORD_PLAYER_LIST_MESSAGE_ID) {
                            this.playerListMessageId = process.env.DISCORD_PLAYER_LIST_MESSAGE_ID;
                        }
                        return;
                    } catch (fetchError) {
                        logger.warn('Failed to fetch existing player list message, creating new one');
                        this.playerListMessageId = null;
                    }
                }
                
                // Create new persistent message
                const sentMessage = await this.channels.playerList.send({ embeds: [embed] });
                this.playerListMessageId = sentMessage.id;
                logger.info(`Created new player list message with ID: ${this.playerListMessageId}`);
            }
        } catch (error) {
            logger.error('Failed to send player list embed:', error.message || error);
            // Reset message ID on failure so we try to create a new one next time
            this.playerListMessageId = null;
        }
    }

    async sendLoginEmbed(authCode, authUrl) {
        const embed = new EmbedBuilder()
            .setColor(0xFF9900)
            .setTitle('🔐 Microsoft Authentication Required')
            .setDescription(`**${config.minecraft.username}** needs to authenticate with Microsoft to access **${config.minecraft.host}**`)
            .addFields(
                { 
                    name: '🌐 Click Here to Authenticate', 
                    value: `**[Microsoft Login Page](${authUrl})**\n\`${authUrl}\``, 
                    inline: false 
                },
                { 
                    name: '🔢 Enter This Code', 
                    value: `\`\`\`fix\n${authCode}\`\`\``, 
                    inline: false 
                },
                { 
                    name: '📋 Step-by-Step Instructions', 
                    value: '🔸 **Step 1:** Click the authentication link above\n🔸 **Step 2:** Enter the code: `' + authCode + '`\n🔸 **Step 3:** Sign in with your Microsoft account\n🔸 **Step 4:** Bot will automatically connect once authenticated\n\n⏱️ *This authentication will be cached for future connections*', 
                    inline: false 
                }
            )
            .setTimestamp()
            .setFooter({ 
                text: `Authentication for ${config.minecraft.username} • One-time setup`, 
                iconURL: 'https://mc-heads.net/avatar/' + config.minecraft.username + '/16'
            });

        if (!this.isConnected) {
            this.messageQueue.push({embed, channelType: 'login'});
            return;
        }

        if (this.channels.login) {
            try {
                // Add ping if user ID is configured with more context
                const messageContent = config.discord.pingUserId ? 
                    `🚨 <@${config.discord.pingUserId}> **AUTHENTICATION REQUIRED** - The Minecraft bot needs your login!` : 
                    '🔔 **Authentication Required** - Please complete Microsoft login to connect the bot';
                    
                await this.channels.login.send({ 
                    content: messageContent,
                    embeds: [embed] 
                });
                logger.info('✅ Enhanced authentication embed sent to Discord login channel');
            } catch (error) {
                logger.error('❌ Failed to send embed to login channel:', error);
            }
        } else {
            logger.warn('⚠️ Login channel not available');
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

            // Discord webhook rate limit: 30 requests per minute
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

        this.isProcessingQueue = true;
        logger.info(`Processing ${this.messageQueue.length} queued messages`);

        while (this.messageQueue.length > 0 && this.isConnected) {
            const item = this.messageQueue.shift();
            try {
                if (this.webhook) {
                    await this.sendWebhookMessage(item.message || item.embed?.data?.description || 'Message');
                } else if (item.embed) {
                    // Send embed to appropriate channel
                    const channel = this.channels[item.channelType] || this.channels.logs;
                    if (item.isStatusUpdate && item.channelType === 'status') {
                        // Edit status message instead of sending new ones
                        const statusMessageId = config.discord.statusMessageId;
                        if (statusMessageId) {
                            try {
                                const message = await this.channels.status.messages.fetch(statusMessageId);
                                await message.edit({ embeds: [item.embed] });
                            } catch {
                                await channel.send({ embeds: [item.embed] });
                            }
                        } else {
                            await channel.send({ embeds: [item.embed] });
                        }
                    } else {
                        await channel.send({ embeds: [item.embed] });
                    }
                } else if (item.message) {
                    // Send regular message to appropriate channel
                    const channel = this.channels[item.channelType] || this.channels.logs;
                    await channel.send(item.message);
                }
                // Small delay to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                logger.error('Failed to send queued message:', error);
                // Re-queue the message
                this.messageQueue.unshift(item);
                break;
            }
        }

        this.isProcessingQueue = false;
    }

    async handleSlashCommand(interaction) {
        const { commandName } = interaction;
        const startTime = Date.now();

        // Check bot connection for commands that require it
        const requiresConnection = ['message', 'walk', 'location', 'health', 'jump', 'look', 'stop'];
        if (requiresConnection.includes(commandName) && (!this.minecraftBot || !this.minecraftBot.isConnected)) {
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
                    const closestPlayerInfo = bot?.getClosestPlayerInfo?.() || null;
                    const displayUsername = bot?.detectedUsername || config.minecraft.username || 'Unknown';
                    
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
                                value: `**Status:** ${isOnline ? 'Online' : 'Offline'}\n**Players:** ${playerCount}\n**Attempts:** ${bot?.reconnectAttempts || 0}/${config.minecraft.maxReconnectAttempts}`, 
                                inline: true 
                            },
                            { 
                                name: 'Nearest Player', 
                                value: closestPlayerInfo ? `**${closestPlayerInfo.name}**\n${closestPlayerInfo.distance} blocks away` : 'None detected', 
                                inline: true 
                            },
                            { 
                                name: 'Features', 
                                value: `**Anti-AFK:** ${config.minecraft.enableAntiAfk ? 'Enabled' : 'Disabled'}\n**Auth:** Microsoft\n**Auto-Reconnect:** Enabled`, 
                                inline: true 
                            }
                        )
                        .setFooter({ text: `Bot Username: ${displayUsername}` })
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

    // Helper method to convert yaw to compass direction
    getDirectionFromYaw(yaw) {
        const angle = ((yaw * 180) / Math.PI + 180) % 360;
        const directions = ['South', 'Southwest', 'West', 'Northwest', 'North', 'Northeast', 'East', 'Southeast'];
        return directions[Math.round(angle / 45) % 8];
    }

    // Method to set minecraft bot reference
    setMinecraftBot(minecraftBot) {
        this.minecraftBot = minecraftBot;
    }

    // Method to set custom Discord status
    async setStatus(state, additionalInfo = '') {
        if (!this.client || !this.client.user) return;

        try {
            let status, activity;

            switch (state) {
                case 'startup':
                    activity = {
                        name: 'Starting up...',
                        type: 0 // Playing
                    };
                    status = 'idle';
                    break;
                case 'authentication':
                    activity = {
                        name: 'Authentication Mode',
                        type: 0 // Playing
                    };
                    status = 'dnd';
                    break;
                case 'disconnected':
                    activity = {
                        name: 'Not connected',
                        type: 0 // Playing
                    };
                    status = 'dnd';
                    break;
                case 'connected':
                    activity = {
                        name: `Connected and monitoring${additionalInfo}`,
                        type: 0 // Playing
                    };
                    status = 'online';
                    break;
                case 'error':
                    activity = {
                        name: 'Connection Error',
                        type: 0 // Playing
                    };
                    status = 'dnd';
                    break;
                default:
                    activity = {
                        name: 'Minecraft Bridge Bot',
                        type: 0 // Playing
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