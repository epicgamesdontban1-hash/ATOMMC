const { Client, GatewayIntentBits, ChannelType, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');
const config = require('./config');
const logger = require('./logger');

class DiscordClient {
    constructor() {
        this.client = null;
        this.channels = {
            logs: null,
            login: null,
            status: null
        };
        this.webhook = null;
        this.isConnected = false;
        this.messageQueue = [];
        this.isProcessingQueue = false;
        this.pendingMessages = new Map(); // For batching messages by timestamp
        this.batchTimeout = null;
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
                    GatewayIntentBits.GuildMessages
                ]
            });

            this.client.once('ready', () => {
                logger.info(`Discord bot logged in as ${this.client.user.tag}`);
                this.setupChannels();
                this.isConnected = true;
            });

            this.client.on('error', (error) => {
                logger.error('Discord client error:', error);
            });

            this.client.on('disconnect', () => {
                logger.warn('Discord client disconnected');
                this.isConnected = false;
            });

            await this.client.login(config.discord.token);
        } catch (error) {
            logger.error('Failed to connect to Discord:', error);
            throw error;
        }
    }

    async setupChannels() {
        try {
            // Setup all three channels
            const channelTypes = ['logs', 'login', 'status'];
            
            for (const type of channelTypes) {
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
            
            // Send startup status embed
            await this.sendStatusEmbed('Starting up', 'Minecraft bot is initializing...', 0xFFFF00);
            
            // Process any queued messages
            this.processMessageQueue();
        } catch (error) {
            logger.error('Failed to setup Discord channels:', error);
            throw error;
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
                // For player messages, send directly as bot message
                if (!isServerMessage) {
                    await this.channels.logs.send(message);
                } else {
                    // For server messages, keep embed format
                    const embed = new EmbedBuilder()
                        .setColor(0x00FF00)
                        .setAuthor({
                            name: 'Server',
                            iconURL: 'https://i.imgur.com/5ZzpCmx.png'
                        })
                        .setDescription(message)
                        .setTimestamp()
                        .setFooter({ text: 'Minecraft Chat' });
                    
                    await this.channels.logs.send({ embeds: [embed] });
                }
            }
        } catch (error) {
            logger.error('Failed to send chat message:', error.message || error);
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
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(title)
            .setDescription(description)
            .setTimestamp()
            .setFooter({ text: 'Bot Status' });

        if (!this.isConnected) {
            this.messageQueue.push({embed, channelType: 'status', isStatusUpdate: true});
            return;
        }

        try {
            if (this.channels.status) {
                // Edit the specific status message instead of sending new ones
                const statusMessageId = '1411381289789030463';
                try {
                    const message = await this.channels.status.messages.fetch(statusMessageId);
                    await message.edit({ embeds: [embed] });
                } catch (fetchError) {
                    // If message doesn't exist or can't be edited, send new message
                    await this.channels.status.send({ embeds: [embed] });
                }
            }
        } catch (error) {
            logger.error('Failed to send status embed:', error.message || error);
            // Don't requeue status embeds to avoid spam
        }
    }

    async sendLoginEmbed(authCode, authUrl) {
        logger.info('🔍 DEBUG: sendLoginEmbed called with:', { authCode, authUrl });
        
        const embed = new EmbedBuilder()
            .setColor(0xFF9900)
            .setTitle('🔑 Microsoft Authentication Required')
            .setDescription('Please authenticate your Minecraft account to continue')
            .addFields(
                { name: '🌐 Authentication URL', value: `[Click here to authenticate](${authUrl})`, inline: false },
                { name: '🔢 Authentication Code', value: `\`\`\`${authCode}\`\`\``, inline: false },
                { name: '📝 Instructions', value: '1. Click the link above\n2. Enter the code shown\n3. Sign in with your Minecraft account', inline: false }
            )
            .setTimestamp()
            .setFooter({ text: 'One-time authentication' });

        logger.info('🔍 DEBUG: Embed created successfully');

        if (!this.isConnected) {
            logger.warn('🔍 DEBUG: Discord not connected, queuing message');
            this.messageQueue.push({embed, channelType: 'login'});
            logger.info('🔍 DEBUG: Message added to queue, queue length:', this.messageQueue.length);
            return;
        }

        logger.info('🔍 DEBUG: Discord is connected, attempting to send to channel');
        logger.info('🔍 DEBUG: Login channel available:', !!this.channels.login);
        logger.info('🔍 DEBUG: Login channel ID:', this.channels.login?.id);

        try {
            if (this.channels.login) {
                logger.info('📤 Sending embed to Discord login channel...');
                const sentMessage = await this.channels.login.send({ embeds: [embed] });
                logger.info('✅ Login embed sent successfully! Message ID:', sentMessage.id);
            } else {
                logger.error('❌ Login channel not found in channels object');
                logger.info('🔍 DEBUG: Available channels:', Object.keys(this.channels));
            }
        } catch (error) {
            logger.error('❌ Failed to send login embed:', error);
            logger.error('❌ Error stack:', error.stack);
            logger.warn('⚠️ Re-queueing message due to send failure');
            this.messageQueue.unshift({embed, channelType: 'login'});
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
                        const statusMessageId = '1411381289789030463';
                        try {
                            const message = await this.channels.status.messages.fetch(statusMessageId);
                            await message.edit({ embeds: [item.embed] });
                        } catch {
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
}

module.exports = DiscordClient;
