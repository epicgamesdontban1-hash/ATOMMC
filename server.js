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
        this.chatLogs = [];
        this.maxChatLogs = 10000;

        // Setup web server IMMEDIATELY in constructor for Render.com
        this.setupWebServer();
    }

    async initialize() {
        try {
            logger.info('Initializing Minecraft Discord Bridge...');

            if (config.discord.enabled) {
                logger.info('Connecting to Discord...');
                this.discordClient = new DiscordClient(this);
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

    logChatMessage(sender, message, isServerMessage = false) {
        const timestamp = new Date().toISOString();
        const now = Date.now();
        const batchKey = Math.floor(now / 2000); // 2-second batching window

        // If this is a server message and we have recent server messages, batch them
        if (isServerMessage && this.chatLogs.length > 0) {
            const lastLog = this.chatLogs[this.chatLogs.length - 1];
            const lastTime = new Date(lastLog.timestamp).getTime();
            const timeDiff = now - lastTime;

            // If last message was also a server message within 2 seconds, append to it
            if (lastLog.isServerMessage && timeDiff < 2000) {
                lastLog.message += '\n' + message;
                lastLog.timestamp = timestamp; // Update timestamp to latest
                lastLog.displayTime = new Date().toLocaleString('en-US', {
                    month: '2-digit',
                    day: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: true
                });
                return;
            }
        }

        // Otherwise, create a new log entry
        const logEntry = {
            timestamp,
            sender,
            message,
            isServerMessage,
            displayTime: new Date().toLocaleString('en-US', {
                month: '2-digit',
                day: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-second',
                hour12: true
            })
        };

        this.chatLogs.push(logEntry);

        // Keep only last 500 messages
        if (this.chatLogs.length > 500) {
            this.chatLogs.shift();
        }
    }

    setupWebServer() {
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));

        // ====================================================================
        // HOME PAGE - DASHBOARD
        // ====================================================================
        this.app.get('/', (req, res) => {
            const status = this.getStatus();
            const position = this.minecraftBot?.bot?.entity?.position;
            const dimension = this.minecraftBot?.bot?.game?.dimension || 'Unknown';
            const health = this.minecraftBot?.bot?.health || 0;
            const food = this.minecraftBot?.bot?.food || 0;

            const uptimeHours = Math.floor(status.uptime / 3600);
            const uptimeMinutes = Math.floor((status.uptime % 3600) / 60);
            const uptimeSeconds = status.uptime % 60;
            const uptimeDisplay = `${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s`;

            res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Minecraft Monitoring Service</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            color: #333;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .header {
            text-align: center;
            color: white;
            margin-bottom: 30px;
        }

        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }

        .header p {
            font-size: 1.1em;
            opacity: 0.9;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }

        .card {
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            transition: transform 0.3s ease;
        }

        .card:hover {
            transform: translateY(-5px);
        }

        .card-title {
            font-size: 1.3em;
            font-weight: 600;
            margin-bottom: 15px;
            color: #667eea;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .status-indicator {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            display: inline-block;
            animation: pulse 2s infinite;
        }

        .status-online { background: #10b981; }
        .status-offline { background: #ef4444; }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .info-row {
            display: flex;
            justify-content: space-between;
            padding: 10px 0;
            border-bottom: 1px solid #f0f0f0;
        }

        .info-row:last-child {
            border-bottom: none;
        }

        .info-label {
            font-weight: 500;
            color: #666;
        }

        .info-value {
            font-weight: 600;
            color: #333;
        }

        .players-list {
            max-height: 200px;
            overflow-y: auto;
        }

        .player-item {
            padding: 10px;
            margin: 5px 0;
            background: #f8f9fa;
            border-radius: 8px;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .player-avatar {
            width: 32px;
            height: 32px;
            border-radius: 5px;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-top: 15px;
        }

        .stat-box {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 10px;
            text-align: center;
        }

        .stat-value {
            font-size: 2em;
            font-weight: bold;
            color: #667eea;
        }

        .stat-label {
            font-size: 0.9em;
            color: #666;
            margin-top: 5px;
        }

        .badge {
            display: inline-block;
            padding: 5px 12px;
            border-radius: 20px;
            font-size: 0.85em;
            font-weight: 600;
        }

        .badge-success {
            background: #d1fae5;
            color: #065f46;
        }

        .badge-danger {
            background: #fee2e2;
            color: #991b1b;
        }

        .badge-warning {
            background: #fef3c7;
            color: #92400e;
        }

        .health-bar {
            width: 100%;
            height: 25px;
            background: #e5e7eb;
            border-radius: 12px;
            overflow: hidden;
            margin-top: 10px;
        }

        .health-fill {
            height: 100%;
            background: linear-gradient(90deg, #10b981, #34d399);
            transition: width 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: 600;
            font-size: 0.9em;
        }

        .refresh-btn {
            background: white;
            color: #667eea;
            border: 2px solid #667eea;
            padding: 12px 30px;
            border-radius: 25px;
            font-size: 1em;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            display: block;
            margin: 20px auto;
        }

        .refresh-btn:hover {
            background: #667eea;
            color: white;
            transform: scale(1.05);
        }

        .footer {
            text-align: center;
            color: white;
            margin-top: 30px;
            opacity: 0.8;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Minecraft Monitoring</h1>
            <p>Monitoring by doggo</p>
        </div>

        <div class="grid">
            <!-- Bot Status Card -->
            <div class="card">
                <div class="card-title">
                    <span class="status-indicator status-${status.bot.connected ? 'online' : 'offline'}"></span>
                    Bot Status
                </div>
                <div class="info-row">
                    <span class="info-label">Connection</span>
                    <span class="badge ${status.bot.connected ? 'badge-success' : 'badge-danger'}">
                        ${status.bot.connected ? '✓ Online' : '✗ Offline'}
                    </span>
                </div>
                <div class="info-row">
                    <span class="info-label">Username</span>
                    <span class="info-value">${status.bot.username}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">State</span>
                    <span class="info-value">${status.bot.state}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Uptime</span>
                    <span class="info-value">${uptimeDisplay}</span>
                </div>
            </div>

            <!-- Server Info Card -->
            <div class="card">
                <div class="card-title">🌐 Server Information</div>
                <div class="info-row">
                    <span class="info-label">Host</span>
                    <span class="info-value">${status.server.host}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Port</span>
                    <span class="info-value">${status.server.port}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Version</span>
                    <span class="info-value">${status.server.version}</span>
                </div>
                ${status.bot.connected ? `
                <div class="info-row">
                    <span class="info-label">Dimension</span>
                    <span class="info-value">${dimension}</span>
                </div>
                ` : ''}
            </div>

            <!-- Discord Status Card -->
            <div class="card">
                <div class="card-title">
                    <span class="status-indicator status-${status.discord.connected ? 'online' : 'offline'}"></span>
                    Discord Integration
                </div>
                <div class="info-row">
                    <span class="info-label">Status</span>
                    <span class="badge ${status.discord.enabled ? 'badge-success' : 'badge-warning'}">
                        ${status.discord.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                </div>
                <div class="info-row">
                    <span class="info-label">Connection</span>
                    <span class="badge ${status.discord.connected ? 'badge-success' : 'badge-danger'}">
                        ${status.discord.connected ? '✓ Connected' : '✗ Disconnected'}
                    </span>
                </div>
            </div>

            <!-- Players Card -->
            <div class="card">
                <div class="card-title">👥 Online Players (${status.players.length})</div>
                <div class="players-list">
                    ${status.players.length > 0 ? status.players.map(player => `
                        <div class="player-item">
                            <img class="player-avatar" src="https://mc-heads.net/avatar/${player}/32" alt="${player}">
                            <span class="info-value">${player}</span>
                        </div>
                    `).join('') : '<p style="text-align: center; color: #999; padding: 20px;">No players online</p>'}
                </div>
            </div>

            ${status.bot.connected ? `
            <!-- Position Card -->
            <div class="card">
                <div class="card-title">📍 Bot Position</div>
                ${position ? `
                <div class="stats-grid">
                    <div class="stat-box">
                        <div class="stat-value">${Math.round(position.x)}</div>
                        <div class="stat-label">X Coordinate</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-value">${Math.round(position.y)}</div>
                        <div class="stat-label">Y Coordinate</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-value">${Math.round(position.z)}</div>
                        <div class="stat-label">Z Coordinate</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-value">${dimension}</div>
                        <div class="stat-label">Dimension</div>
                    </div>
                </div>
                ` : '<p style="text-align: center; color: #999;">Position unavailable</p>'}
            </div>

            <!-- Health Card -->
            <div class="card">
                <div class="card-title">❤️ Bot Health</div>
                <div class="info-row">
                    <span class="info-label">Health</span>
                    <span class="info-value">${health}/20</span>
                </div>
                <div class="health-bar">
                    <div class="health-fill" style="width: ${(health/20)*100}%">${health} HP</div>
                </div>
                <div class="info-row" style="margin-top: 15px;">
                    <span class="info-label">Food</span>
                    <span class="info-value">${food}/20</span>
                </div>
                <div class="health-bar">
                    <div class="health-fill" style="width: ${(food/20)*100}%; background: linear-gradient(90deg, #f59e0b, #fbbf24);">${food}</div>
                </div>
            </div>
            ` : ''}
        </div>

        <!-- Chat Logs Card -->
        <div class="card" style="grid-column: 1 / -1;">
            <div class="card-title">💬 Recent Chat Messages</div>
            <div style="display: flex; gap: 10px; margin-bottom: 15px;">
                <button class="refresh-btn" onclick="loadChatLogs()" style="margin: 0; padding: 8px 20px;">🔄 Refresh Logs</button>
                <button class="refresh-btn" onclick="downloadLogs()" style="margin: 0; padding: 8px 20px; background: #10b981; border-color: #10b981;">📥 Download All Logs</button>
                <label style="display: flex; align-items: center; gap: 5px; color: #667eea; font-weight: 600;">
                    <input type="checkbox" id="autoRefresh" checked onchange="toggleAutoRefresh()">
                    Auto-refresh (5s)
                </label>
            </div>
            <div id="chatLogs" style="max-height: 400px; overflow-y: auto; background: #f8f9fa; border-radius: 10px; padding: 15px;">
                <p style="text-align: center; color: #999;">Loading chat logs...</p>
            </div>
        </div>

        <button class="refresh-btn" onclick="location.reload()"> Refresh Dashboard</button>

        <div class="footer">
            <p>Minecraft Monitoring Service • Last updated: ${new Date().toLocaleTimeString()}</p>
        </div>
    </div>

    <script>
        let autoRefreshInterval = null;
        let userHasScrolled = false;
        let lastScrollHeight = 0;

        // Detect if user has manually scrolled up
        document.addEventListener('DOMContentLoaded', () => {
            const chatLogsDiv = document.getElementById('chatLogs');
            chatLogsDiv.addEventListener('scroll', () => {
                const isAtBottom = chatLogsDiv.scrollHeight - chatLogsDiv.scrollTop <= chatLogsDiv.clientHeight + 50;
                userHasScrolled = !isAtBottom;
            });
        });

        async function loadChatLogs() {
            try {
                const response = await fetch('/chat-logs?limit=50');
                const data = await response.json();

                const chatLogsDiv = document.getElementById('chatLogs');

                if (data.logs.length === 0) {
                    chatLogsDiv.innerHTML = '<p style="text-align: center; color: #999;">No chat messages yet</p>';
                    return;
                }

                // Display messages in chronological order (oldest to newest)
                chatLogsDiv.innerHTML = data.logs.reverse().map(log => {
                    const messageColor = log.isServerMessage ? '#9B59B6' : '#667eea';
                    // Don't show sender name for server messages, just the message itself
                    const senderDisplay = log.isServerMessage ? '' : \`<div style="color: \${messageColor}; font-weight: 600;">\${log.sender}</div>\`;
                    return \`
                        <div style="padding: 8px; margin: 5px 0; background: white; border-radius: 5px; border-left: 3px solid \${messageColor};">
                            <div style="font-size: 0.85em; color: #666; margin-bottom: 3px;">\${log.displayTime}</div>
                            \${senderDisplay}
                            <div style="color: #333; margin-top: 3px;">\${escapeHtml(log.message)}</div>
                        </div>
                    \`;
                }).join('');

                // Auto-scroll to bottom only if user hasn't manually scrolled up
                if (!userHasScrolled || lastScrollHeight === 0) {
                    chatLogsDiv.scrollTop = chatLogsDiv.scrollHeight;
                }
                lastScrollHeight = chatLogsDiv.scrollHeight;
            } catch (error) {
                console.error('Failed to load chat logs:', error);
            }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function downloadLogs() {
            window.location.href = '/download-logs';
        }

        function toggleAutoRefresh() {
            const checkbox = document.getElementById('autoRefresh');
            if (checkbox.checked) {
                autoRefreshInterval = setInterval(loadChatLogs, 5000);
            } else {
                if (autoRefreshInterval) {
                    clearInterval(autoRefreshInterval);
                    autoRefreshInterval = null;
                }
            }
        }

        // Initial load
        loadChatLogs();

        // Start auto-refresh
        autoRefreshInterval = setInterval(loadChatLogs, 5000);

        // Keep the original 30-second full page refresh
        setTimeout(() => location.reload(), 30000);
    </script>
</body>
</html>
            `);
        });

        // ====================================================================
        // STATUS PAGE (JSON for API)
        // ====================================================================
        this.app.get('/status', (req, res) => {
            const status = this.getStatus();
            res.json(status);
        });

        // ====================================================================
        // PLAYERS PAGE (JSON for API)
        // ====================================================================
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

        // ====================================================================
        // CHAT LOGS ENDPOINT (JSON for real-time updates)
        // ====================================================================
        this.app.get('/chat-logs', (req, res) => {
            const limit = parseInt(req.query.limit) || 100;
            const offset = parseInt(req.query.offset) || 0;

            const logs = this.chatLogs.slice(-limit - offset, -offset || undefined).reverse();

            res.json({
                logs,
                total: this.chatLogs.length,
                serverStartTime: new Date(this.startTime).toISOString()
            });
        });

        // ====================================================================
        // DOWNLOAD LOGS ENDPOINT
        // ====================================================================
        this.app.get('/download-logs', (req, res) => {
            const logContent = this.chatLogs.map(log => {
                // Don't include sender name for server messages, just the message
                if (log.isServerMessage) {
                    return `[${log.displayTime}] [SERVER] ${log.message}`;
                } else {
                    return `[${log.displayTime}] <${log.sender}> ${log.message}`;
                }
            }).join('\n');

            const filename = `minecraft-chat-${new Date().toISOString().replace(/:/g, '-')}.log`;

            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(logContent);
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
