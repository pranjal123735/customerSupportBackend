const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MongoClient } = require('mongodb');
const dns = require('dns');

dns.setServers(['8.8.8.8', '8.8.4.4']);

class CustomerSupportAgent {
  constructor() {
    console.log('🤖 Customer Support Agent initializing...');
    
    this.mongoClient = null;
    this.db = null;
    
    // Gemini AI
    this.genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    this.model = this.genai.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    // Active tickets per user
    this.activeTickets = new Map();
    
    // Semantic cache for repeated questions
    this.semanticCache = [];
    
    // Agent personas for different contexts
    this.PERSONAS = {
      standard: {
        name: 'Aria',
        tone: 'friendly and professional',
        language: 'clear English',
        style: 'concise and helpful'
      },
      hindi: {
        name: 'Priya',
        tone: 'warm and helpful in Hinglish',
        language: 'natural mix of Hindi and English (Hinglish)',
        style: 'conversational and friendly'
      },
      vip: {
        name: 'Rahul',
        tone: 'extremely attentive, concierge-level service',
        language: 'formal and premium English',
        style: 'detailed and personalized'
      },
      angry_customer: {
        name: 'Aria',
        tone: 'deeply empathetic, de-escalating, solution-first',
        language: 'calm and reassuring',
        style: 'apologetic and action-oriented'
      }
    };
    
    // Escalation thresholds
    this.ESCALATION_THRESHOLDS = {
      REFUND_AMOUNT: 500,
      MAX_ATTEMPTS: 3,
      SENTIMENT_THRESHOLD: -0.5,
      CONFIDENCE_THRESHOLD: 0.6  // Escalate if confidence below 60%
    };
    
    this.initialize();
  }
  
  async initialize() {
    try {
      const options = {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        family: 4
      };
      
      this.mongoClient = new MongoClient(process.env.MONGODB_URI, options);
      await this.mongoClient.connect();
      this.db = this.mongoClient.db('ecommerce_rag');
      
      // Load active tickets from MongoDB on startup
      await this.loadActiveTickets();
      
      this.initialized = true; // Mark as initialized
      console.log('✅ Customer Support Agent initialized');
    } catch (error) {
      console.error('❌ Agent initialization failed:', error.message);
      this.initialized = false;
      throw error;
    }
  }
  
