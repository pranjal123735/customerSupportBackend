/**
 * Conversation Memory Service
 * 
 * Handles intelligent conversation history management:
 * - Stores full conversation history
 * - Summarizes long conversations
 * - Extracts key context (order IDs, topics, etc.)
 * - Provides optimized context for AI
 */

class ConversationMemoryService {
  constructor() {
    // Store full conversation history per user
    // Key: userId, Value: { messages: [], summary: '', metadata: {} }
    this.conversations = new Map();
    
    // Configuration
    this.MAX_MESSAGES = 20;  // Store up to 20 messages
    this.SUMMARIZE_AFTER = 8;  // Summarize when > 8 messages
    this.CONTEXT_WINDOW = 5;  // Show last 5 messages to AI
  }
  
  /**
   * Get conversation for a user
   */
  getConversation(userId) {
    if (!this.conversations.has(userId)) {
      this.conversations.set(userId, {
        messages: [],
        summary: '',
        metadata: {
          currentOrderId: null,
          previousOrderIds: [],
          topics: [],
          lastAction: null,
          createdAt: new Date(),
          lastUpdatedAt: new Date()
        }
      });
    }
    return this.conversations.get(userId);
  }
  
  /**
   * Add message to conversation
   */
  addMessage(userId, role, content) {
    const conversation = this.getConversation(userId);
    
    conversation.messages.push({
      role,
      content,
      timestamp: new Date()
    });
    
    conversation.metadata.lastUpdatedAt = new Date();
    
    // Extract metadata from message
    this.extractMetadata(conversation, content);
    
    // Keep only last MAX_MESSAGES
    if (conversation.messages.length > this.MAX_MESSAGES) {
      conversation.messages = conversation.messages.slice(-this.MAX_MESSAGES);
    }
    
    console.log(`📝 Added message to conversation. Total: ${conversation.messages.length} messages`);
  }
  
