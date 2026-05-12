const express = require('express');
const multer = require('multer');
const router = express.Router();
const voiceProcessor = require('../services/voiceProcessor');
const supportAgent = require('../services/customerSupportAgent');

const upload = multer({ storage: multer.memoryStorage() });

// Real STT endpoint - processes actual audio
router.post('/stt', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }
    
    console.log('🎤 Received audio file for STT processing:');
    console.log('📊 File info:', {
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size + ' bytes'
    });
    
    // Process the actual audio buffer
    const transcription = await voiceProcessor.speechToText(req.file.buffer);
    
    console.log('✅ STT Result:', transcription);
    
    res.json({ 
      transcription,
      audioInfo: {
        size: req.file.size,
        type: req.file.mimetype,
        originalName: req.file.originalname
      }
    });
    
  } catch (error) {
    console.error('❌ STT Error:', error);
    res.status(500).json({ error: 'Speech to text conversion failed: ' + error.message });
  }
});

// Test TTS endpoint
router.post('/tts', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }
    
    // Mock TTS for demo (replace with actual OpenAI when API key is added)
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key') {
      // Return a simple beep sound as placeholder
      const fs = require('fs');
      const path = require('path');
      
      // Create a simple audio buffer (silence)
      const sampleRate = 22050;
      const duration = 2; // 2 seconds
      const samples = sampleRate * duration;
      const buffer = Buffer.alloc(samples * 2); // 16-bit audio
      
      res.set({
        'Content-Type': 'audio/wav',
        'Content-Length': buffer.length
      });
      
      return res.send(buffer);
    }
    
    const audioBuffer = await voiceProcessor.textToSpeech(text);
    
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length
    });
    
    res.send(audioBuffer);
  } catch (error) {
    console.error('TTS Error:', error);
    res.status(500).json({ error: 'Text to speech conversion failed' });
  }
});

// Advanced AI Chat endpoint
router.post('/chat', async (req, res) => {
  try {
    const { message, conversationHistory = [], userId = 'default' } = req.body;
    
    // Handle empty or missing message
    if (!message || message.trim().length === 0) {
      return res.json({ 
        response: "Hello! I'm here to help you with any questions about your orders, returns, billing, or our policies. What can I assist you with today?",
        intent: 'greeting',
        entities: {},
        sources: []
      });
    }
    
    console.log('🎯 Chat request received:', { message, userId });
    
    // Use Customer Support Agent
    const result = await supportAgent.handleCustomerMessage(message, userId, conversationHistory);
    
    console.log('✅ Support agent response:', result.response.substring(0, 100) + '...');
    
    res.json({
      response: result.response,
      action: result.action,
      resolved: result.resolved,
      escalated: result.escalated || false,
      ticketId: result.ticketId,
      intent: 'support_agent',
      entities: {},
      sources: ['customer_support_agent']
    });
  } catch (error) {
    console.error('AI Chat Error:', error);
    res.status(500).json({ 
      error: 'Failed to generate AI response',
      response: "I apologize, but I'm having trouble processing your request right now. Please try again.",
      intent: 'error',
      entities: {},
      sources: []
    });
  }
});

// Knowledge base search endpoint (uses MongoDB now, not dummyDatabase)
router.get('/knowledge/search', async (req, res) => {
  try {
    const { q: query } = req.query;
    
    if (!query) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }
    
    const ragService = require('../services/realRagService');
    
    // Use vector search instead of dummyDatabase
    const queryEmbedding = await ragService.createEmbedding(query);
    const results = await ragService.vectorSearch(queryEmbedding, 10);
    
    res.json({
      query,
      results: results.map(r => ({
        title: r.title,
        content: r.content,
        category: r.category,
        similarity: r.similarity
      })),
      totalResults: results.length
    });
  } catch (error) {
    console.error('Knowledge Search Error:', error);
    res.status(500).json({ error: 'Failed to search knowledge base' });
  }
});

// Get customer info by email/phone (uses MongoDB now)
router.post('/customer/lookup', async (req, res) => {
  try {
    const { email, phone } = req.body;
    
    if (!email && !phone) {
      return res.status(400).json({ error: 'Email or phone required' });
    }
    
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    
    await client.connect();
    const db = client.db('ecommerce_rag');
    
    let customer = null;
    let orders = [];
    
    if (email) {
      customer = await db.collection('customers').findOne({ email });
    } else if (phone) {
      customer = await db.collection('customers').findOne({ phone });
    }
    
    if (customer) {
      orders = await db.collection('orders')
        .find({ customer_id: customer.id })
        .sort({ id: -1 })
        .limit(10)
        .toArray();
    }
    
    await client.close();
    
    res.json({ 
      customer,
      orders,
      found: !!customer
    });
  } catch (error) {
    console.error('Customer Lookup Error:', error);
    res.status(500).json({ error: 'Failed to lookup customer' });
  }
});

module.exports = router;