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

// Note: Uncaught exception handling is done in setupGracefulShutdown() to avoid duplicates

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
            
            // Set initial status to disconnected
            await this.discordClient.setStatus('disconnected');

            // Initialize Minecraft bot
            this.minecraftBot = new MinecraftBot(this.discordClient);
            
            // Connect Discord client to Minecraft bot for slash commands
            this.discordClient.setMinecraftBot(this.minecraftBot);

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
                // Set status to authentication mode
                if (this.discordClient && this.discordClient.setStatus) {
                    this.discordClient.setStatus('authentication');
                }
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
                    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
                    <style>
                        * {
                            margin: 0;
                            padding: 0;
                            box-sizing: border-box;
                        }

                        body {
                            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                            background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 25%, #16213e 50%, #0f3460 100%);
                            min-height: 100vh;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            padding: 20px;
                            position: relative;
                            overflow: hidden;
                        }

                        body::before {
                            content: '';
                            position: absolute;
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                            background: 
                                radial-gradient(circle at 20% 80%, rgba(0, 255, 255, 0.1) 0%, transparent 50%),
                                radial-gradient(circle at 80% 20%, rgba(0, 255, 255, 0.08) 0%, transparent 50%),
                                radial-gradient(circle at 40% 40%, rgba(0, 255, 255, 0.05) 0%, transparent 50%);
                            pointer-events: none;
                        }

                        .particles {
                            position: absolute;
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                            overflow: hidden;
                            pointer-events: none;
                        }

                        .particle {
                            position: absolute;
                            background: rgba(0, 255, 255, 0.6);
                            border-radius: 50%;
                            animation: float 6s infinite linear;
                        }

                        .particle:nth-child(1) { left: 10%; width: 2px; height: 2px; animation-delay: 0s; }
                        .particle:nth-child(2) { left: 20%; width: 3px; height: 3px; animation-delay: 2s; }
                        .particle:nth-child(3) { left: 30%; width: 2px; height: 2px; animation-delay: 4s; }
                        .particle:nth-child(4) { left: 40%; width: 4px; height: 4px; animation-delay: 1s; }
                        .particle:nth-child(5) { left: 50%; width: 2px; height: 2px; animation-delay: 3s; }
                        .particle:nth-child(6) { left: 60%; width: 3px; height: 3px; animation-delay: 5s; }
                        .particle:nth-child(7) { left: 70%; width: 2px; height: 2px; animation-delay: 1.5s; }
                        .particle:nth-child(8) { left: 80%; width: 3px; height: 3px; animation-delay: 3.5s; }
                        .particle:nth-child(9) { left: 90%; width: 2px; height: 2px; animation-delay: 0.5s; }

                        @keyframes float {
                            0% { transform: translateY(100vh) rotate(0deg); opacity: 0; }
                            10% { opacity: 1; }
                            90% { opacity: 1; }
                            100% { transform: translateY(-100px) rotate(360deg); opacity: 0; }
                        }

                        .login-container {
                            background: rgba(13, 13, 13, 0.95);
                            border: 1px solid rgba(0, 255, 255, 0.2);
                            padding: 50px;
                            border-radius: 24px;
                            box-shadow: 
                                0 20px 60px rgba(0, 0, 0, 0.5),
                                inset 0 1px 0 rgba(0, 255, 255, 0.1);
                            text-align: center;
                            max-width: 450px;
                            width: 100%;
                            backdrop-filter: blur(20px);
                            position: relative;
                            animation: slideIn 0.8s ease-out;
                        }

                        @keyframes slideIn {
                            from {
                                opacity: 0;
                                transform: translateY(50px) scale(0.9);
                            }
                            to {
                                opacity: 1;
                                transform: translateY(0) scale(1);
                            }
                        }

                        .login-container::before {
                            content: '';
                            position: absolute;
                            top: -2px;
                            left: -2px;
                            right: -2px;
                            bottom: -2px;
                            background: linear-gradient(45deg, 
                                transparent, 
                                rgba(0, 255, 255, 0.3), 
                                transparent, 
                                rgba(0, 255, 255, 0.3),
                                transparent);
                            border-radius: 24px;
                            z-index: -1;
                            animation: borderGlow 3s linear infinite;
                        }

                        @keyframes borderGlow {
                            0% { background-position: 0% 0%; }
                            100% { background-position: 400% 0%; }
                        }

                        .logo {
                            width: 80px;
                            height: 80px;
                            margin: 0 auto 30px;
                            background: linear-gradient(135deg, #00ffff, #0080ff);
                            border-radius: 20px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            font-size: 2rem;
                            box-shadow: 0 10px 30px rgba(0, 255, 255, 0.3);
                            animation: logoFloat 3s ease-in-out infinite;
                        }

                        @keyframes logoFloat {
                            0%, 100% { transform: translateY(0px); }
                            50% { transform: translateY(-10px); }
                        }

                        h1 {
                            color: #ffffff;
                            margin-bottom: 10px;
                            font-size: 2.2rem;
                            font-weight: 700;
                            background: linear-gradient(135deg, #00ffff, #ffffff);
                            -webkit-background-clip: text;
                            -webkit-text-fill-color: transparent;
                            background-clip: text;
                        }

                        .subtitle {
                            color: #888;
                            margin-bottom: 40px;
                            font-size: 0.95rem;
                            letter-spacing: 0.5px;
                        }

                        .input-group {
                            margin-bottom: 30px;
                            text-align: left;
                            position: relative;
                        }

                        label {
                            display: block;
                            margin-bottom: 12px;
                            color: #00ffff;
                            font-weight: 600;
                            font-size: 0.9rem;
                            text-transform: uppercase;
                            letter-spacing: 1px;
                        }

                        .input-wrapper {
                            position: relative;
                        }

                        input[type=password] {
                            width: 100%;
                            padding: 18px 50px 18px 20px;
                            border: 2px solid rgba(0, 255, 255, 0.2);
                            border-radius: 12px;
                            font-size: 16px;
                            transition: all 0.3s ease;
                            background: rgba(0, 0, 0, 0.3);
                            color: white;
                            font-family: inherit;
                        }

                        input[type=password]:focus {
                            outline: none;
                            border-color: #00ffff;
                            background: rgba(0, 0, 0, 0.5);
                            box-shadow: 0 0 20px rgba(0, 255, 255, 0.2);
                            transform: translateY(-2px);
                        }

                        input[type=password]::placeholder {
                            color: #666;
                        }

                        .input-icon {
                            position: absolute;
                            right: 18px;
                            top: 50%;
                            transform: translateY(-50%);
                            color: #00ffff;
                            font-size: 1.1rem;
                        }

                        .login-button {
                            width: 100%;
                            padding: 18px;
                            background: linear-gradient(135deg, #00ffff 0%, #0080ff 100%);
                            color: #000;
                            border: none;
                            border-radius: 12px;
                            font-size: 16px;
                            font-weight: 700;
                            cursor: pointer;
                            transition: all 0.3s ease;
                            text-transform: uppercase;
                            letter-spacing: 1px;
                            position: relative;
                            overflow: hidden;
                        }

                        .login-button::before {
                            content: '';
                            position: absolute;
                            top: 0;
                            left: -100%;
                            width: 100%;
                            height: 100%;
                            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
                            transition: left 0.5s;
                        }

                        .login-button:hover::before {
                            left: 100%;
                        }

                        .login-button:hover {
                            transform: translateY(-2px);
                            box-shadow: 0 15px 40px rgba(0, 255, 255, 0.4);
                        }

                        .login-button:active {
                            transform: translateY(0);
                        }

                        .error {
                            color: #ff4757;
                            margin-top: 20px;
                            padding: 15px;
                            background: rgba(255, 71, 87, 0.1);
                            border: 1px solid rgba(255, 71, 87, 0.3);
                            border-radius: 8px;
                            font-weight: 500;
                            animation: shake 0.5s ease-in-out;
                        }

                        @keyframes shake {
                            0%, 100% { transform: translateX(0); }
                            25% { transform: translateX(-5px); }
                            75% { transform: translateX(5px); }
                        }

                        .loading {
                            display: none;
                            margin-top: 20px;
                        }

                        .loading.show {
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            gap: 10px;
                        }

                        .loading-spinner {
                            width: 20px;
                            height: 20px;
                            border: 2px solid rgba(0, 255, 255, 0.3);
                            border-top: 2px solid #00ffff;
                            border-radius: 50%;
                            animation: spin 1s linear infinite;
                        }

                        @keyframes spin {
                            0% { transform: rotate(0deg); }
                            100% { transform: rotate(360deg); }
                        }

                        @media (max-width: 480px) {
                            .login-container {
                                padding: 30px;
                                margin: 10px;
                            }

                            h1 {
                                font-size: 1.8rem;
                            }
                        }
                    </style>
                </head>
                <body>
                    <div class="particles">
                        <div class="particle"></div>
                        <div class="particle"></div>
                        <div class="particle"></div>
                        <div class="particle"></div>
                        <div class="particle"></div>
                        <div class="particle"></div>
                        <div class="particle"></div>
                        <div class="particle"></div>
                        <div class="particle"></div>
                    </div>
                    
                    <div class="login-container" id="loginContainer">
                        <div class="logo">🎮</div>
                        <h1>Minecraft Bot</h1>
                        <p class="subtitle">Secure Dashboard Access</p>
                        
                        <form action="/login" method="post" id="loginForm">
                            <div class="input-group">
                                <label for="password">Access Code</label>
                                <div class="input-wrapper">
                                    <input type="password" name="password" id="password" placeholder="Enter your password" required>
                                    <i class="fas fa-lock input-icon"></i>
                                </div>
                            </div>
                            <button type="submit" class="login-button">
                                <span>Access Dashboard</span>
                            </button>
                            
                            <div class="loading" id="loading">
                                <div class="loading-spinner"></div>
                                <span style="color: #00ffff;">Authenticating...</span>
                            </div>
                        </form>
                        ${req.query.error ? '<div class="error"><i class="fas fa-exclamation-triangle"></i> Incorrect password. Please try again.</div>' : ''}
                    </div>

                    <script>
                        document.getElementById('loginForm').addEventListener('submit', function(e) {
                            const button = document.querySelector('.login-button');
                            const loading = document.getElementById('loading');
                            
                            button.style.opacity = '0.7';
                            button.disabled = true;
                            loading.classList.add('show');
                        });

                        // Add enter key animation
                        document.getElementById('password').addEventListener('keypress', function(e) {
                            if (e.key === 'Enter') {
                                this.style.transform = 'scale(0.98)';
                                setTimeout(() => {
                                    this.style.transform = 'scale(1)';
                                }, 100);
                            }
                        });
                    </script>
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
                    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
                    <style>
                        * {
                            margin: 0;
                            padding: 0;
                            box-sizing: border-box;
                        }

                        body {
                            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                            background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 25%, #16213e 50%, #0f3460 100%);
                            min-height: 100vh;
                            color: #ffffff;
                            overflow-x: hidden;
                            position: relative;
                        }

                        body::before {
                            content: '';
                            position: fixed;
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                            background: 
                                radial-gradient(circle at 20% 80%, rgba(0, 255, 255, 0.08) 0%, transparent 50%),
                                radial-gradient(circle at 80% 20%, rgba(0, 255, 255, 0.06) 0%, transparent 50%),
                                radial-gradient(circle at 40% 40%, rgba(0, 255, 255, 0.04) 0%, transparent 50%);
                            pointer-events: none;
                            z-index: -2;
                        }

                        .loading-overlay {
                            position: fixed;
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                            background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 100%);
                            z-index: 10000;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            flex-direction: column;
                            animation: fadeOut 1s ease-in-out 2s forwards;
                        }

                        @keyframes fadeOut {
                            to {
                                opacity: 0;
                                visibility: hidden;
                            }
                        }

                        .loading-spinner {
                            width: 60px;
                            height: 60px;
                            border: 3px solid rgba(0, 255, 255, 0.3);
                            border-top: 3px solid #00ffff;
                            border-radius: 50%;
                            animation: spin 1s linear infinite;
                            margin-bottom: 20px;
                        }

                        @keyframes spin {
                            0% { transform: rotate(0deg); }
                            100% { transform: rotate(360deg); }
                        }

                        .loading-text {
                            color: #00ffff;
                            font-size: 1.2rem;
                            font-weight: 600;
                            letter-spacing: 2px;
                            animation: pulse 2s ease-in-out infinite;
                        }

                        @keyframes pulse {
                            0%, 100% { opacity: 0.7; }
                            50% { opacity: 1; }
                        }

                        .container {
                            max-width: 1400px;
                            margin: 0 auto;
                            padding: 20px;
                            opacity: 0;
                            animation: slideInUp 1s ease-out 2.5s forwards;
                        }

                        @keyframes slideInUp {
                            from {
                                opacity: 0;
                                transform: translateY(30px);
                            }
                            to {
                                opacity: 1;
                                transform: translateY(0);
                            }
                        }

                        .header {
                            background: rgba(13, 13, 13, 0.9);
                            border: 1px solid rgba(0, 255, 255, 0.2);
                            padding: 40px;
                            border-radius: 24px;
                            margin-bottom: 30px;
                            box-shadow: 
                                0 20px 60px rgba(0, 0, 0, 0.5),
                                inset 0 1px 0 rgba(0, 255, 255, 0.1);
                            backdrop-filter: blur(20px);
                            text-align: center;
                            position: relative;
                            overflow: hidden;
                        }

                        .header::before {
                            content: '';
                            position: absolute;
                            top: -2px;
                            left: -2px;
                            right: -2px;
                            bottom: -2px;
                            background: linear-gradient(45deg, 
                                transparent, 
                                rgba(0, 255, 255, 0.2), 
                                transparent, 
                                rgba(0, 255, 255, 0.2),
                                transparent);
                            border-radius: 24px;
                            z-index: -1;
                            animation: borderFlow 4s linear infinite;
                        }

                        @keyframes borderFlow {
                            0% { background-position: 0% 0%; }
                            100% { background-position: 400% 0%; }
                        }

                        .logo-section {
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            gap: 20px;
                            margin-bottom: 20px;
                        }

                        .logo {
                            width: 80px;
                            height: 80px;
                            background: linear-gradient(135deg, #00ffff, #0080ff);
                            border-radius: 20px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            font-size: 2rem;
                            box-shadow: 0 15px 40px rgba(0, 255, 255, 0.3);
                            animation: logoFloat 3s ease-in-out infinite;
                        }

                        @keyframes logoFloat {
                            0%, 100% { transform: translateY(0px) rotate(0deg); }
                            50% { transform: translateY(-10px) rotate(5deg); }
                        }

                        .minecraft-title {
                            background: linear-gradient(135deg, #00ffff 0%, #ffffff 50%, #00ffff 100%);
                            -webkit-background-clip: text;
                            -webkit-text-fill-color: transparent;
                            background-clip: text;
                            font-size: 3rem;
                            font-weight: 800;
                            letter-spacing: 2px;
                            margin: 0;
                        }

                        .subtitle {
                            color: #888;
                            font-size: 1.1rem;
                            margin-top: 10px;
                            letter-spacing: 1px;
                            text-transform: uppercase;
                        }

                        .dashboard-grid {
                            display: grid;
                            grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
                            gap: 30px;
                            animation: staggerCards 1s ease-out 3s both;
                        }

                        @keyframes staggerCards {
                            from {
                                opacity: 0;
                                transform: translateY(20px);
                            }
                            to {
                                opacity: 1;
                                transform: translateY(0);
                            }
                        }

                        .card {
                            background: rgba(13, 13, 13, 0.95);
                            border: 1px solid rgba(0, 255, 255, 0.15);
                            padding: 30px;
                            border-radius: 20px;
                            box-shadow: 
                                0 15px 40px rgba(0, 0, 0, 0.4),
                                inset 0 1px 0 rgba(0, 255, 255, 0.1);
                            backdrop-filter: blur(20px);
                            position: relative;
                            transition: all 0.4s ease;
                            overflow: hidden;
                        }

                        .card::before {
                            content: '';
                            position: absolute;
                            top: 0;
                            left: -100%;
                            width: 100%;
                            height: 100%;
                            background: linear-gradient(90deg, 
                                transparent, 
                                rgba(0, 255, 255, 0.1), 
                                transparent);
                            transition: left 0.6s ease;
                        }

                        .card:hover::before {
                            left: 100%;
                        }

                        .card:hover {
                            transform: translateY(-8px);
                            border-color: rgba(0, 255, 255, 0.4);
                            box-shadow: 
                                0 25px 60px rgba(0, 0, 0, 0.6),
                                0 0 40px rgba(0, 255, 255, 0.15);
                        }

                        .card h2 {
                            margin-bottom: 25px;
                            color: #ffffff;
                            font-size: 1.4rem;
                            font-weight: 700;
                            display: flex;
                            align-items: center;
                            gap: 12px;
                            text-transform: uppercase;
                            letter-spacing: 1px;
                        }

                        .status-indicator {
                            width: 16px;
                            height: 16px;
                            border-radius: 50%;
                            display: inline-block;
                            position: relative;
                            animation: statusPulse 2s ease-in-out infinite;
                        }

                        .status-indicator.online {
                            background: #00ffff;
                            box-shadow: 0 0 20px rgba(0, 255, 255, 0.6);
                        }

                        .status-indicator.offline {
                            background: #ff4757;
                            box-shadow: 0 0 20px rgba(255, 71, 87, 0.6);
                        }

                        @keyframes statusPulse {
                            0%, 100% { 
                                transform: scale(1); 
                                box-shadow: 0 0 20px rgba(0, 255, 255, 0.6);
                            }
                            50% { 
                                transform: scale(1.2); 
                                box-shadow: 0 0 30px rgba(0, 255, 255, 0.8);
                            }
                        }

                        .info-item {
                            margin-bottom: 20px;
                            padding: 18px;
                            background: rgba(0, 0, 0, 0.3);
                            border-radius: 12px;
                            border-left: 3px solid #00ffff;
                            transition: all 0.3s ease;
                            position: relative;
                            overflow: hidden;
                        }

                        .info-item:hover {
                            background: rgba(0, 255, 255, 0.05);
                            transform: translateX(5px);
                        }

                        .info-label {
                            font-weight: 600;
                            color: #00ffff;
                            margin-bottom: 8px;
                            font-size: 0.9rem;
                            text-transform: uppercase;
                            letter-spacing: 1px;
                        }

                        .info-value {
                            color: #ffffff;
                            font-size: 1.1rem;
                            font-weight: 500;
                        }

                        .logout-btn {
                            position: fixed;
                            top: 25px;
                            right: 25px;
                            padding: 12px 24px;
                            background: rgba(13, 13, 13, 0.9);
                            color: #00ffff;
                            border: 1px solid rgba(0, 255, 255, 0.3);
                            border-radius: 12px;
                            text-decoration: none;
                            font-weight: 600;
                            transition: all 0.3s ease;
                            backdrop-filter: blur(10px);
                            z-index: 1000;
                            display: flex;
                            align-items: center;
                            gap: 8px;
                        }

                        .logout-btn:hover {
                            background: rgba(0, 255, 255, 0.1);
                            border-color: #00ffff;
                            transform: translateY(-2px);
                            box-shadow: 0 10px 25px rgba(0, 255, 255, 0.2);
                        }

                        .auth-section {
                            margin-top: 20px;
                        }

                        .auth-link {
                            display: inline-block;
                            padding: 14px 28px;
                            background: linear-gradient(135deg, #00ffff 0%, #0080ff 100%);
                            color: #000;
                            text-decoration: none;
                            border-radius: 10px;
                            font-weight: 700;
                            transition: all 0.3s ease;
                            text-transform: uppercase;
                            letter-spacing: 1px;
                        }

                        .auth-link:hover {
                            transform: translateY(-3px);
                            box-shadow: 0 15px 40px rgba(0, 255, 255, 0.4);
                        }

                        .auth-code {
                            background: rgba(0, 0, 0, 0.5);
                            color: #00ffff;
                            padding: 15px 20px;
                            border-radius: 10px;
                            font-family: 'Courier New', monospace;
                            font-size: 1.3rem;
                            font-weight: bold;
                            letter-spacing: 3px;
                            margin: 15px 0;
                            display: inline-block;
                            border: 1px solid rgba(0, 255, 255, 0.3);
                        }

                        /* Authentication Modal */
                        .auth-modal {
                            display: ${this.authCode || this.authUrl ? 'flex' : 'none'};
                            position: fixed;
                            z-index: 10000;
                            left: 0;
                            top: 0;
                            width: 100%;
                            height: 100%;
                            background: rgba(0, 0, 0, 0.9);
                            backdrop-filter: blur(10px);
                            align-items: center;
                            justify-content: center;
                            animation: authFadeIn 0.5s ease;
                        }

                        .auth-modal-content {
                            background: rgba(13, 13, 13, 0.95);
                            border: 1px solid rgba(0, 255, 255, 0.3);
                            padding: 50px;
                            border-radius: 24px;
                            box-shadow: 
                                0 30px 80px rgba(0, 0, 0, 0.8),
                                inset 0 1px 0 rgba(0, 255, 255, 0.2);
                            text-align: center;
                            max-width: 700px;
                            width: 90%;
                            color: white;
                            animation: authSlideIn 0.6s ease;
                            position: relative;
                        }

                        @keyframes authFadeIn {
                            from { opacity: 0; }
                            to { opacity: 1; }
                        }

                        @keyframes authSlideIn {
                            from { 
                                opacity: 0; 
                                transform: translateY(-50px) scale(0.9); 
                            }
                            to { 
                                opacity: 1; 
                                transform: translateY(0) scale(1); 
                            }
                        }

                        .auth-modal h2 {
                            font-size: 2.5rem;
                            margin-bottom: 20px;
                            background: linear-gradient(135deg, #00ffff, #ffffff);
                            -webkit-background-clip: text;
                            -webkit-text-fill-color: transparent;
                            background-clip: text;
                        }

                        .auth-modal p {
                            font-size: 1.2rem;
                            margin-bottom: 30px;
                            color: #888;
                        }

                        .auth-big-code {
                            background: rgba(0, 0, 0, 0.5);
                            border: 2px solid rgba(0, 255, 255, 0.3);
                            padding: 25px 35px;
                            border-radius: 15px;
                            font-family: 'Courier New', monospace;
                            font-size: 2rem;
                            font-weight: bold;
                            letter-spacing: 4px;
                            margin: 25px 0;
                            color: #00ffff;
                            backdrop-filter: blur(10px);
                        }

                        .auth-big-button {
                            display: inline-block;
                            padding: 20px 40px;
                            background: linear-gradient(135deg, #00ffff 0%, #0080ff 100%);
                            color: #000;
                            text-decoration: none;
                            border-radius: 15px;
                            font-size: 1.3rem;
                            font-weight: 700;
                            margin: 20px 10px;
                            transition: all 0.3s ease;
                            border: none;
                            cursor: pointer;
                            text-transform: uppercase;
                            letter-spacing: 1px;
                        }

                        .auth-big-button:hover {
                            transform: translateY(-3px);
                            box-shadow: 0 15px 40px rgba(0, 255, 255, 0.4);
                        }

                        .auth-steps {
                            text-align: left;
                            background: rgba(0, 0, 0, 0.3);
                            border: 1px solid rgba(0, 255, 255, 0.2);
                            padding: 25px;
                            border-radius: 15px;
                            margin: 25px 0;
                            backdrop-filter: blur(10px);
                        }

                        .auth-steps h3 {
                            text-align: center;
                            margin-bottom: 15px;
                            font-size: 1.4rem;
                            color: #00ffff;
                        }

                        .auth-steps ol {
                            font-size: 1.1rem;
                            line-height: 1.8;
                            color: #ccc;
                        }

                        .auth-steps li {
                            margin: 10px 0;
                        }

                        @media (max-width: 768px) {
                            .container {
                                padding: 15px;
                            }

                            .minecraft-title {
                                font-size: 2.2rem;
                            }

                            .dashboard-grid {
                                grid-template-columns: 1fr;
                                gap: 20px;
                            }

                            .card {
                                padding: 25px;
                            }

                            .logout-btn {
                                position: relative;
                                top: auto;
                                right: auto;
                                margin: 20px auto;
                                display: flex;
                                width: fit-content;
                            }

                            .auth-modal-content {
                                padding: 30px 20px;
                                width: 95%;
                            }

                            .auth-big-code {
                                font-size: 1.5rem;
                                letter-spacing: 2px;
                                padding: 20px;
                            }
                        }
                    </style>
                </head>
                <body>
                    <div class="loading-overlay">
                        <div class="loading-spinner"></div>
                        <div class="loading-text">INITIALIZING DASHBOARD</div>
                    </div>

                    <a href="/logout" class="logout-btn">
                        <i class="fas fa-sign-out-alt"></i>
                        Logout
                    </a>

                    <!-- Authentication Modal -->
                    <div class="auth-modal" id="authModal">
                        <div class="auth-modal-content">
                            <h2><i class="fas fa-lock"></i> Authentication Required</h2>
                            <p>Please authenticate your Minecraft account to continue</p>
                            
                            ${this.authCode ? `
                            <div class="auth-big-code">${this.authCode}</div>
                            ` : ''}
                            
                            ${this.authUrl ? `
                            <a href="${this.authUrl}" target="_blank" class="auth-big-button">
                                <i class="fas fa-external-link-alt"></i> Authenticate Now
                            </a>
                            ` : ''}
                            
                            <div class="auth-steps">
                                <h3><i class="fas fa-list-ol"></i> Authentication Steps</h3>
                                <ol>
                                    <li>Click the "Authenticate Now" button above</li>
                                    <li>Enter the authentication code: <strong>${this.authCode || 'Loading...'}</strong></li>
                                    <li>Sign in with your Microsoft/Minecraft account</li>
                                    <li>Return to this page - it will update automatically</li>
                                </ol>
                            </div>
                        </div>
                    </div>

                    <div class="container">
                        <div class="header">
                            <div class="logo-section">
                                <div class="logo">🎮</div>
                                <div>
                                    <h1 class="minecraft-title">MINECRAFT BOT</h1>
                                    <p class="subtitle">Advanced Dashboard</p>
                                </div>
                            </div>
                        </div>

                        <div class="dashboard-grid">
                            <div class="card">
                                <h2>
                                    <span class="status-indicator ${isOnline ? 'online' : 'offline'}"></span>
                                    <i class="fas fa-robot"></i>
                                    Bot Status
                                </h2>

                                <div class="info-item">
                                    <div class="info-label"><i class="fas fa-power-off"></i> Status</div>
                                    <div class="info-value">${isOnline ? '🟢 ONLINE' : '🔴 OFFLINE'}</div>
                                </div>

                                <div class="info-item">
                                    <div class="info-label"><i class="fas fa-server"></i> Server</div>
                                    <div class="info-value">${config.minecraft.host}:${config.minecraft.port}</div>
                                </div>

                                <div class="info-item">
                                    <div class="info-label"><i class="fas fa-user"></i> Username</div>
                                    <div class="info-value">${config.minecraft.username}</div>
                                </div>

                                <div class="info-item">
                                    <div class="info-label"><i class="fas fa-users"></i> Players Online</div>
                                    <div class="info-value">${playerCount} players</div>
                                </div>

                                <div class="info-item">
                                    <div class="info-label"><i class="fas fa-shield-alt"></i> Anti-AFK</div>
                                    <div class="info-value">${config.minecraft.enableAntiAfk ? '✅ Enabled' : '❌ Disabled'}</div>
                                </div>
                            </div>

                            ${this.authUrl || this.authCode ? `
                            <div class="card">
                                <h2><i class="fas fa-key"></i> Authentication</h2>

                                ${this.authUrl ? `
                                <div class="info-item">
                                    <div class="info-label"><i class="fas fa-link"></i> Authentication URL</div>
                                    <div class="auth-section">
                                        <a href="${this.authUrl}" target="_blank" class="auth-link">
                                            <i class="fas fa-external-link-alt"></i> Authenticate Now
                                        </a>
                                    </div>
                                </div>
                                ` : ''}

                                ${this.authCode ? `
                                <div class="info-item">
                                    <div class="info-label"><i class="fas fa-code"></i> Authentication Code</div>
                                    <div class="auth-code">${this.authCode}</div>
                                </div>
                                ` : ''}

                                <div class="info-item">
                                    <div class="info-label"><i class="fas fa-info-circle"></i> Instructions</div>
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

                    <script>
                        // Auto-refresh and transition logic
                        function checkAuthStatus() {
                            const authModal = document.getElementById('authModal');
                            if (authModal && window.getComputedStyle(authModal).display !== 'none') {
                                setTimeout(() => {
                                    window.location.reload();
                                }, 5000);
                            } else {
                                setTimeout(() => {
                                    window.location.reload();
                                }, 30000);
                            }
                        }
                        
                        document.addEventListener('DOMContentLoaded', function() {
                            // Start auth status checking
                            checkAuthStatus();
                            
                            // Add staggered animation to cards
                            const cards = document.querySelectorAll('.card');
                            cards.forEach((card, index) => {
                                card.style.animationDelay = (3.2 + index * 0.1) + 's';
                            });
                        });
                    </script>
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
        const PORT = process.env.PORT || 5000;
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
            // Filter out known packet parsing errors
            const errorStr = error ? error.toString() : 'Unknown error';
            const stackStr = error && error.stack ? error.stack.toString() : '';
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
            // Only log and shutdown for meaningful errors
            if (error && (error.message || error.stack || errorStr !== '[object Object]')) {
                logger.error('Uncaught exception:', error);
                shutdown('uncaughtException');
            }
        });
        process.on('unhandledRejection', (reason, promise) => {
            // Filter out empty or meaningless rejections
            if (reason && (reason.message || reason.stack || (typeof reason === 'string' && reason.length > 0))) {
                logger.error('Unhandled rejection at:', promise, 'reason:', reason);
                shutdown('unhandledRejection');
            }
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
                    
                    // Update Discord status to authentication mode
                    if (self.discordClient && self.discordClient.setStatus) {
                        self.discordClient.setStatus('authentication');
                    }

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
                // Clear auth data after successful authentication
                self.authCode = null;
                self.authUrl = null;
                // Update Discord status to connected
                if (self.discordClient && self.discordClient.setStatus) {
                    self.discordClient.setStatus('connected');
                }
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