  /**
   * Extract metadata from message (order IDs, topics, etc.)
   * IMPROVED: Better extraction with context awareness
   */
  extractMetadata(conversation, content) {
    // Extract order IDs - only look for explicit "order" mentions
    const orderMatches = content.match(/order\s*#?(\d{3,4})\b/gi);
    if (orderMatches) {
      orderMatches.forEach(match => {
        const idMatch = match.match(/(\d{3,4})/);
        if (idMatch) {
          const id = parseInt(idMatch[1]);
          if (id >= 1000 && id <= 9999) {  // Valid order ID range
            // Update current order
            if (conversation.metadata.currentOrderId !== id) {
              // Move current to previous
              if (conversation.metadata.currentOrderId) {
                if (!conversation.metadata.previousOrderIds.includes(conversation.metadata.currentOrderId)) {
                  conversation.metadata.previousOrderIds.push(conversation.metadata.currentOrderId);
                }
              }
              conversation.metadata.currentOrderId = id;
              console.log(`🔖 Updated current order: ${id}`);
            }
          }
        }
      });
    }
    
    // IMPROVED: Better pronoun handling
    // If message has pronouns but no order ID, keep current order
    const hasPronouns = /\b(it|this|that|the order|my order)\b/i.test(content);
    if (hasPronouns && !orderMatches && conversation.metadata.currentOrderId) {
      console.log(`🔗 Pronoun detected, maintaining current order: ${conversation.metadata.currentOrderId}`);
    }
    
    // IMPROVED: Detect references to "first", "second", "previous"
    const contentLower = content.toLowerCase();
    if (contentLower.includes('first') || contentLower.includes('previous')) {
      // User might be referring to a previous order
      if (conversation.metadata.previousOrderIds.length > 0) {
        const previousOrder = conversation.metadata.previousOrderIds[conversation.metadata.previousOrderIds.length - 1];
        console.log(`🔙 Reference to previous order detected: ${previousOrder}`);
        // Don't change current order, but log for context
      }
    }
    
    // Extract topics/actions with priority
    if (contentLower.includes('cancel')) {
      conversation.metadata.lastAction = 'cancel';
    } else if (contentLower.includes('return')) {
      conversation.metadata.lastAction = 'return';
    } else if (contentLower.includes('refund')) {
      conversation.metadata.lastAction = 'refund';
    } else if (contentLower.includes('track')) {
      conversation.metadata.lastAction = 'track';
    } else if (contentLower.includes('status')) {
      conversation.metadata.lastAction = 'status';
    } else if (contentLower.includes('delivery') || contentLower.includes('arrive')) {
      conversation.metadata.lastAction = 'delivery';
    }
  }
  
  /**
   * Get optimized context for AI
   * Returns: { messages, summary, metadata }
   * IMPROVED: Better context with all order mentions
   */
  getOptimizedContext(userId) {
    const conversation = this.getConversation(userId);
    const messageCount = conversation.messages.length;
    
    if (messageCount === 0) {
      return {
        messages: [],
        summary: '',
        metadata: conversation.metadata,
        allOrderMentions: []
      };
    }
    
    // Extract ALL order mentions from entire conversation
    const allOrderMentions = this.extractAllOrderMentions(conversation.messages);
    
    // For short conversations (≤ 8 messages), return all messages
    if (messageCount <= this.SUMMARIZE_AFTER) {
      return {
        messages: conversation.messages,
        summary: '',
        metadata: conversation.metadata,
        allOrderMentions
      };
    }
    
    // For long conversations (> 8 messages), return summary + recent messages
    const recentMessages = conversation.messages.slice(-this.CONTEXT_WINDOW);
    const olderMessages = conversation.messages.slice(0, -this.CONTEXT_WINDOW);
    
    // Generate summary of older messages
    const summary = this.generateAdvancedSummary(olderMessages, conversation.metadata, allOrderMentions);
    
    return {
      messages: recentMessages,
      summary,
      metadata: conversation.metadata,
      allOrderMentions
    };
  }
  
  /**
   * Extract ALL order mentions from conversation
   * Returns: [{ orderId, turnNumber, context }]
   */
  extractAllOrderMentions(messages) {
    const mentions = [];
    
    messages.forEach((msg, index) => {
      if (msg.role === 'user') {
        const orderMatches = msg.content.match(/order\s*#?(\d{3,4})\b/gi);
        if (orderMatches) {
          orderMatches.forEach(match => {
            const idMatch = match.match(/(\d{3,4})/);
            if (idMatch) {
              const orderId = parseInt(idMatch[1]);
              if (orderId >= 1000 && orderId <= 9999) {
                mentions.push({
                  orderId,
                  turnNumber: Math.floor(index / 2) + 1,
                  context: msg.content.substring(0, 100)
                });
              }
            }
          });
        }
      }
    });
    
    return mentions;
  }
  
  /**
   * Generate advanced summary with order timeline
   */
  generateAdvancedSummary(messages, metadata, allOrderMentions) {
    const parts = [];
    
    // Add order timeline
    if (allOrderMentions.length > 0) {
      const orderTimeline = {};
      allOrderMentions.forEach(mention => {
        if (!orderTimeline[mention.orderId]) {
          orderTimeline[mention.orderId] = [];
        }
        orderTimeline[mention.orderId].push(mention.turnNumber);
      });
      
      const timelineStr = Object.entries(orderTimeline)
        .map(([orderId, turns]) => `Order #${orderId} (mentioned in turn${turns.length > 1 ? 's' : ''} ${turns.join(', ')})`)
        .join('; ');
      
      parts.push(`Order Timeline: ${timelineStr}`);
    }
    
    // Add current context
    if (metadata.currentOrderId) {
      parts.push(`Currently discussing: Order #${metadata.currentOrderId}`);
    }
    
    // Add action context
    if (metadata.lastAction) {
      parts.push(`Last action: ${metadata.lastAction}`);
    }
    
    // Count message types
    const userMessages = messages.filter(m => m.role === 'user').length;
    parts.push(`Earlier: ${userMessages} customer messages`);
    
    return parts.join('. ');
  }
  
  /**
   * Format context for AI prompt
   */
  formatContextForAI(userId) {
    const context = this.getOptimizedContext(userId);
    
    let formatted = '';
    
    // Add summary if exists
    if (context.summary) {
      formatted += `\n[CONVERSATION SUMMARY]\n${context.summary}\n`;
    }
    
    // Add metadata
    if (context.metadata.currentOrderId) {
      formatted += `\n[CURRENT CONTEXT]\n`;
      formatted += `- Current Order: #${context.metadata.currentOrderId}\n`;
      if (context.metadata.previousOrderIds.length > 0) {
        formatted += `- Previous Orders: ${context.metadata.previousOrderIds.join(', ')}\n`;
      }
      if (context.metadata.lastAction) {
        formatted += `- Last Action: ${context.metadata.lastAction}\n`;
      }
    }
    
    // Add recent messages
    if (context.messages.length > 0) {
      formatted += `\n[RECENT CONVERSATION]\n`;
      context.messages.forEach(msg => {
        const role = msg.role === 'user' ? 'Customer' : 'Agent';
        formatted += `${role}: ${msg.content}\n`;
      });
    }
    
    return formatted;
  }
  
  /**
   * Get conversation history in simple format (for backward compatibility)
   */
  getHistory(userId) {
    const conversation = this.getConversation(userId);
    return conversation.messages.map(m => ({
      role: m.role,
      content: m.content
    }));
  }
  
  /**
   * Clear conversation for a user
   */
  clearConversation(userId) {
    this.conversations.delete(userId);
    console.log(`🗑️ Cleared conversation for user ${userId}`);
  }
  
  /**
   * Get conversation statistics
   */
  getStats(userId) {
    const conversation = this.getConversation(userId);
    return {
      messageCount: conversation.messages.length,
      currentOrderId: conversation.metadata.currentOrderId,
      previousOrderIds: conversation.metadata.previousOrderIds,
      lastAction: conversation.metadata.lastAction,
      duration: new Date() - conversation.metadata.createdAt,
      lastUpdated: conversation.metadata.lastUpdatedAt
    };
  }
  
  /**
   * Clean up old conversations (call periodically)
   */
  cleanupOldConversations(maxAgeHours = 24) {
    const now = new Date();
    const maxAge = maxAgeHours * 60 * 60 * 1000;
    
    let cleaned = 0;
    for (const [userId, conversation] of this.conversations.entries()) {
      const age = now - conversation.metadata.lastUpdatedAt;
      if (age > maxAge) {
        this.conversations.delete(userId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} old conversations`);
    }
    
    return cleaned;
  }
}

// Export singleton instance
module.exports = new ConversationMemoryService();
