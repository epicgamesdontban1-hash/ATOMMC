const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const MinecraftBot = require('./minecraft-bot');
const DiscordClient = require('./discord-client');
const config = require('./config');
const logger = require('./logger');

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
        message.includes('Read error for undefined')) {
        // Silently ignore these packet parsing errors
        return;
    }
    originalConsoleError.apply(console, args);
};

// Also suppress uncaught exceptions from these specific errors
process.on('uncaughtException', (error) => {
    const errorStr = error.toString();
    if (errorStr.includes('PartialReadError') || 
        errorStr.includes('packet_world_particles') || 
        errorStr.includes('Particle') ||
        errorStr.includes('protodef/src/compiler.js')) {
        // Silently ignore packet parsing uncaught exceptions
        return;
    }
    logger.error('Uncaught exception:', error);
});

class MinecraftChatServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = socketIo(this.server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });
        this.messages = [];
        this.discordClient = null;
        this.minecraftBot = null;
        this.pendingMessages = new Map(); // For batching messages by timestamp
        this.batchTimeout = null;
    }

    async initialize() {
        // Setup Express middleware
        this.app.use(express.json());
        this.app.use(express.static('public'));

        // API routes
        this.app.get('/api/messages', (req, res) => {
            res.json(this.messages.slice(-100)); // Send last 100 messages
        });

        this.app.post('/api/messages', (req, res) => {
            const message = {
                player: req.body.player,
                message: req.body.message,
                isServer: req.body.isServer,
                timestamp: req.body.timestamp || new Date().toISOString()
            };
            
            this.addMessage(message);
            res.json({ success: true });
        });

        // Socket.io for real-time updates
        this.io.on('connection', (socket) => {
            logger.info('Client connected to website');
            // Send recent messages to new clients
            socket.emit('messageHistory', this.messages.slice(-50));
        });

        // Initialize Discord and Minecraft with enhanced error suppression
        try {
            logger.info('Connecting to Discord and Minecraft...');
            
            this.discordClient = new DiscordClient();
            await this.discordClient.connect();

            this.minecraftBot = new MinecraftBot(this.discordClient);
            
            // Override the sendToWebsite method to work with our server
            const originalSendToWebsite = this.minecraftBot.sendToWebsite;
            this.minecraftBot.sendToWebsite = (player, message, isServer) => {
                const messageObj = {
                    player,
                    message,
                    isServer,
                    timestamp: new Date().toISOString()
                };
                this.addMessage(messageObj);
            };

            this.setupConsoleCapture();
            await this.minecraftBot.connect();
            
            logger.info('Successfully connected to Minecraft server!');
        } catch (error) {
            logger.warn('Minecraft connection failed, website will still work:', error.message);
            // Add a status message
            this.addMessage({
                player: 'Server',
                message: 'Minecraft connection failed - check your server settings',
                isServer: true,
                timestamp: new Date().toISOString()
            });
        }

        // Start server
        this.server.listen(5000, '0.0.0.0', () => {
            logger.info('Web server running on port 5000');
            console.log('Minecraft chat website is live at http://localhost:5000');
        });
    }

    addMessage(message) {
        // If it's a server message, try to batch it
        if (message.isServer) {
            return this.batchMessage(message);
        }
        
        // Player messages send immediately
        this.messages.push(message);
        
        // Keep only last 1000 messages in memory
        if (this.messages.length > 1000) {
            this.messages = this.messages.slice(-1000);
        }
        
        // Broadcast to all connected clients
        this.io.emit('newMessage', message);
    }

    batchMessage(message) {
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

    flushBatchedMessages() {
        for (const [timestamp, messagesBatch] of this.pendingMessages.entries()) {
            if (messagesBatch.length === 1) {
                // Single message - send as normal
                const message = messagesBatch[0];
                this.messages.push(message);
                this.io.emit('newMessage', message);
            } else if (messagesBatch.length > 1) {
                // Multiple messages - combine them
                const combinedMessage = {
                    player: 'Server',
                    message: messagesBatch.map(m => m.message).join('\n'),
                    isServer: true,
                    timestamp: messagesBatch[0].timestamp,
                    isBatched: true
                };
                
                this.messages.push(combinedMessage);
                this.io.emit('newMessage', combinedMessage);
            }
        }
        
        // Keep only last 1000 messages in memory
        if (this.messages.length > 1000) {
            this.messages = this.messages.slice(-1000);
        }
        
        this.pendingMessages.clear();
        this.batchTimeout = null;
    }

    setupConsoleCapture() {
        const originalLog = console.log;
        const self = this;
        
        console.log = function(...args) {
            const message = args.join(' ');
            
            // Check for Microsoft authentication prompts
            if (message.includes('[msa] First time signing in') || 
                message.includes('To sign in, use a web browser')) {
                
                const codeMatch = message.match(/code ([A-Z0-9]+)/i);
                if (codeMatch) {
                    const authCode = codeMatch[1];
                    const authUrl = `https://www.microsoft.com/link?otc=${authCode}`;
                    logger.info(`Authentication prompt detected. Code: ${authCode}`);
                    self.discordClient.sendLoginEmbed(authCode, authUrl);
                }
            } else if (message.includes('[msa] Signed in with Microsoft')) {
                logger.info('Microsoft authentication successful');
                self.discordClient.sendStatusEmbed('🔑 Authenticated', 'Successfully signed in with Microsoft account', 0x00FF00);
            }
            
            // Call original console.log
            originalLog.apply(console, args);
        };
    }
}

// Start the server
const server = new MinecraftChatServer();
server.initialize().catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
});