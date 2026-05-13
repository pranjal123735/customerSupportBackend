/**
 * PRODUCTION-GRADE Conversation Memory Service
 * 
 * Features:
 * - LLM-powered intelligent summarization (not regex!)
 * - MongoDB persistence (survives restarts)
 * - Extracts ANYTHING useful for future conversations
 * - Uses Gemini's native chat history
 * - Handles long conversations (100+ turns)
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MongoClient } = require('mongodb');

class AdvancedConversationMemory {
  constructor() {
    this.mongoClient = null;
    this.db = null;
    this.genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    this.model = this.genai.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    // Configuration
    this.MAX_MESSAGES_BEFORE_SUMMARY = 15;  // Summarize every 15 messages
    this.KEEP_RECENT_MESSAGES = 8;  // Keep last 8 messages in full
    
    this.initialize();
  }
  
  async initialize() {
    try {
      this.mongoClient = new MongoClient(process.env.MONGODB_URI);
      await this.mongoClient.connect();
      this.db = this.mongoClient.db('ecommerce_rag');
      
      // Create indexes for fast lookups
      await this.db.collection('conversations').createIndex({ userId: 1 });
      await this.db.collection('conversations').createIndex({ lastUpdated: 1 });
      
      console.log('✅ Advanced Conversation Memory initialized with MongoDB');
    } catch (error) {
      console.error('❌ Failed to initialize conversation memory:', error.message);
    }
  }
  
  /**
   * Get conversation from MongoDB
   */
  async getConversation(userId) {
    try {
      let conversation = await this.db.collection('conversations').findOne({ userId });
      
      if (!conversation) {
        conversation = {
          userId,
          messages: [],
          summaries: [],  // Array of summaries over time
          intelligentContext: {
            // LLM extracts these automatically
            orderIds: [],
            customerInfo: {},
            promisesMade: [],
            unresolvedIssues: [],
            customerSentiment: 'neutral',
            importantFacts: []
          },
          createdAt: new Date(),
          lastUpdated: new Date()
        };
        
        await this.db.collection('conversations').insertOne(conversation);
      }
      
      return conversation;
    } catch (error) {
      console.error('❌ Error getting conversation:', error);
      // Fallback to in-memory
      return {
        userId,
        messages: [],
        summaries: [],
        intelligentContext: {
          orderIds: [],
          customerInfo: {},
          promisesMade: [],
          unresolvedIssues: [],
          customerSentiment: 'neutral',
          importantFacts: []
        },
        createdAt: new Date(),
        lastUpdated: new Date()
      };
    }
  }
  
  /**
   * Add message and intelligently update context
   */
  async addMessage(userId, role, content) {
    try {
      const conversation = await this.getConversation(userId);
      
      // Add message
      conversation.messages.push({
        role,
        content,
        timestamp: new Date()
      });
      
      conversation.lastUpdated = new Date();
      
      // Check if we need to summarize
      if (conversation.messages.length >= this.MAX_MESSAGES_BEFORE_SUMMARY) {
        console.log(`📝 Conversation reached ${conversation.messages.length} messages, creating intelligent summary...`);
        await this.createIntelligentSummary(conversation);
      }
      
      // Save to MongoDB
      await this.db.collection('conversations').updateOne(
        { userId },
        { $set: conversation },
        { upsert: true }
      );
      
      console.log(`💾 Saved message to MongoDB. Total: ${conversation.messages.length} messages`);
      
    } catch (error) {
      console.error('❌ Error adding message:', error);
    }
  }
  
  /**
   * Create intelligent summary using LLM
   * Extracts EVERYTHING useful for future conversations
   */
  async createIntelligentSummary(conversation) {
    try {
      // Get messages to summarize (all except last KEEP_RECENT_MESSAGES)
      const messagesToSummarize = conversation.messages.slice(0, -this.KEEP_RECENT_MESSAGES);
      
      if (messagesToSummarize.length === 0) return;
      
      // Build conversation text
      const conversationText = messagesToSummarize
        .map(m => `${m.role === 'user' ? 'Customer' : 'Agent'}: ${m.content}`)
        .join('\n');
      
      // Use LLM to extract intelligent context
      const prompt = `Analyze this customer support conversation and extract ALL information that would be useful for future conversations.

CONVERSATION:
${conversationText}

Extract and return ONLY a JSON object with this structure:
{
  "orderIds": [list of all order numbers mentioned],
  "customerInfo": {
    "name": "if mentioned",
    "email": "if mentioned",
    "phone": "if mentioned",
    "preferredLanguage": "english/hindi/hinglish"
  },
  "promisesMade": [
    "Agent promised refund in 5-7 days",
    "Agent said will expedite shipping"
  ],
  "unresolvedIssues": [
    "Customer wants to know when order 1001 will arrive",
    "Refund not yet processed"
  ],
  "customerSentiment": "happy/neutral/frustrated/angry",
  "importantFacts": [
    "Customer has been waiting 2 weeks",
    "This is a repeat issue",
    "Customer is a VIP",
    "Order was damaged on arrival"
  ],
  "actionsTaken": [
    "Cancelled order 1001",
    "Initiated refund for order 1002"
  ],
  "summary": "Brief 2-3 sentence summary of what happened"
}

CRITICAL: Extract EVERYTHING that might be useful later. Include:
- All order numbers
- Any promises made by agent
- Unresolved issues
- Customer's emotional state
- Important context (VIP, repeat customer, etc.)
- Actions already taken

Return ONLY valid JSON:`;

      console.log('🤖 Using Gemini to create intelligent summary...');
      const result = await this.model.generateContent(prompt);
      const responseText = result.response.text();
      
      // Extract JSON
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const intelligentContext = JSON.parse(jsonMatch[0]);
        
        // Merge with existing context
        conversation.intelligentContext = {
          orderIds: [...new Set([...conversation.intelligentContext.orderIds, ...intelligentContext.orderIds])],
          customerInfo: { ...conversation.intelligentContext.customerInfo, ...intelligentContext.customerInfo },
          promisesMade: [...conversation.intelligentContext.promisesMade, ...intelligentContext.promisesMade],
          unresolvedIssues: intelligentContext.unresolvedIssues,  // Replace with latest
          customerSentiment: intelligentContext.customerSentiment,
          importantFacts: [...conversation.intelligentContext.importantFacts, ...intelligentContext.importantFacts]
        };
        
        // Add summary to history
        conversation.summaries.push({
          summary: intelligentContext.summary,
          actionsTaken: intelligentContext.actionsTaken,
          messageCount: messagesToSummarize.length,
          timestamp: new Date()
        });
        
        // Keep only recent messages
        conversation.messages = conversation.messages.slice(-this.KEEP_RECENT_MESSAGES);
        
        console.log('✅ Intelligent summary created:');
        console.log(`   - Orders: ${intelligentContext.orderIds.join(', ')}`);
        console.log(`   - Promises: ${intelligentContext.promisesMade.length}`);
        console.log(`   - Unresolved: ${intelligentContext.unresolvedIssues.length}`);
        console.log(`   - Sentiment: ${intelligentContext.customerSentiment}`);
        console.log(`   - Facts: ${intelligentContext.importantFacts.length}`);
      }
      
    } catch (error) {
      console.error('❌ Error creating intelligent summary:', error);
    }
  }
  
  /**
   * Get optimized context for AI (Gemini native format)
   */
  async getGeminiHistory(userId) {
    try {
      const conversation = await this.getConversation(userId);
      
      // Build Gemini-compatible history
      const history = [];
      
      // Add summaries as system context
      if (conversation.summaries.length > 0) {
        const allSummaries = conversation.summaries
          .map(s => `[Previous conversation: ${s.summary}. Actions taken: ${s.actionsTaken.join(', ')}]`)
          .join('\n');
        
        history.push({
          role: 'user',
          parts: [{ text: '[CONVERSATION HISTORY]\n' + allSummaries }]
        });
        
        history.push({
          role: 'model',
          parts: [{ text: 'I understand the conversation history and will use this context.' }]
        });
      }
      
      // Add intelligent context
      if (conversation.intelligentContext.orderIds.length > 0 || 
          conversation.intelligentContext.promisesMade.length > 0) {
        
        let contextText = '[IMPORTANT CONTEXT]\n';
        
        if (conversation.intelligentContext.orderIds.length > 0) {
          contextText += `Orders discussed: ${conversation.intelligentContext.orderIds.join(', ')}\n`;
        }
        
        if (conversation.intelligentContext.promisesMade.length > 0) {
          contextText += `Promises made:\n${conversation.intelligentContext.promisesMade.map(p => `- ${p}`).join('\n')}\n`;
        }
        
        if (conversation.intelligentContext.unresolvedIssues.length > 0) {
          contextText += `Unresolved issues:\n${conversation.intelligentContext.unresolvedIssues.map(i => `- ${i}`).join('\n')}\n`;
        }
        
        if (conversation.intelligentContext.importantFacts.length > 0) {
          contextText += `Important facts:\n${conversation.intelligentContext.importantFacts.map(f => `- ${f}`).join('\n')}\n`;
        }
        
        contextText += `Customer sentiment: ${conversation.intelligentContext.customerSentiment}`;
        
        history.push({
          role: 'user',
          parts: [{ text: contextText }]
        });
        
        history.push({
          role: 'model',
          parts: [{ text: 'I will use this context to provide better support.' }]
        });
      }
      
      // Add recent messages
      conversation.messages.forEach(msg => {
        history.push({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: msg.content }]
        });
      });
      
      return history;
      
    } catch (error) {
      console.error('❌ Error getting Gemini history:', error);
      return [];
    }
  }
  
  /**
   * Get conversation for backward compatibility
   */
  async getHistory(userId) {
    try {
      const conversation = await this.getConversation(userId);
      return conversation.messages.map(m => ({
        role: m.role,
        content: m.content
      }));
    } catch (error) {
      console.error('❌ Error getting history:', error);
      return [];
    }
  }
  
  /**
   * Get conversation stats
   */
  async getStats(userId) {
    try {
      const conversation = await this.getConversation(userId);
      return {
        messageCount: conversation.messages.length,
        summaryCount: conversation.summaries.length,
        totalMessages: conversation.messages.length + conversation.summaries.reduce((sum, s) => sum + s.messageCount, 0),
        orderIds: conversation.intelligentContext.orderIds,
        currentSentiment: conversation.intelligentContext.customerSentiment,
        unresolvedIssues: conversation.intelligentContext.unresolvedIssues.length,
        promisesMade: conversation.intelligentContext.promisesMade.length,
        lastUpdated: conversation.lastUpdated
      };
    } catch (error) {
      console.error('❌ Error getting stats:', error);
      return {
        messageCount: 0,
        summaryCount: 0,
        totalMessages: 0,
        orderIds: [],
        currentSentiment: 'neutral',
        unresolvedIssues: 0,
        promisesMade: 0
      };
    }
  }
  
  /**
   * Get intelligent context (for debugging/display)
   */
  async getIntelligentContext(userId) {
    try {
      const conversation = await this.getConversation(userId);
      return conversation.intelligentContext;
    } catch (error) {
      console.error('❌ Error getting intelligent context:', error);
      return null;
    }
  }
  
  /**
   * Clear conversation
   */
  async clearConversation(userId) {
    try {
      await this.db.collection('conversations').deleteOne({ userId });
      console.log(`🗑️ Cleared conversation for ${userId}`);
    } catch (error) {
      console.error('❌ Error clearing conversation:', error);
    }
  }
  
  /**
   * Clean up old conversations (run periodically)
   */
  async cleanupOldConversations(maxAgeHours = 24) {
    try {
      const cutoffDate = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
      
      const result = await this.db.collection('conversations').deleteMany({
        lastUpdated: { $lt: cutoffDate }
      });
      
      if (result.deletedCount > 0) {
        console.log(`🧹 Cleaned up ${result.deletedCount} old conversations`);
      }
      
      return result.deletedCount;
    } catch (error) {
      console.error('❌ Error cleaning up conversations:', error);
      return 0;
    }
  }
}

// Export singleton
module.exports = new AdvancedConversationMemory();