  async waitForInitialization() {
    // Wait for initialization to complete
    while (!this.initialized && !this.db) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  async loadActiveTickets() {
    try {
      const openTickets = await this.db.collection('support_tickets')
        .find({ status: 'open' })
        .toArray();
      
      openTickets.forEach(ticket => {
        this.activeTickets.set(ticket.userId, ticket);
      });
      
      console.log(`✅ Loaded ${openTickets.length} active tickets from MongoDB`);
    } catch (error) {
      console.error('⚠️ Failed to load active tickets:', error.message);
      // Don't throw - allow agent to start even if ticket loading fails
    }
  }
  
  // ============================================
  // MAIN AGENT LOOP
  // ============================================
  
  // ============================================
  // MAIN ENTRY POINT - SIMPLIFIED TOOL-BASED ARCHITECTURE
  // ============================================
  
  async handleCustomerMessage(userMessage, userId, conversationHistory = []) {
    console.log('\n🎯 Customer Support Agent Processing...');
    console.log(`User: ${userId}`);
    console.log(`Message: ${userMessage}`);
    
    // Wait for initialization to complete
    await this.waitForInitialization();
    
    try {
      // Step 1: Get or create ticket
      let ticket = this.getActiveTicket(userId);
      if (!ticket) {
        ticket = await this.createTicket(userId, userMessage);
      }
      ticket.lastMessage = userMessage;
      
      // Step 2: Extract order ID from message or conversation history
      let extractedOrderId = null;
      const orderMatch = userMessage.match(/\b(\d{3,4})\b/);
      if (orderMatch) {
        extractedOrderId = parseInt(orderMatch[1]);
      } else if (conversationHistory.length > 0) {
        // Look for order ID in recent conversation
        for (let i = conversationHistory.length - 1; i >= 0; i--) {
          const msg = conversationHistory[i];
          const match = msg.content.match(/order\s*#?(\d{3,4})|#(\d{3,4})/i);
          if (match) {
            extractedOrderId = parseInt(match[1] || match[2]);
            console.log(`🔧 Context extraction: Found order_id ${extractedOrderId} from conversation history`);
            break;
          }
        }
      }
      
      // Step 3: Build conversation context
      let conversationContext = '';
      if (conversationHistory.length > 0) {
        conversationContext = '\n\nRecent conversation:\n' + 
          conversationHistory.slice(-5).map(msg => `${msg.role}: ${msg.content}`).join('\n');
      }
      
      // Step 4: Detect language and sentiment in parallel (FAST - no LLM)
      const [detectedLanguage, sentiment] = await Promise.all([
        this.detectLanguage(userMessage),
        this.detectSentimentFast(userMessage)
      ]);
      
      // Step 4.5: Check for immediate escalation (angry customer or wants human)
      if (sentiment.wantsHuman || (sentiment.isAngry && ticket.attempts >= 1)) {
        console.log('🚨 Escalating: Customer wants human or is angry after attempt');
        return await this.escalateToHuman(ticket, sentiment.wantsHuman ? 'Customer requested human agent' : 'Customer is frustrated');
      }
      
      // Step 5: AI decides what tool to use (ONE LLM CALL)
      const toolDecisionPrompt = `You are a customer support agent. Analyze this message and decide what action to take.

CRITICAL RULE — CONTEXT RESOLUTION:
Before calling ANY tool, check the conversation history and resolve all references:
- "it", "that", "this one", "the order", "my order" → look at last mentioned order ID in conversation
- "when was it cancelled" → use the last order ID discussed
- "track this one" → use the last order ID discussed  
- "what about it" → use the last order ID discussed
- NEVER ask the customer for an order number if it was already mentioned in this conversation
- If conversation history shows order #1001 was discussed, then "it" = order #1001

If you already have the order ID from conversation history, use it directly in the orderId field.
Only set orderId to null if NO order has EVER been mentioned in this conversation.

CONTEXT:
${extractedOrderId ? `- Order #${extractedOrderId} was mentioned in this conversation (USE THIS!)` : ''}
${conversationContext}

Customer message: "${userMessage}"

Return ONLY a JSON object:
{
  "tool": "<searchKnowledgeBase|getOrderDetails|cancelOrder|processRefund|directResponse>",
  "orderId": <number or null - USE ORDER FROM CONTEXT IF AVAILABLE>,
  "query": "<search query if using searchKnowledgeBase>"
}

RULES:
- If asking about policies, returns, refunds, delivery → tool: "searchKnowledgeBase"
- If asking about order status/tracking → tool: "getOrderDetails"
- If wants to cancel order → tool: "cancelOrder"
- If wants refund → tool: "processRefund"
- If general greeting or simple question → tool: "directResponse"
- If customer uses pronouns ("it", "this", "that"), resolve from conversation history FIRST
- If customer is answering a question (like just "1"), infer from conversation history

CRITICAL: If extractedOrderId is provided above, YOU MUST use it in the orderId field!

Return ONLY valid JSON:`;

      console.log('🤖 AI deciding which tool to use...');
      const toolDecision = await this.model.generateContent(toolDecisionPrompt);
      const toolDecisionText = toolDecision.response.text();
      const jsonMatch = toolDecisionText.match(/\{[\s\S]*\}/);
      
      if (!jsonMatch) {
        throw new Error('Failed to parse tool decision');
      }
      
      const decision = JSON.parse(jsonMatch[0]);
      console.log(`🔧 AI decided to use tool: ${decision.tool}`);
      
      // Step 6: Execute the tool
      let toolResult = null;
      if (decision.tool === 'searchKnowledgeBase') {
        toolResult = await this.toolSearchKnowledgeBase(decision.query || userMessage);
      } else if (decision.tool === 'getOrderDetails') {
        const orderId = decision.orderId || extractedOrderId;
        if (orderId) {
          toolResult = await this.toolGetOrderDetails(orderId);
        }
      } else if (decision.tool === 'cancelOrder') {
        const orderId = decision.orderId || extractedOrderId;
        if (orderId) {
          toolResult = await this.toolCancelOrder(orderId);
        }
      } else if (decision.tool === 'processRefund') {
        const orderId = decision.orderId || extractedOrderId;
        if (orderId) {
          toolResult = await this.toolProcessRefund(orderId, "Customer request");
        }
      }
      
      // Step 7: Generate final response with tool results
      let finalPrompt;
      if (toolResult) {
        finalPrompt = `You are a helpful customer support agent for an e-commerce company.

Customer message: "${userMessage}"
${conversationContext}

Tool used: ${decision.tool}
Tool result: ${JSON.stringify(toolResult)}

Generate a natural, helpful response based on the tool result.

IMPORTANT LANGUAGE RULES:
- If customer speaks in English → Respond in English
- If customer speaks in Hindi/Hinglish → Respond in Hindi/Hinglish (mix of Hindi and English)
- Match the customer's language style exactly

CRITICAL SCOPE RULES:
- You can ONLY help with: orders, tracking, returns, refunds, cancellations, delivery, products, policies, payments
- If customer asks ANYTHING outside e-commerce (coding, math, general knowledge, etc.):
  * DO NOT answer their question
  * DO NOT provide code, calculations, or general information
  * Politely say: "I can help you with questions related to e-commerce, such as orders, tracking, returns, refunds, cancellations, and our policies. How can I assist you with your shopping today?"
  * Keep it brief and redirect to e-commerce topics

Response:`;
      } else {
        finalPrompt = `You are a helpful customer support agent for an e-commerce company.

Customer message: "${userMessage}"
${conversationContext}

Generate a natural, helpful response.

IMPORTANT LANGUAGE RULES:
- If customer speaks in English → Respond in English
- If customer speaks in Hindi/Hinglish → Respond in Hindi/Hinglish (mix of Hindi and English)
- Match the customer's language style exactly

CRITICAL SCOPE RULES:
- You can ONLY help with: orders, tracking, returns, refunds, cancellations, delivery, products, policies, payments
- If customer asks ANYTHING outside e-commerce (coding, math, general knowledge, etc.):
  * DO NOT answer their question
  * DO NOT provide code, calculations, or general information
  * Politely say: "I can help you with questions related to e-commerce, such as orders, tracking, returns, refunds, cancellations, and our policies. How can I assist you with your shopping today?"
  * Keep it brief and redirect to e-commerce topics

Response:`;
      }
      
      console.log('🤖 Generating final response...');
      const finalResult = await this.model.generateContent(finalPrompt);
      const finalResponse = finalResult.response.text();
      
      // Step 8: Validate response (fast validation with actual context)
      const validation = await this.validateResponse(finalResponse, toolResult || {}, userMessage);
      if (!validation.safe && (validation.isToxic || validation.sharesPrivateData)) {
        console.warn('⚠️ Unsafe response detected:', validation.issues);
        return await this.escalateToHuman(ticket, `Response validation failed: ${validation.issues.join(', ')}`);
      }
      
      if (!validation.safe) {
        console.warn('⚠️ Response validation warning (not blocking):', validation.issues);
      }
      
      // Step 9: Update ticket
      ticket.attempts++;
      ticket.lastUpdate = new Date();
      ticket.sentiment = sentiment.isAngry ? 'angry' : 'neutral';
      ticket.history.push({
        userMessage,
        agentResponse: finalResponse,
        action: decision.tool,
        success: true,
        timestamp: new Date()
      });
      
      // Step 10: Save ticket (fire-and-forget)
      this.saveTicket(ticket).catch(err => {
        console.error('⚠️ Ticket save failed (non-critical):', err.message);
      });
      
      // Step 11: Update customer memory (fire-and-forget) - FIX: correct params
      this.updateCustomerMemory(userId, ticket, {
        sentiment: { emotion: sentiment.isAngry ? 'angry' : 'neutral' },
        problemType: decision.tool,
        detectedLanguage: detectedLanguage || 'english'
      }).catch(err => {
        console.error('⚠️ Customer memory update failed (non-critical):', err.message);
      });
      
      return {
        response: finalResponse,
        action: decision.tool,
        resolved: false,
        ticketId: ticket.id,
        escalated: false
      };
      
    } catch (error) {
      console.error('❌ Agent error:', error);
      return {
        response: "I apologize, but I'm having technical difficulties. Let me connect you with a human agent who can help you right away.",
        escalated: true,
        error: error.message
      };
    }
  }
  
  // ============================================
  // LEGACY ENTRY POINT (KEEP FOR COMPATIBILITY)
  // ============================================
  
  // ============================================
  // FAST SENTIMENT DETECTION (NO LLM - INSTANT)
  // ============================================
  
  detectSentimentFast(message) {
    const msgLower = message.toLowerCase();
    
    // Angry/frustrated words (English + Hindi/Hinglish)
    const angryWords = [
      'frustrated', 'angry', 'useless', 'terrible', 'worst', 'horrible',
      'pathetic', 'disgusting', 'ridiculous', 'unacceptable', 'disappointed',
      'bakwaas', 'bekar', 'ghatiya', 'kharab', 'pagal'
    ];
    
    // Wants human agent
    const humanWords = ['human', 'manager', 'supervisor', 'person', 'real person', 'speak to someone'];
    
    const isAngry = angryWords.some(w => msgLower.includes(w));
    const wantsHuman = humanWords.some(w => msgLower.includes(w));
    
    if (isAngry || wantsHuman) {
      console.log(`😠 Fast sentiment: ${isAngry ? 'ANGRY' : ''} ${wantsHuman ? 'WANTS_HUMAN' : ''}`);
    }
    
    return { isAngry, wantsHuman };
  }
  
  // ============================================
  // TOOL EXECUTION (LANGCHAIN TOOLS)
  // ============================================
  
  async toolSearchKnowledgeBase(query) {
    const ragService = require('./realRagService');
    await ragService.waitForInitialization();
    
    const queryEmbedding = await ragService.createEmbedding(query);
    const results = await ragService.vectorSearch(queryEmbedding, 5);
    
    console.log(`📚 Found ${results.length} knowledge base results`);
    
    if (results.length === 0) {
      return { 
        success: false,
        message: "No relevant information found in knowledge base"
      };
    }
    
    return {
      success: true,
      results: results.map(r => ({
        title: r.title,
        content: r.content,
        category: r.category
      }))
    };
  }
  
  async toolGetOrderDetails(orderId) {
    const order = await this.db.collection('orders').findOne({ id: parseInt(orderId) });
    
    if (!order) {
      return {
        success: false,
        message: `Order #${orderId} not found`
      };
    }
    
    console.log(`📦 Found order #${orderId}: ${order.status}`);
    
    return {
      success: true,
      order: {
        id: order.id,
        status: order.status,
        product_name: order.product_name,
        price: order.price,
        tracking_number: order.tracking_number,
        estimated_delivery: order.estimated_delivery,
        order_date: order.order_date,
        cancelled_at: order.cancelled_at || null,
        cancelled_by: order.cancelled_by || null
      }
    };
  }
  
  async toolCancelOrder(orderId) {
    const order = await this.db.collection('orders').findOne({ id: parseInt(orderId) });
    
    if (!order) {
      return {
        success: false,
        message: `Order #${orderId} not found`
      };
    }
    
    // Update order status
    await this.db.collection('orders').updateOne(
      { id: parseInt(orderId) },
      { 
        $set: { 
          status: 'cancelled',
          cancelled_at: new Date()
        } 
      }
    );
    
    console.log(`✅ Cancelled order #${orderId}`);
    
    return {
      success: true,
      message: `Order #${orderId} has been cancelled successfully`,
      order: {
        id: order.id,
        product_name: order.product_name,
        price: order.price
      }
    };
  }
  
  async toolProcessRefund(orderId, reason) {
    const order = await this.db.collection('orders').findOne({ id: parseInt(orderId) });
    
    if (!order) {
      return {
        success: false,
        message: `Order #${orderId} not found`
      };
    }
    
    // Get customer info
    const customer = await this.db.collection('customers').findOne({ 
      customer_id: order.customer_id 
    });
    
    if (!customer) {
      return {
        success: false,
        message: "Customer information not found. Please provide your email address."
      };
    }
    
    console.log(`💰 Processing refund for order #${orderId}`);
    
    return {
      success: true,
      message: `Refund initiated for order #${orderId}`,
      order: {
        id: order.id,
        product_name: order.product_name,
        refund_amount: order.price
      },
      customer: {
        email: customer.email
      }
    };
  }
  
  async toolGetCustomerOrders(email) {
    let customer;
    
    if (email) {
      customer = await this.db.collection('customers').findOne({ email });
    }
    
    if (!customer) {
      return {
        success: false,
        message: "Customer not found. Please provide your email address."
      };
    }
    
    const orders = await this.db.collection('orders')
      .find({ customer_id: customer.customer_id })
      .sort({ order_date: -1 })
      .limit(10)
      .toArray();
    
    console.log(`📋 Found ${orders.length} orders for customer`);
    
    return {
      success: true,
      orders: orders.map(o => ({
        id: o.id,
        status: o.status,
        product_name: o.product_name,
        price: o.price,
        order_date: o.order_date
      }))
    };
  }
  
  // ============================================
  // COMBINED MESSAGE ANALYSIS (ONE LLM CALL)
  // ============================================
  
  async analyzeMessage(userMessage, conversationHistory, ticket) {
    try {
      // Build conversation context
      let conversationContext = '';
      if (conversationHistory.length > 0) {
        conversationContext = '\n\nRecent conversation:\n' + 
          conversationHistory.slice(-3).map(msg => `${msg.role}: ${msg.content}`).join('\n');
      }
      
      // Build ticket context
      let ticketContext = '';
      if (ticket.history.length > 0) {
        ticketContext = '\n\nTicket history:\n' +
          ticket.history.slice(-2).map(h => `Customer: ${h.userMessage}\nAgent: ${h.agentResponse}`).join('\n');
      }
      
      const prompt = `Analyze this customer support message and return ONLY a JSON object:
{
  "sentiment": {
    "score": <number from -1 to 1>,
    "emotion": "<angry|frustrated|neutral|satisfied|happy>",
    "urgency": "<low|medium|high|critical>",
    "escalate": <boolean - true if explicitly asks for human>
  },
  "problemType": "<order_issue|return|refund|cancellation|tracking|product_question|billing|complaint|other>",
  "intent": "<cancel_order|initiate_return|request_refund|track_order|change_address|ask_question|complaint>",
  "allIntents": [
    {
      "intent": "<primary intent>",
      "priority": 1,
      "entities": { "order_id": <number or null>, ... }
    }
  ],
  "entities": {
    "order_id": <number or null>,
    "tracking_number": "<string or null>",
    "email": "<string or null>",
    "product_name": "<string or null>",
    "amount": <number or null>
  },
  "needsMoreInfo": <boolean>,
  "missingInfo": ["<list of missing required info>"]
}

CRITICAL RULES FOR needsMoreInfo:
- Set needsMoreInfo=false if order_id is present for action intents (track, cancel, refund, return)
- Set needsMoreInfo=false for ALL general questions (policy, delivery time, payment methods)
- Set needsMoreInfo=true ONLY when:
  * Customer wants to track/cancel/refund but NO order_id is mentioned
  * Customer wants to change address but NO new address is provided

Examples:
- "Track my order 1001" → needsMoreInfo=false (has order_id)
- "Cancel order 1002" → needsMoreInfo=false (has order_id)
- "I want a refund for order 1003" → needsMoreInfo=false (has order_id)
- "Track my order" → needsMoreInfo=true, missingInfo=["order_id"]
- "What is your return policy?" → needsMoreInfo=false (general question)

Handle multiple languages (English, Hindi, Hinglish).${ticketContext}${conversationContext}

Current message: "${userMessage}"

Return ONLY valid JSON:`;

      const result = await this.model.generateContent(prompt);
      const response = result.response.text();
      
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const analysis = JSON.parse(jsonMatch[0]);
        
        // CONTEXT-AWARE ENTITY EXTRACTION: Extract order_id from conversation history if not in current message
        if (!analysis.entities.order_id && conversationHistory.length > 0) {
          const actionIntents = ['track_order', 'cancel_order', 'request_refund', 'initiate_return'];
          
          // Check if user is answering a question about order number
          const lastAgentMessage = conversationHistory[conversationHistory.length - 1];
          if (lastAgentMessage && lastAgentMessage.role === 'assistant' && 
              lastAgentMessage.content.toLowerCase().includes('order number')) {
            // User is likely providing the order number
            const numberMatch = userMessage.match(/\d+/);
            if (numberMatch) {
              analysis.entities.order_id = parseInt(numberMatch[0]);
              // Infer intent from conversation context
              for (let i = conversationHistory.length - 2; i >= 0; i--) {
                const msg = conversationHistory[i];
                if (msg.role === 'user') {
                  const msgLower = msg.content.toLowerCase();
                  if (msgLower.includes('cancel')) {
                    analysis.intent = 'cancel_order';
                  } else if (msgLower.includes('track')) {
                    analysis.intent = 'track_order';
                  } else if (msgLower.includes('refund')) {
                    analysis.intent = 'request_refund';
                  } else if (msgLower.includes('return')) {
                    analysis.intent = 'initiate_return';
                  }
                  break;
                }
              }
              console.log(`🔧 Answer detection: User provided order_id ${analysis.entities.order_id} in response to question`);
            }
          }
          
          // If still no order_id, look for it in conversation history
          if (!analysis.entities.order_id && actionIntents.includes(analysis.intent)) {
            // Look for order_id in recent conversation
            for (let i = conversationHistory.length - 1; i >= 0; i--) {
              const msg = conversationHistory[i];
              // Look for patterns like "order #1", "order 1001", "#1234"
              const orderMatch = msg.content.match(/order\s*#?(\d+)|#(\d+)/i);
              if (orderMatch) {
                analysis.entities.order_id = parseInt(orderMatch[1] || orderMatch[2]);
                console.log(`🔧 Context extraction: Found order_id ${analysis.entities.order_id} from conversation history`);
                break;
              }
            }
          }
        }
        
        // OVERRIDE: If we have order_id and intent is an action, force needsMoreInfo=false
        if (analysis.entities && analysis.entities.order_id) {
          const actionIntents = ['track_order', 'cancel_order', 'request_refund', 'initiate_return'];
          if (actionIntents.includes(analysis.intent)) {
            analysis.needsMoreInfo = false;
            analysis.missingInfo = [];
            console.log(`🔧 Override: Has order_id ${analysis.entities.order_id}, setting needsMoreInfo=false`);
          }
        }
        
        console.log('✅ Message analyzed:', {
          sentiment: analysis.sentiment.emotion,
          intent: analysis.intent,
          entities: Object.keys(analysis.entities).filter(k => analysis.entities[k])
        });
        return analysis;
      }
      
      // Fallback
      return {
        sentiment: { score: 0, emotion: 'neutral', urgency: 'medium', escalate: false },
        problemType: 'other',
        intent: 'ask_question',
        entities: {},
        needsMoreInfo: false,
        missingInfo: []
      };
    } catch (error) {
      console.error('❌ Message analysis failed:', error);
      return {
        sentiment: { score: 0, emotion: 'neutral', urgency: 'medium', escalate: false },
        problemType: 'other',
        intent: 'ask_question',
        entities: {},
        needsMoreInfo: false,
        missingInfo: []
      };
    }
  }
  
  // ============================================
  shouldEscalateImmediately(sentiment, ticket) {
    // Only escalate immediately for truly critical cases
    return (
      sentiment.escalate === true ||           // Explicit "I want a human"
      sentiment.urgency === 'critical'         // Critical urgency only
    );
  }
  
  shouldEscalateAfterAttempt(sentiment, ticket) {
    // Escalate if customer is still angry/frustrated after we've tried to help
    return (
      (sentiment.emotion === 'angry' || sentiment.emotion === 'frustrated') &&
      ticket.attempts >= 2
    );
  }
  
  // ============================================
  // PRODUCTION FEATURES: CONFIDENCE & SAFETY
  // ============================================
  
  async scoreConfidence(response, customerContext, userMessage, ticket) {
    try {
      // Build context summary
      let contextSummary = '';
      if (customerContext.customer) {
        contextSummary += `Customer: ${customerContext.customer.name}\n`;
      }
      if (customerContext.order) {
        contextSummary += `Order: #${customerContext.order.id} - ${customerContext.order.status}\n`;
      }
      
      const prompt = `Rate confidence 0-1: Does this response fully and accurately answer the customer's question given the available context?

Customer Question: "${userMessage}"

Available Context:
${contextSummary}

Agent Response: "${response}"

Return ONLY a number between 0 and 1 (e.g., 0.85). Consider:
- Does the response directly address the question?
- Is the information accurate based on context?
- Are there any vague or uncertain statements?
- Does it make specific claims that can't be verified from context?

Confidence score:`;

      const result = await this.model.generateContent(prompt);
      const scoreText = result.response.text().trim();
      const score = parseFloat(scoreText.match(/[0-9.]+/)?.[0] || '0.5');
      
      return Math.max(0, Math.min(1, score)); // Clamp between 0 and 1
    } catch (error) {
      console.error('❌ Confidence scoring failed:', error);
      return 0.7; // Default to moderate confidence on error
    }
  }
  
  async validateResponse(response, customerContext, userMessage) {
    try {
      // OPTIMIZED: Fast validation with critical checks only (saves 1-2s)
      // We keep accuracy by doing smart pattern matching instead of slow LLM calls
      
      const issues = [];
      let safe = true;
      
      // 1. Check for toxic/rude language (fast regex)
      const toxicPatterns = [
        /\b(stupid|idiot|dumb|moron|fool|shut up|get lost)\b/i,
        /\b(hate|suck|terrible|awful|worst)\s+(you|customer|service)\b/i,
        /\b(go away|leave me alone|don\'t bother)\b/i
      ];
      const isToxic = toxicPatterns.some(pattern => pattern.test(response));
      if (isToxic) {
        issues.push('Toxic or unprofessional language detected');
        safe = false;
      }
      
      // 2. Check for private data leaks (fast regex)
      const privateDataPatterns = [
        /\b\d{16}\b/,                           // Credit card
        /\b\d{3}-\d{2}-\d{4}\b/,               // SSN
        /password[:\s]+\w+/i,                   // Password
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i  // Email (if not customer's)
      ];
      const sharesPrivateData = privateDataPatterns.some(pattern => pattern.test(response));
      if (sharesPrivateData) {
        issues.push('Potential private data leak detected');
        safe = false;
      }
      
      // 3. Check for hallucinated numbers/IDs (fast check)
      const hasHallucination = await this.detectHallucination(response, customerContext);
      if (hasHallucination) {
        issues.push('Detected hallucinated data (numbers/IDs not in context)');
        // Don't mark as unsafe - just warn (hallucinations are common but not dangerous)
      }
      
      // 4. Check for unverified promises (pattern matching)
      const promisePatterns = [
        /refund.*within\s+\d+/i,
        /will.*arrive.*\d+\s+(hours|days|minutes)/i,
        /guaranteed.*\d+/i
      ];
      const makesUnverifiedPromises = promisePatterns.some(pattern => {
        if (pattern.test(response)) {
          // Check if we have context to verify this
          const hasOrderContext = customerContext.order || customerContext.orders?.length > 0;
          return !hasOrderContext; // Only flag if no context
        }
        return false;
      });
      if (makesUnverifiedPromises) {
        issues.push('Makes unverified promises without context');
        // Don't mark as unsafe - just warn
      }
      
      return {
        safe,
        issues,
        makesUnverifiedPromises,
        containsHallucination: hasHallucination,
        sharesPrivateData,
        isToxic
      };
      
    } catch (error) {
      console.error('❌ Response validation failed:', error);
      // Fail open - assume safe to avoid blocking legitimate responses
      return { 
        safe: true, 
        issues: [],
        makesUnverifiedPromises: false,
        containsHallucination: false,
        sharesPrivateData: false,
        isToxic: false
      };
    }
  }
  
  async detectHallucination(response, customerContext) {
    try {
      // Extract numbers, order IDs, amounts from response
      const orderIds = response.match(/#\d+/g) || [];
      const amounts = response.match(/\$[\d,]+\.?\d*/g) || [];
      const trackingNumbers = response.match(/TRK\w+|TRACK\w+/gi) || [];
      
      const contextString = JSON.stringify(customerContext);
      
      // Check if each extracted value exists in context
      for (const orderId of orderIds) {
        const cleanId = orderId.replace('#', '');
        if (!contextString.includes(cleanId)) {
          console.warn(`⚠️ Hallucination detected: Order ${orderId} not in context`);
          return true;
        }
      }
      
      for (const amount of amounts) {
        const cleanAmount = amount.replace(/[$,]/g, '');
        if (!contextString.includes(cleanAmount)) {
          console.warn(`⚠️ Hallucination detected: Amount ${amount} not in context`);
          return true;
        }
      }
      
      // Only check tracking numbers if they look like actual tracking codes (TRK followed by numbers)
      for (const tracking of trackingNumbers) {
        // Skip generic words like "tracking" or "Tracking"
        if (tracking.toLowerCase() === 'tracking' || tracking.toLowerCase() === 'track') {
          continue;
        }
        
        // Only check if it looks like a real tracking number (has digits)
        if (/\d/.test(tracking) && !contextString.includes(tracking)) {
          console.warn(`⚠️ Hallucination detected: Tracking ${tracking} not in context`);
          return true;
        }
      }
      
      return false;
    } catch (error) {
      console.error('❌ Hallucination detection failed:', error);
      return false; // Fail open
    }
  }
  
  async logKnowledgeGap(userMessage, confidence) {
    try {
      // Check if this gap already exists
      const existing = await this.db.collection('knowledge_gaps').findOne({
        question: userMessage
      });
      
      if (existing) {
        // Increment frequency
        await this.db.collection('knowledge_gaps').updateOne(
          { question: userMessage },
          { 
            $inc: { frequency: 1 },
            $set: { lastAsked: new Date(), avgConfidence: confidence }
          }
        );
      } else {
        // Create new gap entry
        await this.db.collection('knowledge_gaps').insertOne({
          question: userMessage,
          frequency: 1,
          firstAsked: new Date(),
          lastAsked: new Date(),
          avgConfidence: confidence,
          resolved: false
        });
      }
      
      console.log(`📝 Knowledge gap logged: "${userMessage.substring(0, 50)}..."`);
    } catch (error) {
      console.error('❌ Failed to log knowledge gap:', error);
      // Don't throw - this is non-critical
    }
  }
  
  async handleMultipleIntents(analysis, customerContext, ticket, userMessage) {
    // Check if customer asked multiple things
    if (!analysis.allIntents || analysis.allIntents.length <= 1) {
      return null; // Single intent - use normal flow
    }
    
    console.log(`🔗 Multiple intents detected: ${analysis.allIntents.length}`);
    
    const results = [];
    
    // Execute each intent in priority order
    for (const intentObj of analysis.allIntents) {
      console.log(`  → Processing intent ${intentObj.priority}: ${intentObj.intent}`);
      
      const decision = {
        action: this.mapIntentToAction(intentObj.intent),
        params: {
          order: customerContext.order,
          customer: customerContext.customer,
          ...intentObj.entities
        }
      };
      
      const result = await this.executeAction(decision, customerContext, ticket, userMessage);
      results.push(result);
      
      // Stop chain if any action fails critically
      if (!result.success && decision.action !== 'answer_question') {
        console.log(`  ⚠️ Stopping intent chain due to failure`);
        break;
      }
    }
    
    // Combine all responses
    const combinedResponse = results
      .map((r, idx) => `${idx + 1}. ${r.response}`)
      .join('\n\n');
    
    return {
      success: results.every(r => r.success),
      resolved: results.some(r => r.resolved),
      response: combinedResponse,
      action_taken: 'multiple_intents',
      intents: analysis.allIntents.map(i => i.intent)
    };
  }
  
  mapIntentToAction(intent) {
    const actionMap = {
      'cancel_order': 'cancel_order',
      'initiate_return': 'initiate_return',
      'request_refund': 'process_refund',
      'track_order': 'provide_tracking',
      'change_address': 'update_address',
      'ask_question': 'answer_question',
      'complaint': 'handle_complaint'
    };
    return actionMap[intent] || 'answer_question';
  }
  
  // ============================================
  // ADVANCED FEATURES: MEMORY, CACHING, PERSONAS
  // ============================================
  
  async getSemanticCache(userMessage) {
    try {
      if (this.semanticCache.length === 0) return null;
      
      const ragService = require('./realRagService');
      const queryEmbedding = await ragService.createEmbedding(userMessage);
      
      // Find semantically similar cached query (>95% similarity)
      for (const entry of this.semanticCache) {
        const similarity = ragService.cosineSimilarity(queryEmbedding, entry.embedding);
        if (similarity > 0.95) {
          entry.hits++;
          console.log(`💰 Semantic cache hit! (${(similarity * 100).toFixed(1)}% match) - Saved 1 LLM call`);
          return entry.response;
        }
      }
      
      return null;
    } catch (error) {
      console.error('❌ Semantic cache lookup failed:', error);
      return null;
    }
  }
  
  async setSemanticCache(userMessage, response) {
    try {
      const ragService = require('./realRagService');
      const embedding = await ragService.createEmbedding(userMessage);
      
      this.semanticCache.push({
        query: userMessage,
        embedding,
        response,
        hits: 0,
        timestamp: new Date()
      });
      
      // Keep cache size manageable (max 100 entries)
      if (this.semanticCache.length > 100) {
        // Remove least-hit entries
        this.semanticCache.sort((a, b) => a.hits - b.hits);
        this.semanticCache = this.semanticCache.slice(-100);
      }
    } catch (error) {
      console.error('❌ Semantic cache set failed:', error);
    }
  }
  
  async selectPersona(customer, sentiment, detectedLanguage, ticket) {
    // Priority 1: Angry customer needs de-escalation
    if (sentiment.emotion === 'angry' || sentiment.emotion === 'frustrated') {
      return this.PERSONAS.angry_customer;
    }
    
    // Priority 2: VIP customer gets premium treatment
    if (customer && customer.isVIP) {
      return this.PERSONAS.vip;
    }
    
    // Priority 3: Language preference (Hindi/Hinglish)
    if (detectedLanguage === 'hindi' || detectedLanguage === 'hinglish') {
      return this.PERSONAS.hindi;
    }
    
    // Check customer memory for language preference
    const memory = await this.getCustomerMemory(ticket.userId);
    if (memory && memory.facts) {
      const hindiPreference = memory.facts.find(f => 
        f.toLowerCase().includes('hindi') || f.toLowerCase().includes('hinglish')
      );
      if (hindiPreference) {
        return this.PERSONAS.hindi;
      }
    }
    
    // Default: Standard persona
    return this.PERSONAS.standard;
  }
  
  async detectLanguage(userMessage) {
    try {
      // Quick heuristic check first (fast)
      const hindiChars = userMessage.match(/[\u0900-\u097F]/g);
      if (hindiChars && hindiChars.length > 3) {
        return 'hindi';
      }
      
      // Check for common Hinglish patterns
      const hinglishWords = ['kya', 'hai', 'mera', 'order', 'kab', 'aayega', 'nahi', 'chahiye'];
      const hasHinglish = hinglishWords.some(word => 
        userMessage.toLowerCase().includes(word)
      );
      if (hasHinglish) {
        return 'hinglish';
      }
      
      return 'english';
    } catch (error) {
      console.error('❌ Language detection failed:', error);
      return 'english';
    }
  }
  
  async summarizeConversationIfNeeded(ticket) {
    try {
      // Only summarize if history is long (>8 messages)
      if (ticket.history.length < 8) {
        return ticket.history;
      }
      
      console.log(`📝 Summarizing long conversation (${ticket.history.length} messages)...`);
      
      const conversationText = ticket.history.map(h =>
        `Customer: ${h.userMessage}\nAgent: ${h.agentResponse}`
      ).join('\n\n');
      
      const prompt = `Summarize this customer support conversation into 3-4 key bullet points.

Keep:
- Customer name and issue type
- Actions taken by agent
- Current status
- Any important context

Conversation:
${conversationText}

Return ONLY the summary as bullet points:`;

      const result = await this.model.generateContent(prompt);
      const summary = result.response.text();
      
      // Replace old history with summary + last 2 messages
      return [
        {
          userMessage: '[CONVERSATION SUMMARY]',
          agentResponse: summary,
          timestamp: new Date(),
          isSummary: true
        },
        ...ticket.history.slice(-2)
      ];
    } catch (error) {
      console.error('❌ Conversation summarization failed:', error);
      // Return original history if summarization fails
      return ticket.history;
    }
  }
  
  async getCustomerMemory(userId) {
    try {
      const memory = await this.db.collection('customer_memory').findOne({ userId });
      return memory;
    } catch (error) {
      console.error('❌ Failed to get customer memory:', error);
      return null;
    }
  }
  
  async updateCustomerMemory(userId, ticket, analysis) {
    try {
      const existing = await this.getCustomerMemory(userId);
      
      const prompt = `Update long-term customer memory with new interaction.

Existing memory facts: ${JSON.stringify(existing?.facts || [])}

New interaction:
- Customer message: "${ticket.lastMessage}"
- Sentiment: ${analysis.sentiment.emotion}
- Problem type: ${analysis.problemType}
- Language detected: ${analysis.detectedLanguage || 'english'}

Extract and update important facts to remember:
- Language preference
- Communication style preference
- Past issues or complaints
- VIP status or loyalty
- Specific preferences mentioned

Return ONLY a JSON array of facts (keep important, remove outdated):
["fact 1", "fact 2", "fact 3"]`;

      const result = await this.model.generateContent(prompt);
      const responseText = result.response.text();
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      
      if (jsonMatch) {
        const facts = JSON.parse(jsonMatch[0]);
        
        await this.db.collection('customer_memory').updateOne(
          { userId },
          { 
            $set: { 
              facts,
              lastUpdated: new Date(),
              totalInteractions: (existing?.totalInteractions || 0) + 1
            }
          },
          { upsert: true }
        );
        
        console.log(`🧠 Customer memory updated: ${facts.length} facts`);
      }
    } catch (error) {
      console.error('❌ Failed to update customer memory:', error);
      // Non-critical - don't throw
    }
  }
  
  async generateWithSelfReflection(response, userMessage, customerContext) {
    try {
      const reflectPrompt = `You are reviewing a customer support response for quality.

Customer question: "${userMessage}"

Available context: ${JSON.stringify(customerContext).substring(0, 300)}

Agent's draft response: "${response}"

Check the response against these criteria:
1. Is every fact verifiable from the provided context?
2. Does it actually solve the customer's problem?
3. Does it make any promises we can't keep?
4. Is anything important missing?
5. Is the tone appropriate?

Return ONLY a JSON object:
{
  "approved": <boolean>,
  "issues": ["<list of problems found>"],
  "improvedResponse": "<better version if needed, or null if approved>"
}`;

      const result = await this.model.generateContent(reflectPrompt);
      const responseText = result.response.text();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const reflection = JSON.parse(jsonMatch[0]);
        
        if (!reflection.approved && reflection.improvedResponse) {
          console.log(`🔍 Self-reflection improved response. Issues: ${reflection.issues.join(', ')}`);
          return reflection.improvedResponse;
        }
      }
      
      return response; // Return original if approved or reflection fails
    } catch (error) {
      console.error('❌ Self-reflection failed:', error);
      return response; // Return original on error
    }
  }
  
  // ============================================
  // CUSTOMER CONTEXT
  // ============================================
  
  async getCustomerContext(entities) {
    const context = {};
    
    try {
      // Fetch customer by email
      if (entities.email) {
        context.customer = await this.db.collection('customers').findOne({ email: entities.email });
      }
      
      // Fetch order
      if (entities.order_id) {
        context.order = await this.db.collection('orders').findOne({ id: entities.order_id });
      } else if (entities.tracking_number) {
        context.order = await this.db.collection('orders').findOne({ tracking_number: entities.tracking_number });
      }
      
      // If we have an order but no customer, fetch customer from order's customer_id
      if (context.order && !context.customer && context.order.customer_id) {
        context.customer = await this.db.collection('customers').findOne({ id: context.order.customer_id });
      }
      
      // Fetch customer's orders if we have customer
      if (context.customer) {
        context.orders = await this.db.collection('orders')
          .find({ customer_id: context.customer.id })
          .sort({ id: -1 })
          .limit(5)
          .toArray();
      }
      
      return context;
    } catch (error) {
      console.error('❌ Context fetch failed:', error);
      return context;
    }
  }
  
  // ============================================
  // ACTION DECISION
  // ============================================
  
  async decideAction(understanding, customerContext, ticket) {
    const { intent, needsMoreInfo, missingInfo } = understanding;
    
    // If missing info, ask for it
    if (needsMoreInfo) {
      return {
        action: 'ask_for_info',
        params: { missingInfo }
      };
    }
    
    // Map intent to action
    const actionMap = {
      'cancel_order': 'cancel_order',
      'initiate_return': 'initiate_return',
      'request_refund': 'process_refund',
      'track_order': 'provide_tracking',
      'change_address': 'update_address',
      'ask_question': 'answer_question',
      'complaint': 'handle_complaint'
    };
    
    const action = actionMap[intent] || 'answer_question';
    
    // Check if we can perform the action
    const canPerform = await this.canPerformAction(action, customerContext, ticket);
    
    if (!canPerform.allowed) {
      return {
        action: 'escalate',
        reason: canPerform.reason
      };
    }
    
    return {
      action,
      params: {
        order: customerContext.order,
        customer: customerContext.customer
      }
    };
  }
  
  async canPerformAction(action, context, ticket) {
    switch (action) {
      case 'cancel_order':
        if (!context.order) {
          return { allowed: false, reason: 'Order not found' };
        }
        if (context.order.status === 'delivered') {
          return { allowed: false, reason: 'Order already delivered - cannot cancel' };
        }
        return { allowed: true };
        
      case 'process_refund':
        if (!context.order) {
          return { allowed: false, reason: 'Order not found' };
        }
        const refundAmount = context.order.total || context.order.UnitPrice || 0;
        if (refundAmount > this.ESCALATION_THRESHOLDS.REFUND_AMOUNT) {
          return { allowed: false, reason: `Refund amount $${refundAmount} exceeds threshold` };
        }
        return { allowed: true };
        
      case 'initiate_return':
        if (!context.order) {
          return { allowed: false, reason: 'Order not found' };
        }
        // Check if within return window (30 days)
        const orderDate = new Date(context.order.created_at || '2010-12-01');
        const daysSinceOrder = (new Date() - orderDate) / (1000 * 60 * 60 * 24);
        if (daysSinceOrder > 30) {
          return { allowed: false, reason: 'Outside 30-day return window' };
        }
        return { allowed: true };
        
      default:
        return { allowed: true };
    }
  }
  
  // ============================================
  // ACTION EXECUTION
  // ============================================
  
  async executeAction(decision, context, ticket, userMessage, persona = null) {
    console.log(`🔧 Executing action: ${decision.action}`);
    
    try {
      switch (decision.action) {
        case 'cancel_order':
          return await this.cancelOrder(context.order, context.customer);
          
        case 'initiate_return':
          return await this.initiateReturn(context.order, context.customer);
          
        case 'process_refund':
          return await this.processRefund(context.order, context.customer);
          
        case 'provide_tracking':
          return await this.provideTracking(context.order);
          
        case 'update_address':
          return await this.updateAddress(context.order, decision.params.newAddress);
          
        case 'handle_complaint':
          return await this.handleComplaint(context, ticket, userMessage);
          
        case 'ask_for_info':
          return this.askForMissingInfo(decision.params.missingInfo);
          
        case 'escalate':
          return await this.escalateToHuman(ticket, decision.reason);
          
        case 'answer_question':
        default:
          return await this.answerQuestion(ticket, context, userMessage, persona);
      }
    } catch (error) {
      console.error(`❌ Action execution failed:`, error);
      return {
        success: false,
        resolved: false,
        response: "I encountered an error while trying to help you. Let me connect you with a human agent."
      };
    }
  }
  
  // ============================================
  // SPECIFIC ACTIONS
  // ============================================
  
  async cancelOrder(order, customer) {
    try {
      if (!order) {
        return {
          success: false,
          resolved: false,
          response: "I couldn't find that order. Could you provide the order number?"
        };
      }
      
      if (!customer) {
        // Fetch customer from order
        customer = await this.db.collection('customers').findOne({ id: order.customer_id });
      }
      
      // Update order status in database
      await this.db.collection('orders').updateOne(
        { id: order.id },
        { 
          $set: { 
            status: 'cancelled',
            cancelled_at: new Date(),
            cancelled_by: 'customer_support_ai'
          }
        }
      );
      
      // Send confirmation email (simulated)
      if (customer) {
        await this.sendEmail(customer.email, 'Order Cancelled', `Your order #${order.id} has been cancelled.`);
      }
      
      return {
        success: true,
        resolved: true,
        response: `I've successfully cancelled your order #${order.id} for ${order.product_name}.${customer ? ` You'll receive a confirmation email at ${customer.email} shortly.` : ''} If you were charged, the refund will be processed within 5-7 business days.`,
        action_taken: 'order_cancelled',
        resolution: `Order #${order.id} cancelled successfully`
      };
    } catch (error) {
      console.error('❌ Cancel order failed:', error);
      return {
        success: false,
        resolved: false,
        response: "I'm having trouble cancelling your order right now. Let me connect you with a human agent who can help immediately."
      };
    }
  }
  
  async initiateReturn(order, customer) {
    try {
      // Generate return label
      const returnLabel = `RET${order.id}${Date.now()}`;
      
      // Update order status
      await this.db.collection('orders').updateOne(
        { id: order.id },
        { 
          $set: { 
            status: 'return_initiated',
            return_label: returnLabel,
            return_initiated_at: new Date()
          }
        }
      );
      
      // Send return label email
      await this.sendEmail(
        customer.email,
        'Return Label for Your Order',
        `Your return label: ${returnLabel}\nPlease print and attach to your package.`
      );
      
      return {
        success: true,
        resolved: true,
        response: `I've initiated the return for your order #${order.id}. Your return label is ${returnLabel}. I've emailed it to ${customer.email}. Please print it, attach it to your package, and drop it off at any shipping location. Once we receive it, your refund will be processed within 5-7 business days.`,
        action_taken: 'return_initiated',
        resolution: `Return initiated for order #${order.id}, label: ${returnLabel}`
      };
    } catch (error) {
      console.error('❌ Initiate return failed:', error);
      return {
        success: false,
        resolved: false,
        response: "I'm having trouble processing your return. Let me connect you with a human agent."
      };
    }
  }
  
  async processRefund(order, customer) {
    try {
      // Check if customer exists
      if (!customer) {
        return {
          success: false,
          resolved: false,
          response: "I need to verify your account details first. Could you please provide your email address or customer ID?"
        };
      }
      
      const refundAmount = order.total || order.UnitPrice || 0;
      
      // Process refund
      await this.db.collection('orders').updateOne(
        { id: order.id },
        { 
          $set: { 
            status: 'refunded',
            refund_amount: refundAmount,
            refunded_at: new Date()
          }
        }
      );
      
      // Send confirmation
      await this.sendEmail(
        customer.email,
        'Refund Processed',
        `Your refund of $${refundAmount} for order #${order.id} has been processed.`
      );
      
      return {
        success: true,
        resolved: true,
        response: `I've processed your refund of $${refundAmount} for order #${order.id}. The money will be returned to your original payment method within 5-7 business days. You'll receive a confirmation email at ${customer.email}.`,
        action_taken: 'refund_processed',
        resolution: `Refund of $${refundAmount} processed for order #${order.id}`
      };
    } catch (error) {
      console.error('❌ Process refund failed:', error);
      return {
        success: false,
        resolved: false,
        response: "I'm having trouble processing your refund. Let me connect you with a human agent."
      };
    }
  }
  
  async provideTracking(order) {
    if (!order) {
      return {
        success: false,
        resolved: false,
        response: "I couldn't find your order. Could you provide your order number or tracking number?"
      };
    }
    
    return {
      success: true,
      resolved: true,
      response: `Your order #${order.id} for ${order.product_name} is currently "${order.status}". Tracking number: ${order.tracking_number}. ${order.estimated_delivery ? `Estimated delivery: ${order.estimated_delivery}` : ''}`,
      action_taken: 'tracking_provided',
      resolution: `Tracking info provided for order #${order.id}`
    };
  }
  
  async updateAddress(order, newAddress) {
    try {
      if (!order) {
        return {
          success: false,
          resolved: false,
          response: "I couldn't find your order. Could you provide the order number?"
        };
      }
      
      if (order.status === 'delivered' || order.status === 'shipped') {
        return {
          success: false,
          resolved: false,
          response: `I'm sorry, but your order #${order.id} has already ${order.status === 'delivered' ? 'been delivered' : 'shipped'}. I can't change the address at this point. Would you like me to help with a return or redirect?`
        };
      }
      
      if (!newAddress) {
        return {
          success: false,
          resolved: false,
          response: "Could you please provide the new delivery address you'd like to use?"
        };
      }
      
      // Update address in database
      await this.db.collection('orders').updateOne(
        { id: order.id },
        { 
          $set: { 
            shipping_address: newAddress,
            address_updated_at: new Date()
          }
        }
      );
      
      return {
        success: true,
        resolved: true,
        response: `I've updated the delivery address for your order #${order.id} to: ${newAddress}. Your order will be delivered to this new address.`,
        action_taken: 'address_updated',
        resolution: `Address updated for order #${order.id}`
      };
    } catch (error) {
      console.error('❌ Update address failed:', error);
      return {
        success: false,
        resolved: false,
        response: "I'm having trouble updating the address. Let me connect you with a human agent who can help."
      };
    }
  }
  
  async handleComplaint(context, ticket, userMessage) {
    try {
      // 1. Acknowledge the frustration with empathy
      // 2. Identify what went wrong
      // 3. Take corrective action if possible
      // 4. Offer resolution
      
      let response = "I sincerely apologize for the frustration you've experienced. ";
      let action_taken = 'complaint_acknowledged';
      let resolved = false;
      
      // If we have order context, try to resolve
      if (context.order) {
        const order = context.order;
        
        // Check order status and offer appropriate resolution
        if (order.status === 'delayed' || order.status === 'processing') {
          response += `I can see your order #${order.id} is ${order.status}. Let me help resolve this right away. `;
          
          // Offer expedited shipping or refund
          response += `I'd like to offer you priority shipping at no extra cost, or if you prefer, I can process a full refund immediately. Which would you prefer?`;
          action_taken = 'complaint_resolution_offered';
          
        } else if (order.status === 'delivered') {
          response += `I see your order was delivered. If there's an issue with the product, I can initiate a return and refund right away, or send a replacement with expedited shipping. What would work best for you?`;
          action_taken = 'complaint_resolution_offered';
          
        } else {
          response += `Let me look into your order #${order.id} and find the best solution for you.`;
        }
      } else {
        // No order context - acknowledge and ask for details
        response += `I want to make this right. Could you share your order number so I can look into this immediately and find the best solution for you?`;
      }
      
      return {
        success: true,
        resolved,
        response,
        action_taken
      };
    } catch (error) {
      console.error('❌ Handle complaint failed:', error);
      return {
        success: false,
        resolved: false,
        response: "I understand your frustration and I want to help. Let me connect you with a senior support specialist who can resolve this immediately."
      };
    }
  }
  
  askForMissingInfo(missingInfo) {
    const questions = {
      'order_id': 'Could you please provide your order number?',
      'tracking_number': 'Could you share your tracking number?',
      'email': 'What email address did you use for your order?',
      'product_name': 'Which product are you asking about?'
    };
    
    const question = missingInfo.map(info => questions[info] || `Could you provide ${info}?`).join(' ');
    
    return {
      success: true,
      resolved: false,
      response: question,
      action_taken: 'requested_info'
    };
  }
  
  async answerQuestion(ticket, context, userMessage, persona = null) {
    try {
      // Use RAG service for vector search
      const ragService = require('./realRagService');
      
      // Wait for RAG service to initialize properly
      await ragService.waitForInitialization();
      
      // Get relevant knowledge chunks via vector search
      let relevantChunks = [];
      let knowledgeBaseAvailable = false;
      
      try {
        const queryEmbedding = await ragService.createEmbedding(userMessage);
        relevantChunks = await ragService.vectorSearch(queryEmbedding, 5);
        console.log(`✅ Found ${relevantChunks.length} relevant knowledge items via vector search`);
        
        if (relevantChunks.length > 0) {
          knowledgeBaseAvailable = true;
        } else {
          console.warn('⚠️ Knowledge base returned 0 results - may need to run: npm run populate-kb');
        }
      } catch (error) {
        console.warn('⚠️ Vector search failed, continuing without knowledge base:', error.message);
        console.warn('💡 Tip: Run "npm run populate-kb" to populate the knowledge base');
      }
      
      // Build knowledge context from relevant chunks
      let knowledgeContext = '';
      if (relevantChunks.length > 0) {
        knowledgeContext = 'RELEVANT KNOWLEDGE:\n';
        relevantChunks.forEach((chunk, idx) => {
          knowledgeContext += `${idx + 1}. [${chunk.category || 'general'}] ${chunk.title || 'Info'}: ${chunk.content}\n`;
        });
        console.log(`📚 Using knowledge base for answer (found ${relevantChunks.length} relevant items)`);
      } else {
        console.warn('⚠️ No knowledge base context available - answers may be incomplete');
        console.warn('💡 For policy questions, run: npm run populate-kb');
      }
      
      // Build customer context (already fetched by agent)
      let customerContextStr = '';
      if (context.customer) {
        customerContextStr += `\nCustomer: ${context.customer.name} (${context.customer.email})`;
      }
      if (context.order) {
        customerContextStr += `\nOrder: #${context.order.id} - ${context.order.product_name} - ${context.order.status}`;
      }
      if (context.orders && context.orders.length > 0) {
        customerContextStr += `\nRecent Orders: ${context.orders.length} orders`;
      }
      
      // Add customer memory (long-term facts)
      if (context.memory && context.memory.length > 0) {
        customerContextStr += `\n\nCustomer Memory (from past interactions):\n`;
        context.memory.forEach(fact => {
          customerContextStr += `- ${fact}\n`;
        });
      }
      
      // Build conversation history
      let conversationContext = '';
      if (ticket.history.length > 0) {
        conversationContext = '\n\nConversation:\n';
        ticket.history.slice(-3).forEach(h => {
          if (h.isSummary) {
            conversationContext += `[Previous conversation summary]\n${h.agentResponse}\n\n`;
          } else {
            conversationContext += `Customer: ${h.userMessage}\nYou: ${h.agentResponse}\n`;
          }
        });
      }
      
      // Use persona if provided
      const selectedPersona = persona || this.PERSONAS.standard;
      
      // Generate response with all context + persona
      const prompt = `You are ${selectedPersona.name}, a customer support agent.

YOUR PERSONA:
- Tone: ${selectedPersona.tone}
- Language: ${selectedPersona.language}
- Style: ${selectedPersona.style}

${knowledgeContext}

CUSTOMER CONTEXT:${customerContextStr}${conversationContext}

Customer: ${userMessage}

You (respond naturally in the specified language and tone):`;

      const result = await this.model.generateContent(prompt);
      let response = result.response.text();
      
      // Apply self-reflection to improve response quality
      // DISABLED FOR DEMO - adds 1-2s latency without visible benefit
      // response = await this.generateWithSelfReflection(response, userMessage, context);
      
      // Cache this response for future similar questions
      // DISABLED FOR DEMO - not visible to client
      // await this.setSemanticCache(userMessage, response);
      
      return {
        success: true,
        resolved: false, // Questions don't auto-resolve tickets
        response,
        action_taken: 'answered_question',
        persona: selectedPersona.name
      };
    } catch (error) {
      console.error('❌ Answer question failed:', error);
      return {
        success: false,
        resolved: false,
        response: "I'm having trouble accessing information right now. Let me connect you with a human agent."
      };
    }
  }
  
  // ============================================
  // ESCALATION
  // ============================================
  
  async escalateToHuman(ticket, reason) {
    console.log(`🚨 Escalating ticket ${ticket.id} to human: ${reason}`);
    
    ticket.status = 'escalated';
    ticket.escalated_at = new Date();
    ticket.escalation_reason = reason;
    
    await this.saveTicket(ticket);
    
    // Notify human agents (simulated)
    await this.notifyHumanAgents(ticket);
    
    return {
      success: true,
      resolved: false,
      escalated: true,
      response: `I understand this needs special attention. I'm connecting you with one of our human support specialists right now. They'll be with you shortly. Your ticket number is ${ticket.id}.`,
      action_taken: 'escalated_to_human',
      ticketId: ticket.id
    };
  }
  
  // ============================================
  // TICKET MANAGEMENT
  // ============================================
  
  getActiveTicket(userId) {
    return this.activeTickets.get(userId);
  }
  
  async createTicket(userId, initialMessage) {
    const ticket = {
      id: `TKT${Date.now()}${Math.random().toString(36).substr(2, 9)}`,
      userId,
      status: 'open',
      created_at: new Date(),
      lastUpdate: new Date(),
      lastMessage: initialMessage,
      attempts: 0,
      history: [],
      context: {},
      sentiment: null,
      problemType: null,
      intent: null
    };
    
    this.activeTickets.set(userId, ticket);
    return ticket;
  }
  
  async saveTicket(ticket) {
    try {
      await this.db.collection('support_tickets').updateOne(
        { id: ticket.id },
        { $set: ticket },
        { upsert: true }
      );
    } catch (error) {
      console.error('❌ Save ticket failed:', error);
    }
  }
  
  async closeTicket(ticket, resolution) {
    ticket.status = 'resolved';
    ticket.resolved_at = new Date();
    ticket.resolution = resolution;
    
    await this.saveTicket(ticket);
    this.activeTickets.delete(ticket.userId);
    
    // Schedule follow-up (24 hours later)
    setTimeout(() => {
      this.sendFollowUp(ticket);
    }, 24 * 60 * 60 * 1000);
  }
  
  // ============================================
  // COMMUNICATION
  // ============================================
  
  async sendEmail(to, subject, body) {
    // Simulated email sending
    console.log(`📧 Email sent to ${to}: ${subject}`);
    return true;
  }
  
  async notifyHumanAgents(ticket) {
    // Simulated notification
    console.log(`🔔 Human agents notified about ticket ${ticket.id}`);
    return true;
  }
  
  async sendFollowUp(ticket) {
    console.log(`📬 Follow-up sent for ticket ${ticket.id}`);
    // Implementation for follow-up
  }
}

module.exports = new CustomerSupportAgent();