class MinecraftChatViewer {
    constructor() {
        this.socket = null;
        this.chatWindow = document.getElementById('chatWindow');
        this.statusIndicator = document.getElementById('statusIndicator');
        this.statusText = document.getElementById('statusText');
        this.connectionDot = document.getElementById('connectionDot');
        this.connectionText = document.getElementById('connectionText');
        
        this.init();
    }

    init() {
        this.connectSocket();
        this.loadRecentMessages();
    }

    connectSocket() {
        this.socket = io();
        
        this.socket.on('connect', () => {
            console.log('Connected to chat server');
            this.updateConnectionStatus(true);
        });
        
        this.socket.on('disconnect', () => {
            console.log('Disconnected from chat server');
            this.updateConnectionStatus(false);
        });
        
        this.socket.on('messageHistory', (messages) => {
            this.clearChat();
            messages.forEach(message => this.addMessage(message));
        });
        
        this.socket.on('newMessage', (message) => {
            this.addMessage(message);
        });
    }

    async loadRecentMessages() {
        try {
            const response = await fetch('/api/messages');
            const messages = await response.json();
            
            this.clearChat();
            messages.forEach(message => this.addMessage(message));
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
    }

    clearChat() {
        this.chatWindow.innerHTML = '';
    }

    addMessage(message) {
        const messageElement = document.createElement('div');
        messageElement.className = `message ${message.isServer ? 'server-message' : 'player-message'}`;
        
        const timestamp = new Date(message.timestamp).toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        
        // Format message text, handling batched messages with line breaks
        let formattedMessage = this.escapeHtml(message.message);
        if (message.isBatched) {
            // Convert newlines to <br> tags for batched server messages
            formattedMessage = formattedMessage.replace(/\n/g, '<br>');
        }
        
        messageElement.innerHTML = `
            <div class="message-content">
                <span class="timestamp">[${timestamp}]</span>
                <span class="player-name ${message.isServer ? 'server' : 'player'}">${message.player}</span>
                <span class="message-text">${formattedMessage}</span>
            </div>
        `;
        
        this.chatWindow.appendChild(messageElement);
        
        // Auto-scroll to bottom
        this.chatWindow.scrollTop = this.chatWindow.scrollHeight;
        
        // Remove old messages if too many
        const messages = this.chatWindow.querySelectorAll('.message');
        if (messages.length > 100) {
            messages[0].remove();
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    updateConnectionStatus(connected) {
        if (connected) {
            this.connectionDot.className = 'connection-dot connected';
            this.connectionText.textContent = 'Connected';
            this.statusIndicator.className = 'status-indicator online';
            this.statusText.textContent = 'Online';
        } else {
            this.connectionDot.className = 'connection-dot disconnected';
            this.connectionText.textContent = 'Disconnected';
            this.statusIndicator.className = 'status-indicator offline';
            this.statusText.textContent = 'Offline';
        }
    }
}

// Initialize the chat viewer when page loads
document.addEventListener('DOMContentLoaded', () => {
    new MinecraftChatViewer();
});