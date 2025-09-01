require('dotenv').config();

const config = {
    minecraft: {
        host: process.env.MINECRAFT_HOST || 'play.atommc.co.za',
        port: parseInt(process.env.MINECRAFT_PORT) || 25565,
        username: process.env.MINECRAFT_USERNAME || 'Hakiiyooo',
        version: process.env.MINECRAFT_VERSION || '1.20.4',
        auth: process.env.MINECRAFT_AUTH || 'microsoft',
        reconnectDelay: parseInt(process.env.RECONNECT_DELAY) || 5000,
        maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 10,
        enableAntiAfk: process.env.ENABLE_ANTI_AFK === 'true'
    },
    web: {
        password: process.env.WEB_PASSWORD || 'Agent',
        authTimeout: parseInt(process.env.AUTH_TIMEOUT) || 15 * 60 * 1000 // 15 minutes
    },
    discord: {
        token: process.env.DISCORD_BOT_TOKEN,
        channels: {
            logs: process.env.DISCORD_LOGS_CHANNEL_ID || '1411378345345548442',
            login: process.env.DISCORD_LOGIN_CHANNEL_ID || '1411379478294298805',
            status: process.env.DISCORD_STATUS_CHANNEL_ID || '1411379501467832452',
            playerList: process.env.DISCORD_PLAYER_LIST_CHANNEL_ID || '1412072351251697776'
        },
        playerListMessageId: process.env.DISCORD_PLAYER_LIST_MESSAGE_ID || '1412087227831418921',
        webhook: process.env.DISCORD_WEBHOOK_URL || ''
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

    // Require either Discord bot token + channel ID or webhook URL
    if (!config.discord.token && !config.discord.webhook) {
        throw new Error('Either DISCORD_BOT_TOKEN with DISCORD_CHANNEL_ID or DISCORD_WEBHOOK_URL must be provided');
    }

    if (config.discord.token && (!config.discord.channels.logs || !config.discord.channels.login || !config.discord.channels.status || !config.discord.channels.playerList)) {
        throw new Error('All Discord channel IDs are required: DISCORD_LOGS_CHANNEL_ID, DISCORD_LOGIN_CHANNEL_ID, DISCORD_STATUS_CHANNEL_ID, DISCORD_PLAYER_LIST_CHANNEL_ID');
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
