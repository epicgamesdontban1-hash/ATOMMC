# Minecraft Discord Bridge

## Overview

A Node.js application that creates a bridge between Minecraft servers and Discord channels. The bot connects to a Minecraft server using Microsoft authentication and relays chat messages, events, and player activities to a specified Discord channel. It supports both Discord bot integration and webhook-based message delivery for flexible deployment options.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Core Components

**Main Application (index.js)**
- Serves as the orchestration layer that initializes and manages both Minecraft and Discord connections
- Implements graceful shutdown handling for clean disconnection from both services
- Manages the overall application lifecycle and error handling

**Minecraft Bot (minecraft-bot.js)**
- Uses the Mineflayer library to connect to Minecraft servers
- Implements Microsoft authentication via prismarine-auth for secure server connections
- Handles automatic reconnection logic with configurable retry attempts and delays
- Monitors and relays Minecraft server events (chat, player joins/leaves, deaths, etc.)

**Discord Client (discord-client.js)**
- Supports dual integration modes: Discord bot API and webhook delivery
- Implements message queuing to handle rate limiting and ensure reliable delivery
- Uses Discord.js v14 with minimal required intents for efficient operation
- Provides fallback mechanisms between bot and webhook modes

**Configuration Management (config.js)**
- Centralizes all environment-based configuration with sensible defaults
- Validates required configuration at startup to fail fast on misconfiguration
- Supports flexible Discord integration options (bot vs webhook)
- Includes Minecraft server connection parameters and authentication settings

**Logging System (logger.js)**
- Custom logging implementation with configurable log levels
- Structured log formatting with timestamps and level indicators
- Console output control for different deployment environments
- JSON serialization for complex objects in log messages

### Authentication Strategy

**Microsoft Authentication**
- Uses prismarine-auth for modern Minecraft account authentication
- Implements local caching to reduce authentication requests
- Supports the current Microsoft-based Minecraft authentication flow
- Handles authentication token refresh automatically

**Discord Authentication**
- Bot token authentication for full Discord API access
- Webhook URL authentication for simplified message posting
- Graceful degradation between authentication methods

### Connection Management

**Reconnection Logic**
- Configurable maximum retry attempts and delay intervals
- Exponential backoff strategy for failed connections
- Separate reconnection handling for Minecraft and Discord
- State management to prevent multiple simultaneous reconnection attempts

**Error Handling**
- Comprehensive error catching and logging at all integration points
- Graceful degradation when one service is unavailable
- Connection state tracking to enable proper cleanup and restart

## External Dependencies

**Minecraft Integration**
- **mineflayer**: Core Minecraft bot functionality and protocol handling
- **prismarine-auth**: Microsoft authentication for Minecraft accounts
- Requires Minecraft server with online-mode authentication

**Discord Integration**
- **discord.js**: Official Discord API library for bot functionality
- **node-fetch**: HTTP client for webhook-based Discord messaging
- Requires Discord bot token or webhook URL for message delivery

**Configuration**
- **dotenv**: Environment variable loading for configuration management
- Environment-based configuration for deployment flexibility

**Runtime Dependencies**
- Node.js runtime environment
- File system access for authentication token caching
- Network connectivity to both Minecraft servers and Discord API endpoints

## Recent Changes

### Replit Environment Setup (September 22, 2025)

**Configuration Updates**
- Modified `config.js` to make Discord integration optional for development
- Added `config.discord.enabled` flag to gracefully handle missing Discord credentials
- Updated `server.js` to conditionally initialize Discord client based on configuration
- Added null checks throughout the codebase for Discord client references

**Deployment Configuration**
- Configured for VM deployment target to maintain stateful connections
- Web server binds to `0.0.0.0:5000` for Replit proxy compatibility
- Authentication sessions and WebSocket connections persist across requests
- Minecraft bot authentication requires manual setup on first run

**Development Mode**
- Application can run in web-only mode without Discord credentials
- Chat monitoring interface accessible at `/login` (password: "Agent")
- Minecraft authentication prompts appear in server logs and require manual completion
- Environment warnings for missing Discord configuration are informational only

**Required Environment Variables for Full Functionality**
- `DISCORD_BOT_TOKEN`: Discord bot token for integration
- `DISCORD_LOGS_CHANNEL_ID`: Channel ID for chat logs
- `DISCORD_LOGIN_CHANNEL_ID`: Channel ID for authentication messages  
- `DISCORD_STATUS_CHANNEL_ID`: Channel ID for bot status updates
- `DISCORD_PLAYER_LIST_CHANNEL_ID`: Channel ID for player list updates
- Alternative: `DISCORD_WEBHOOK_URL` for webhook-only messaging