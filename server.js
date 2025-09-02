const express = require('express');
const MinecraftBot = require('./minecraft-bot');
const DiscordClient = require('./discord-client');
const config = require('./config');
const logger = require('./logger');
const crypto = require('crypto');
const session = require('express-session');

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
        this.authCode = null;
        this.authUrl = null;
        this.authTimeout = null;
        this.isAuthenticated = false;
        this.password = 'Agent'; // Default password
    }

    async initialize() {
        try {
            logger.info('Initializing Minecraft Discord Bridge...');

            // Setup simple web server
            this.setupWebServer();

            // Add debug logging for environment
            logger.info('Environment check:');
            logger.info(`- NODE_ENV: ${process.env.NODE_ENV}`);
            logger.info(`- Platform: ${process.platform}`);
            logger.info(`- RENDER: ${process.env.RENDER}`);
            logger.info(`- Is Production: ${process.env.NODE_ENV === 'production' || !!process.env.RENDER}`);

            // Initialize Discord client
            logger.info('Connecting to Discord...');
            this.discordClient = new DiscordClient();
            await this.discordClient.connect();

            // Initialize Minecraft bot
            this.minecraftBot = new MinecraftBot(this.discordClient);

            // Setup console capture for authentication prompts
            this.setupConsoleCapture();

            // Handle authentication based on environment
            if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
                logger.info('Production environment detected - attempting to handle auth differently');

                // In production, we might need to use cached tokens or environment variables
                // Check if we have pre-stored authentication tokens
                if (process.env.MC_ACCESS_TOKEN && process.env.MC_REFRESH_TOKEN) {
                    logger.info('Using stored authentication tokens for production');
                    // You'll need to modify your MinecraftBot to accept these tokens
                    if (this.minecraftBot.setAuthTokens) {
                        this.minecraftBot.setAuthTokens(process.env.MC_ACCESS_TOKEN, process.env.MC_REFRESH_TOKEN);
                    }
                } else {
                    logger.warn('No stored authentication tokens found. Bot will need manual authentication.');
                    logger.warn('Available env vars:', Object.keys(process.env).filter(key => key.startsWith('MC_') || key.includes('TOKEN')));
                }
            }

            // Connect the bot (authentication will be handled automatically)
            logger.info('Starting Minecraft bot connection...');
            this.minecraftBot.connect().catch((error) => {
                logger.info('Bot connection failed, likely authentication required:', error.message);
                logger.error('Connection error details:', error);
                // Don't exit, just log and wait for authentication
            });

            // Setup graceful shutdown
            this.setupGracefulShutdown();

            logger.info('Minecraft Discord Bridge initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize bridge:', error);
            process.exit(1);
        }
    }

    setupWebServer() {
        // Parse form data
        this.app.use(express.urlencoded({ extended: true }));
        this.app.use(express.json());

        this.app.use(session({
            secret: crypto.randomBytes(20).toString('hex'),
            resave: false,
            saveUninitialized: true,
            cookie: { maxAge: 15 * 60 * 1000 } // 15 minute timeout
        }));

        // Middleware to check authentication
        const requireAuth = (req, res, next) => {
            if (req.session.authenticated || this.isAuthenticated) {
                next();
            } else {
                res.redirect('/login');
            }
        };

        // Login route
        this.app.get('/login', (req, res) => {
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Minecraft Bot - Login</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        * {
                            margin: 0;
                            padding: 0;
                            box-sizing: border-box;
                        }

                        body {
                            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            min-height: 100vh;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            padding: 20px;
                        }

                        .login-container {
                            background: rgba(255, 255, 255, 0.95);
                            padding: 40px;
                            border-radius: 20px;
                            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
                            text-align: center;
                            max-width: 400px;
                            width: 100%;
                            backdrop-filter: blur(10px);
                        }

                        h1 {
                            color: #333;
                            margin-bottom: 30px;
                            font-size: 2rem;
                            font-weight: 600;
                        }

                        .input-group {
                            margin-bottom: 20px;
                            text-align: left;
                        }

                        label {
                            display: block;
                            margin-bottom: 8px;
                            color: #555;
                            font-weight: 500;
                        }

                        input[type=password] {
                            width: 100%;
                            padding: 15px;
                            border: 2px solid #e1e5e9;
                            border-radius: 10px;
                            font-size: 16px;
                            transition: border-color 0.3s ease;
                            background: #f8f9fa;
                        }

                        input[type=password]:focus {
                            outline: none;
                            border-color: #667eea;
                            background: white;
                        }

                        button {
                            width: 100%;
                            padding: 15px;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            color: white;
                            border: none;
                            border-radius: 10px;
                            font-size: 16px;
                            font-weight: 600;
                            cursor: pointer;
                            transition: transform 0.2s ease;
                        }

                        button:hover {
                            transform: translateY(-2px);
                        }

                        button:active {
                            transform: translateY(0);
                        }

                        .error {
                            color: #e74c3c;
                            margin-top: 15px;
                            padding: 10px;
                            background: rgba(231, 76, 60, 0.1);
                            border-radius: 8px;
                            font-weight: 500;
                        }

                        .minecraft-title {
                            background: linear-gradient(45deg, #00ff00, #55ff55);
                            -webkit-background-clip: text;
                            -webkit-text-fill-color: transparent;
                            background-clip: text;
                            font-weight: 700;
                            text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.1);
                        }
                    </style>
                </head>
                <body>
                    <div class="login-container">
                        <h1 class="minecraft-title">🎮 Minecraft Bot</h1>
                        <form action="/login" method="post">
                            <div class="input-group">
                                <label for="password">Enter Password</label>
                                <input type="password" name="password" id="password" placeholder="Password" required>
                            </div>
                            <button type="submit">Access Dashboard</button>
                        </form>
                        ${req.query.error ? '<div class="error">❌ Incorrect password. Please try again.</div>' : ''}
                    </div>
                </body>
                </html>
            `);
        });

        this.app.post('/login', (req, res) => {
            if (req.body.password === this.password) {
                req.session.authenticated = true;
                this.isAuthenticated = true;
                res.redirect('/');
            } else {
                res.redirect('/login?error=true');
            }
        });

        // Protected route for bot status
        this.app.get('/', requireAuth, (req, res) => {
            const isOnline = this.minecraftBot && this.minecraftBot.isConnected;
            const playerCount = this.minecraftBot && this.minecraftBot.bot ? Object.keys(this.minecraftBot.bot.players).length : 0;

            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Minecraft Bot Dashboard</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        * {
                            margin: 0;
                            padding: 0;
                            box-sizing: border-box;
                        }

                        body {
                            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            min-height: 100vh;
                            color: #333;
                            padding: 20px;
                        }

                        .container {
                            max-width: 1200px;
                            margin: 0 auto;
                        }

                        .header {
                            background: rgba(255, 255, 255, 0.95);
                            padding: 30px;
                            border-radius: 20px;
                            margin-bottom: 30px;
                            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
                            backdrop-filter: blur(10px);
                            text-align: center;
                        }

                        .minecraft-title {
                            background: linear-gradient(45deg, #00ff00, #55ff55);
                            -webkit-background-clip: text;
                            -webkit-text-fill-color: transparent;
                            background-clip: text;
                            font-size: 2.5rem;
                            font-weight: 700;
                            margin-bottom: 10px;
                        }

                        .subtitle {
                            color: #666;
                            font-size: 1.2rem;
                        }

                        .dashboard-grid {
                            display: grid;
                            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                            gap: 30px;
                        }

                        .card {
                            background: rgba(255, 255, 255, 0.95);
                            padding: 30px;
                            border-radius: 20px;
                            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
                            backdrop-filter: blur(10px);
                        }

                        .card h2 {
                            margin-bottom: 20px;
                            color: #333;
                            font-size: 1.5rem;
                            display: flex;
                            align-items: center;
                            gap: 10px;
                        }

                        .status-indicator {
                            width: 20px;
                            height: 20px;
                            border-radius: 50%;
                            display: inline-block;
                            position: relative;
                        }

                        .status-indicator.online {
                            background: #00ff00;
                            box-shadow: 0 0 20px rgba(0, 255, 0, 0.5);
                        }

                        .status-indicator.offline {
                            background: #ff4444;
                            box-shadow: 0 0 20px rgba(255, 68, 68, 0.5);
                        }

                        .status-indicator::after {
                            content: '';
                            width: 100%;
                            height: 100%;
                            border-radius: 50%;
                            position: absolute;
                            top: 0;
                            left: 0;
                            animation: pulse 2s infinite;
                        }

                        .status-indicator.online::after {
                            background: rgba(0, 255, 0, 0.3);
                        }

                        .status-indicator.offline::after {
                            background: rgba(255, 68, 68, 0.3);
                        }

                        @keyframes pulse {
                            0% { transform: scale(1); opacity: 1; }
                            50% { transform: scale(1.5); opacity: 0.5; }
                            100% { transform: scale(2); opacity: 0; }
                        }

                        .info-item {
                            margin-bottom: 15px;
                            padding: 15px;
                            background: rgba(102, 126, 234, 0.1);
                            border-radius: 10px;
                            border-left: 4px solid #667eea;
                        }

                        .info-label {
                            font-weight: 600;
                            color: #667eea;
                            margin-bottom: 5px;
                        }

                        .info-value {
                            color: #333;
                            font-size: 1.1rem;
                        }

                        .auth-section {
                            margin-top: 20px;
                        }

                        .auth-link {
                            display: inline-block;
                            padding: 12px 24px;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            color: white;
                            text-decoration: none;
                            border-radius: 10px;
                            font-weight: 600;
                            transition: transform 0.2s ease;
                        }

                        .auth-link:hover {
                            transform: translateY(-2px);
                        }

                        .auth-code {
                            background: #2c3e50;
                            color: #ecf0f1;
                            padding: 10px 15px;
                            border-radius: 8px;
                            font-family: 'Courier New', monospace;
                            font-size: 1.2rem;
                            letter-spacing: 2px;
                            margin: 10px 0;
                            display: inline-block;
                        }

                        .logout-btn {
                            position: fixed;
                            top: 20px;
                            right: 20px;
                            padding: 10px 20px;
                            background: rgba(255, 255, 255, 0.2);
                            color: white;
                            border: 2px solid rgba(255, 255, 255, 0.3);
                            border-radius: 10px;
                            text-decoration: none;
                            font-weight: 600;
                            transition: all 0.3s ease;
                        }

                        .logout-btn:hover {
                            background: rgba(255, 255, 255, 0.3);
                            border-color: rgba(255, 255, 255, 0.5);
                        }

                        @media (max-width: 768px) {
                            .minecraft-title {
                                font-size: 2rem;
                            }

                            .dashboard-grid {
                                grid-template-columns: 1fr;
                            }
                        }
                    </style>
                </head>
                <body>
                    <a href="/logout" class="logout-btn">🚪 Logout</a>

                    <div class="container">
                        <div class="header">
                            <h1 class="minecraft-title">🎮 Minecraft Bot Dashboard</h1>
                            <p class="subtitle">Real-time monitoring and control</p>
                        </div>

                        <div class="dashboard-grid">
                            <div class="card">
                                <h2>
                                    <span class="status-indicator ${isOnline ? 'online' : 'offline'}"></span>
                                    Bot Status
                                </h2>

                                <div class="info-item">
                                    <div class="info-label">Status</div>
                                    <div class="info-value">${isOnline ? '🟢 ONLINE' : '🔴 OFFLINE'}</div>
                                </div>

                                <div class="info-item">
                                    <div class="info-label">Server</div>
                                    <div class="info-value">${config.minecraft.host}:${config.minecraft.port}</div>
                                </div>

                                <div class="info-item">
                                    <div class="info-label">Username</div>
                                    <div class="info-value">${config.minecraft.username}</div>
                                </div>

                                <div class="info-item">
                                    <div class="info-label">Players Online</div>
                                    <div class="info-value">${playerCount} players</div>
                                </div>

                                <div class="info-item">
                                    <div class="info-label">Anti-AFK</div>
                                    <div class="info-value">${config.minecraft.enableAntiAfk ? '✅ Enabled' : '❌ Disabled'}</div>
                                </div>
                            </div>

                            ${this.authUrl || this.authCode ? `
                            <div class="card">
                                <h2>🔐 Authentication</h2>

                                ${this.authUrl ? `
                                <div class="info-item">
                                    <div class="info-label">Authentication URL</div>
                                    <div class="auth-section">
                                        <a href="${this.authUrl}" target="_blank" class="auth-link">
                                            🌐 Authenticate Now
                                        </a>
                                    </div>
                                </div>
                                ` : ''}

                                ${this.authCode ? `
                                <div class="info-item">
                                    <div class="info-label">Authentication Code</div>
                                    <div class="auth-code">${this.authCode}</div>
                                </div>
                                ` : ''}

                                <div class="info-item">
                                    <div class="info-label">Instructions</div>
                                    <div class="info-value">
                                        1. Click the authentication link<br>
                                        2. Enter the code above<br>
                                        3. Sign in with your Microsoft account
                                    </div>
                                </div>
                            </div>
                            ` : ''}
                        </div>
                    </div>
                </body>
                </html>
            `);
        });

        // Logout route
        this.app.get('/logout', (req, res) => {
            req.session.destroy();
            this.isAuthenticated = false;
            res.redirect('/login');
        });

        // Start web server
        const PORT = process.env.PORT || 10000;
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
            // Only shutdown if it's not a known packet error we're ignoring
            const errorStr = error.toString();
            const stackStr = error.stack ? error.stack.toString() : '';
            if (!errorStr.includes('PartialReadError') &&
                !errorStr.includes('packet_world_particles') &&
                !errorStr.includes('Particle') &&
                !errorStr.includes('protodef/src/compiler.js') &&
                !stackStr.includes('numeric.js') &&
                !stackStr.includes('f32') &&
                !stackStr.includes('eval at compile')) {
                shutdown('uncaughtException');
            }
        });
        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled rejection at:', promise, 'reason:', reason);
            shutdown('unhandledRejection');
        });
    }

    setupConsoleCapture() {
        const originalLog = console.log;
        const self = this; // Store reference to class instance

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

                    // Set auth data on web server
                    self.setAuthData(authCode, authUrl);

                    // Clear any existing timeout
                    if (self.authTimeout) {
                        clearTimeout(self.authTimeout);
                    }
                    // Set a new timeout for clearing auth data
                    self.authTimeout = setTimeout(() => {
                        logger.info('Authentication timed out.');
                        self.authCode = null;
                        self.authUrl = null;
                        self.isAuthenticated = false; // Reset authentication status after timeout
                    }, 15 * 60 * 1000); // 15 minutes

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
                self.isAuthenticated = true; // Fixed: Use self instead of this
                if (self.discordClient && self.discordClient.sendStatusEmbed) {
                    self.discordClient.sendStatusEmbed('🔑 Authenticated', 'Successfully signed in with Microsoft account', 0x00FF00);
                }
            }

            // Call original console.log
            originalLog.apply(console, args);
        };
    }

    // Method to set authentication data
    setAuthData(code, url) {
        this.authCode = code;
        this.authUrl = url;
    }
}

// Start the bridge
const bridge = new MinecraftDiscordBridge();
bridge.initialize().catch((error) => {
    logger.error('Failed to start bridge:', error);
    process.exit(1);
});
