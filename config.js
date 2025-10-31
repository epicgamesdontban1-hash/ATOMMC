
require('dotenv').config();

const config = {
    minecraft: {
        host: process.env.MINECRAFT_HOST || 'play.atommc.co.za',
        port: parseInt(process.env.MINECRAFT_PORT) || 25565,
        username: process.env.MINECRAFT_USERNAME || 'MinecraftBot',
        version: process.env.MINECRAFT_VERSION || '1.21.4',
        auth: process.env.MINECRAFT_AUTH || 'microsoft',
        reconnectDelay: parseInt(process.env.RECONNECT_DELAY) || 15000,
        maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 100000000000000,
        enableAntiAfk: process.env.ENABLE_ANTI_AFK === 'true'
    },
    web: {
        password: process.env.WEB_PASSWORD || 'defaultpass',
        authTimeout: parseInt(process.env.AUTH_TIMEOUT) || 15 * 60 * 1000 // 15 minutes
    },
    discord: {
        token: process.env.DISCORD_BOT_TOKEN,
        instanceId: process.env.DISCORD_INSTANCE_ID || 'default',
        channels: {
            logs: process.env.DISCORD_LOGS_CHANNEL_ID,
            login: process.env.DISCORD_LOGIN_CHANNEL_ID,
            status: process.env.DISCORD_STATUS_CHANNEL_ID,
            playerList: process.env.DISCORD_PLAYER_LIST_CHANNEL_ID
        },
        playerListMessageId: process.env.DISCORD_PLAYER_LIST_MESSAGE_ID,
        statusMessageId: process.env.DISCORD_STATUS_MESSAGE_ID,
        webhook: process.env.DISCORD_WEBHOOK_URL,
        pingUserId: process.env.DISCORD_PING_USER_ID // For login notifications
    },
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        console: process.env.LOG_CONSOLE !== 'false'
    }
};

// Validate required configuration
function validateConfig() {
    const required = [
        'minecraft.host',
        'minecraft.username'
    ];

    // Make Discord configuration optional for demo/development purposes
    // Log warnings if Discord is not configured but don't block startup
    if (!config.discord.token && !config.discord.webhook) {
        console.warn('Warning: No Discord configuration found. Discord integration will be disabled.');
        console.warn('To enable Discord integration, set DISCORD_BOT_TOKEN or DISCORD_WEBHOOK_URL environment variables.');
        // Mark Discord as disabled
        config.discord.enabled = false;
    } else {
        config.discord.enabled = true;
        
        // Only validate Discord channels if Discord is enabled
        if (config.discord.token && (!config.discord.channels.logs || !config.discord.channels.login || !config.discord.channels.status)) {
            throw new Error('Required Discord channel IDs missing: DISCORD_LOGS_CHANNEL_ID, DISCORD_LOGIN_CHANNEL_ID, DISCORD_STATUS_CHANNEL_ID are required when using bot token');
        }
    }

    for (const path of required) {
        const value = path.split('.').reduce((obj, key) => obj[key], config);
        if (!value) {
            const envVar = path.toUpperCase().replace('.', '_');
            throw new Error(`Missing required configuration: ${envVar}`);
        }
    }
}

validateConfig();

module.exports = config;
