const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleGenAI } = require('@google/genai');
const { MongoClient } = require('mongodb');
const dns = require('dns');

// Set Google DNS to bypass local DNS issues
dns.setServers(['8.8.8.8', '8.8.4.4']);

class RealRAGService {
  constructor() {
    console.log('🧠 Real RAG Service initializing...');
    
    // MongoDB setup
    this.mongoClient = null;
    this.db = null;
    this.useInMemory = false;
    this.initializationPromise = null;
    this.isInitialized = false;
    
    // Gemini AI setup
    this.genaiOld = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    this.model = this.genaiOld.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    // New SDK for embeddings
    this.genaiNew = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
    });
    
    // Start initialization but don't wait
    this.initializationPromise = this.initialize();
  }
  
  async waitForInitialization() {
    if (!this.isInitialized && this.initializationPromise) {
      await this.initializationPromise;
    }
  }
  
  async initialize() {
    try {
      // Try to connect to MongoDB
      if (process.env.MONGODB_URI && process.env.MONGODB_URI.includes('mongodb')) {
        await this.connectMongoDB();
      } else {
        throw new Error('No MongoDB URI found');
      }
      
      this.isInitialized = true;
      console.log('✅ Real RAG Service initialized');
    } catch (error) {
      console.error('❌ RAG initialization failed:', error.message);
      console.log('⚠️ MongoDB is required for production RAG system');
      throw error;
    }
  }
  
  async connectMongoDB() {
    try {
      const options = {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        family: 4,
        retryWrites: true,
        w: 'majority'
      };
      
      let uri = process.env.MONGODB_URI;
      if (!uri.includes('?')) {
        uri += '?retryWrites=true&w=majority';
      }
      
      console.log('⏳ Connecting to MongoDB Atlas...');
      this.mongoClient = new MongoClient(uri, options);
      await this.mongoClient.connect();
      
      await this.mongoClient.db('admin').command({ ping: 1 });
      
      this.db = this.mongoClient.db('ecommerce_rag');
      console.log('✅ Connected to MongoDB Atlas for RAG');
      this.useInMemory = false;
    } catch (error) {
      console.error('❌ MongoDB connection failed:', error.message);
      console.log('💡 Tip: Check if your IP is whitelisted in MongoDB Atlas');
      throw error;
    }
  }
  
  async createEmbedding(text) {
    try {
      const response = await this.genaiNew.models.embedContent({
        model: 'gemini-embedding-2', // ✅ Works with new SDK
        contents: text
      });
      
      return response.embeddings[0].values;
    } catch (error) {
      console.error('❌ Embedding creation failed:', error.message);
      throw error; // Fail loudly - embeddings are critical
    }
  }
  
  async vectorSearch(queryEmbedding, topK = 5) {
    try {
      // Search in knowledge_base collection - OPTIMIZED: only fetch docs with embeddings
      const documents = await this.db.collection('knowledge_base')
        .find({ embedding: { $exists: true } })  // ✅ Filter for docs with embeddings
        .toArray();
      
      if (!documents.length) {
        console.warn('⚠️ No documents with embeddings in knowledge_base collection');
        return [];
      }
      
      const similarities = documents.map(doc => {
        if (!doc.embedding) return { doc, similarity: 0 };
        const similarity = this.cosineSimilarity(queryEmbedding, doc.embedding);
        return { doc, similarity };
      });
      
      return similarities
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, topK)
        .map(item => ({ ...item.doc, similarity: item.similarity }));
        
    } catch (error) {
      console.error('❌ Vector search failed:', error);
      return [];
    }
  }
  
  cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0, normA = 0, normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
  
  async extractEntities(userMessage, conversationHistory) {
    try {
      // Build conversation context
      let conversationContext = '';
      if (conversationHistory.length > 0) {
        conversationContext = '\n\nRecent conversation:\n' + 
          conversationHistory.slice(-3).map(msg => `${msg.role}: ${msg.content}`).join('\n');
      }
      
      const prompt = `Extract entities from the user's message. Return ONLY a JSON object with these fields:
- email: customer email if mentioned (null if not found)
- tracking_number: order tracking number if mentioned (null if not found)
- customer_id: customer ID if mentioned (null if not found)
- product_name: product name if mentioned (null if not found)
- order_id: order ID if mentioned (null if not found)

Handle multiple languages (English, Hindi, Hinglish). Look for patterns like:
- Email: any email format
- Tracking: TRK*, TRACK*, TR* followed by alphanumeric
- Customer ID: "customer" followed by numbers
- Product names: any product mentioned
- Order ID: "order" followed by numbers

${conversationContext}

User message: "${userMessage}"

Return ONLY valid JSON, no explanation:`;

      const result = await this.model.generateContent(prompt);
      const response = result.response.text();
      
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const entities = JSON.parse(jsonMatch[0]);
        console.log('✅ Extracted entities:', entities);
        return entities;
      }
      
      return {};
    } catch (error) {
      console.error('❌ Entity extraction failed:', error.message);
      return {};
    }
  }
  
  async fetchLiveData(entities) {
    try {
      const liveData = {};
      
      // Fetch customer by email
      if (entities.email) {
        const customer = await this.db.collection('customers').findOne({ 
          email: entities.email 
        });
        if (customer) {
          liveData.customer = customer;
          liveData.orders = await this.db.collection('orders')
            .find({ customer_id: customer.id })
            .limit(5)
            .toArray();
        }
      }
      
      // Fetch customer by ID
      if (entities.customer_id && !liveData.customer) {
        const customerId = parseInt(entities.customer_id);
        const customer = await this.db.collection('customers').findOne({ 
          id: customerId 
        });
        if (customer) {
          liveData.customer = customer;
          liveData.orders = await this.db.collection('orders')
            .find({ customer_id: customer.id })
            .limit(5)
            .toArray();
        }
      }
      
      // Fetch order by tracking number
      if (entities.tracking_number) {
        const order = await this.db.collection('orders').findOne({ 
          tracking_number: entities.tracking_number 
        });
        if (order) {
          liveData.trackedOrder = order;
          
          // Also fetch customer for this order
          if (!liveData.customer) {
            const customer = await this.db.collection('customers').findOne({ 
              id: order.customer_id 
            });
            if (customer) {
              liveData.customer = customer;
            }
          }
        }
      }
      
      // Fetch order by ID
      if (entities.order_id && !liveData.trackedOrder) {
        const orderId = parseInt(entities.order_id);
        const order = await this.db.collection('orders').findOne({ 
          id: orderId 
        });
        if (order) {
          liveData.trackedOrder = order;
        }
      }
      
      // Search for product
      if (entities.product_name) {
        const products = await this.db.collection('products')
          .find({ 
            $text: { $search: entities.product_name } 
          })
          .limit(3)
          .toArray();
        
        if (products.length > 0) {
          liveData.products = products;
        }
      }
      
      return liveData;
      
    } catch (error) {
      console.error('❌ Live data fetch failed:', error);
      return {};
    }
  }
  
  async processQuery(userMessage, userId = 'default', conversationHistory = []) {
    console.log('🤖 Processing query:', userMessage);
    
    try {
      // 1. Create embedding for query
      console.log('📊 Step 1: Creating query embedding...');
      const queryEmbedding = await this.createEmbedding(userMessage);
      
      // 2. Vector search for relevant knowledge
      console.log('🔍 Step 2: Vector search in knowledge base...');
      const relevantChunks = await this.vectorSearch(queryEmbedding, 5);
      console.log(`✅ Found ${relevantChunks.length} relevant knowledge items`);
      
      // 3. Extract entities using LLM
      console.log('🎯 Step 3: Extracting entities...');
      const entities = await this.extractEntities(userMessage, conversationHistory);
      
      // 4. Fetch live data based on entities
      console.log('📦 Step 4: Fetching live data...');
      const liveData = await this.fetchLiveData(entities);
      
      // 5. Generate response
      console.log('💬 Step 5: Generating response...');
      const response = await this.generateWithLLM(
        userMessage,
        relevantChunks,
        liveData,
        conversationHistory
      );
      
      console.log('✅ Query processed successfully');
      return response;
      
    } catch (error) {
      console.error('❌ Query processing failed:', error);
      throw error;
    }
  }
  
  async generateWithLLM(userMessage, relevantChunks, liveData, conversationHistory) {
    try {
      // Build knowledge context from vector search results
      let knowledgeContext = '';
      if (relevantChunks.length > 0) {
        knowledgeContext = 'KNOWLEDGE BASE:\n';
        relevantChunks.forEach((chunk, idx) => {
          knowledgeContext += `${idx + 1}. [${chunk.category || 'general'}] ${chunk.title || 'Info'}: ${chunk.content}\n`;
        });
      }
      
      // Build live data context
      let liveDataContext = '';
      
      if (liveData.customer) {
        liveDataContext += `\nCUSTOMER INFO:\n`;
        liveDataContext += `- Name: ${liveData.customer.name}\n`;
        liveDataContext += `- Email: ${liveData.customer.email}\n`;
        liveDataContext += `- Customer ID: ${liveData.customer.id}\n`;
      }
      
      if (liveData.orders && liveData.orders.length > 0) {
        liveDataContext += `\nRECENT ORDERS:\n`;
        liveData.orders.slice(0, 3).forEach(order => {
          liveDataContext += `- Order #${order.id}: ${order.product_name} - ${order.status}`;
          if (order.tracking_number) liveDataContext += ` (Tracking: ${order.tracking_number})`;
          liveDataContext += '\n';
        });
      }
      
      if (liveData.trackedOrder) {
        const order = liveData.trackedOrder;
        liveDataContext += `\nTRACKED ORDER:\n`;
        liveDataContext += `- Order #${order.id}: ${order.product_name}\n`;
        liveDataContext += `- Status: ${order.status}\n`;
        liveDataContext += `- Tracking: ${order.tracking_number}\n`;
        if (order.estimated_delivery) {
          liveDataContext += `- Estimated Delivery: ${order.estimated_delivery}\n`;
        }
      }
      
      if (liveData.products && liveData.products.length > 0) {
        liveDataContext += `\nPRODUCTS:\n`;
        liveData.products.forEach(product => {
          liveDataContext += `- ${product.Description || product.product_name}: $${product.UnitPrice || product.price}\n`;
        });
      }
      
      // Build conversation context
      let conversationContext = '';
      if (conversationHistory.length > 0) {
        conversationContext = '\nCONVERSATION HISTORY:\n';
        conversationHistory.forEach(msg => {
          conversationContext += `${msg.role === 'user' ? 'Customer' : 'You'}: ${msg.content}\n`;
        });
      }
      
      // Build final prompt
      const prompt = `You are a helpful customer support agent for an e-commerce company.

INSTRUCTIONS:
- Answer naturally and conversationally (this is for voice, so be human)
- Use the knowledge base and live data to provide accurate information
- When the user refers to "this product", "that order", "it", etc., use the conversation history to understand what they mean
- Be warm, friendly, and solution-oriented
- Keep responses concise (2-4 sentences for voice)
- If you don't have information, say so honestly and offer alternatives

${knowledgeContext}
${liveDataContext}
${conversationContext}

Customer: ${userMessage}

You:`;

      const result = await this.model.generateContent(prompt);
      const response = result.response.text();
      
      return response;
      
    } catch (error) {
      console.error('❌ LLM generation failed:', error);
      throw error;
    }
  }
}

module.exports = new RealRAGService();