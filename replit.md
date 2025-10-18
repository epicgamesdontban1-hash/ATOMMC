# Overview

This is a Minecraft-Discord bridge bot that connects a Minecraft server to Discord, providing real-time updates, player tracking, and remote bot management through both Discord and a web interface. The bot uses the Mineflayer library to connect to Minecraft servers and Discord.js for Discord integration, featuring authentication, automatic reconnection, anti-AFK functionality, and player list monitoring.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Application Structure

The application follows a modular architecture with separate components for different concerns:

- **Server orchestration** (`server.js`) - Main entry point that initializes and coordinates all components
- **Minecraft bot client** (`minecraft-bot.js`) - Handles Minecraft server connection and game interactions
- **Discord client** (`discord-client.js`) - Manages Discord bot connection and message handling
- **Web server** (embedded in `server.js`) - Provides HTTP endpoints for bot control and monitoring
- **Configuration management** (`config.js`) - Centralized configuration with environment variable support
- **Logging system** (`logger.js`) - Unified logging with configurable levels and formatting

## Bot Architecture

**Connection Management:**
- Implements automatic reconnection with exponential backoff for both Minecraft and Discord connections
- Tracks connection state and handles graceful shutdown/restart scenarios
- Uses Microsoft authentication (Prismarine-auth) for Minecraft login
- Maintains persistent message IDs for Discord embeds using file-based caching

**Event-Driven Design:**
- Minecraft events (player join/leave, chat messages) trigger Discord notifications
- Discord commands can control the Minecraft bot remotely
- Web socket events enable real-time status updates to connected clients

**Player Tracking:**
- Maintains in-memory Set of current players on the server
- Implements closest player tracking using position calculations
- Periodic status updates sent to Discord channels

## Authentication & Security

**Multi-layer Authentication:**
- Microsoft authentication for Minecraft (production mode)
- Simple password-based authentication for web interface with session management
- Discord integration uses bot token authentication
- Environment variable-based credential management (no hardcoded secrets)

**Rationale:** Simple password auth for web interface is sufficient for single-user/small team scenarios. Microsoft auth for Minecraft ensures legitimate server access. Discord bot tokens provide OAuth2-based security.

## Communication Patterns

**Discord Integration:**
- Uses Discord.js v14 with gateway intents for bot functionality
- Implements webhook fallback when bot token is unavailable
- Message batching and queuing system to handle rate limits
- Persistent embed messages for status and player list (updated in-place)
- Stores message IDs in JSON file for persistence across restarts

**Web Interface:**
- Express server with CORS support for cross-origin requests
- Session-based authentication with configurable timeout
- RESTful endpoints for bot control (connect, disconnect, status)
- Real-time updates via polling or WebSocket (Socket.IO dependency present)

**Rationale:** Discord embeds provide rich, updatable status displays. Message queuing prevents rate limit issues. Persistent message IDs avoid spam from recreating status messages on restart.

## Anti-AFK System

**Optional Feature:**
- Configurable via environment variable (`ENABLE_ANTI_AFK`)
- Implements periodic movement/actions to prevent server kicks
- Can be toggled without code changes

**Rationale:** Some servers kick idle players; this keeps the bot connected for continuous monitoring.

## Error Handling & Resilience

**Retry Mechanisms:**
- Configurable maximum reconnection attempts for Minecraft
- Message queue with retry counter for Discord sends
- Graceful degradation when Discord is unavailable

**Resource Cleanup:**
- Comprehensive timer/interval cleanup on shutdown
- Prevents memory leaks from orphaned intervals
- Handles both graceful and forced shutdowns

**Alternatives Considered:** Could use process managers like PM2 for restart logic, but built-in reconnection provides more control and better logging.

## Configuration Strategy

**Environment-First Approach:**
- All sensitive data (tokens, passwords) from environment variables
- Sensible defaults for development/testing
- Validation on startup with warnings for missing optional configs
- Discord integration gracefully disabled if not configured

**Rationale:** 12-factor app methodology for cloud deployment compatibility. Makes the bot deployable to various platforms (Vercel, Heroku, Docker) without code changes.

## Data Persistence

**Minimal State Storage:**
- Discord message IDs cached to filesystem (`./cache` directory)
- No database requirements - all state is ephemeral or recoverable
- Session data stored in-memory via express-session

**Rationale:** The bot is primarily a relay/monitoring service without historical data needs. File-based caching is sufficient for message ID persistence. This keeps deployment simple and reduces infrastructure requirements.

**Alternatives Considered:** Could use SQLite or Postgres for message history/analytics, but current use case doesn't justify the complexity.

# External Dependencies

## Third-Party Libraries

**Minecraft Integration:**
- `mineflayer` (v4.25.0) - Minecraft bot client library
- `prismarine-auth` (v2.7.0) - Microsoft/Xbox Live authentication for Minecraft

**Discord Integration:**
- `discord.js` (v14.22.1) - Discord bot API wrapper with gateway support
- Supports embeds, slash commands, buttons, and message components

**Web Server:**
- `express` (v5.1.0) - HTTP server framework
- `express-session` (v1.18.2) - Session management middleware
- `cors` (v2.8.5) - Cross-Origin Resource Sharing support
- `socket.io` (v4.8.1) - WebSocket library for real-time communication

**Utilities:**
- `dotenv` (v17.2.1) - Environment variable loader
- `node-fetch` (v3.3.2) - HTTP client for API requests
- `@azure/msal-node` - Microsoft Authentication Library (dependency of prismarine-auth)

## External Services

**Minecraft Server:**
- Connects to configurable Minecraft server via TCP
- Default: `play.atommc.co.za:25565`
- Supports versions 1.21.4 (configurable)

**Discord Platform:**
- Discord Bot API (Gateway v10)
- Discord Webhook API (fallback mode)
- Requires bot token or webhook URL

**Microsoft Authentication:**
- Xbox Live authentication flow
- Microsoft account OAuth2 for Minecraft login
- Required for online-mode Minecraft servers

## Development Tools

- `nodemon` (v3.1.0) - Development server with auto-reload

## Deployment Considerations

The application is designed for Node.js runtime environments and can be deployed to:
- Traditional VPS/cloud instances
- Container platforms (Docker)
- Platform-as-a-Service (Vercel, Heroku, Railway)
- Requires persistent storage for cache directory
- Requires environment variable support for configuration