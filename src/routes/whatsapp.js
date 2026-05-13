const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsappService');
const voiceProcessor = require('../services/voiceProcessor');
const advancedMemory = require('../services/advancedConversationMemory');

// Webhook verification (GET)
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Webhook verification failed');
    res.status(403).send('Forbidden');
  }
});

// Webhook for incoming messages (POST)
router.post('/', async (req, res) => {
  try {
    const body = req.body;
    
    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      
      if (value?.messages) {
        for (const message of value.messages) {
          await handleIncomingMessage(message, value);
        }
      }
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Error');
  }
});

async function handleIncomingMessage(message, value) {
  try {
    const from = message.from;
    const messageId = message.id;
    
    console.log(`📨 Received message from ${from}: ${messageId}`);
    
    // Handle voice messages
    if (message.type === 'audio') {
      const audioId = message.audio.id;
      console.log(`🎵 Processing voice message: ${audioId}`);
      
      try {
        // Download and process voice message
        console.log(`📥 Downloading audio from WhatsApp...`);
        const audioUrl = await whatsappService.getMediaUrl(audioId);
        const audioBuffer = await whatsappService.downloadMedia(audioUrl);
        console.log(`✅ Audio downloaded: ${audioBuffer.length} bytes`);
        
        // Convert speech to text
        console.log(`🎤 Converting speech to text...`);
        const transcription = await voiceProcessor.speechToText(audioBuffer);
        console.log(`📝 Transcription: "${transcription}"`);
        
        // Process customer request and generate response
        console.log(`🤖 Processing customer request...`);
        const response = await processCustomerRequest(transcription, from);
        console.log(`✅ AI Response: "${response.substring(0, 100)}..."`);
        
        // Convert response to speech and send back
        console.log(`🔊 Converting response to speech...`);
        const audioResponse = await voiceProcessor.textToSpeech(response);
        
        // Extract buffer and MIME type from TTS response object
        const audioBufferResponse = audioResponse.buffer || audioResponse;
        const mimeType = audioResponse.mimeType || 'audio/mpeg';
        console.log(`✅ Audio generated: ${audioBufferResponse.length} bytes, ${mimeType}`);
        
        // Send voice message back
        console.log(`📤 Sending voice response to WhatsApp...`);
        await whatsappService.sendVoiceMessage(from, audioBufferResponse, mimeType);
        console.log(`✅ Voice response sent to ${from}`);
      } catch (error) {
        console.error(`❌ Error processing voice message: ${error.message}`);
        console.error(error.stack);
        // Send text fallback if voice fails
        const fallbackResponse = "I apologize, but I'm having trouble processing your voice message. Please try again or send a text message.";
        await whatsappService.sendTextMessage(from, fallbackResponse);
      }
      
    } else if (message.type === 'text') {
      // Handle text messages as fallback
      const text = message.text.body;
      console.log(`💬 Text message: ${text}`);
      
      try {
        const response = await processCustomerRequest(text, from);
        await whatsappService.sendTextMessage(from, response);
        console.log(`✅ Text response sent to ${from}`);
      } catch (error) {
        console.error(`❌ Error processing text message: ${error.message}`);
        const fallbackResponse = "I apologize, but I'm having trouble processing your request. Please try again.";
        await whatsappService.sendTextMessage(from, fallbackResponse);
      }
    }
    
  } catch (error) {
    console.error('Error handling message:', error);
  }
}

async function processCustomerRequest(input, customerPhone) {
  try {
    // Import customer support agent
    const customerSupportAgent = require('../services/customerSupportAgent');
    
    console.log(`🤖 Processing request from ${customerPhone}: "${input}"`);
    
    // Wait for agent to be initialized
    await customerSupportAgent.waitForInitialization();
    
    // Get conversation history for this user
    const conversationHistory = await advancedMemory.getHistory(customerPhone);
    const stats = await advancedMemory.getStats(customerPhone);
    
    console.log(`📚 Conversation: ${stats.totalMessages} total messages (${stats.messageCount} recent, ${stats.summaryCount} summaries)`);
    console.log(`🎯 Context: Orders [${stats.orderIds.join(', ')}], Sentiment: ${stats.currentSentiment}, Unresolved: ${stats.unresolvedIssues}`);
    
    // Use the AI customer support agent to generate response
    const aiResponse = await customerSupportAgent.handleCustomerMessage(input, customerPhone, conversationHistory);
    
    // Extract the response text from the AI response object
    let responseText;
    if (typeof aiResponse === 'string') {
      responseText = aiResponse;
    } else if (aiResponse && aiResponse.response) {
      responseText = aiResponse.response;
    } else if (aiResponse && aiResponse.text) {
      responseText = aiResponse.text;
    } else {
      responseText = JSON.stringify(aiResponse);
    }
    
    // Add both user message and agent response to advanced memory
    await advancedMemory.addMessage(customerPhone, 'user', input);
    await advancedMemory.addMessage(customerPhone, 'assistant', responseText);
    
    console.log(`✅ Generated response: "${responseText}"`);
    
    return responseText;
  } catch (error) {
    console.error('❌ Error processing customer request:', error);
    // Fallback response if AI fails
    return "I apologize, but I'm having trouble processing your request right now. Please try again in a moment or contact our support team.";
  }
}

// New endpoint for Railway webhook service to forward messages
router.post('/message', async (req, res) => {
  try {
    // Verify API key for security
    const apiKey = req.headers.authorization?.replace('Bearer ', '');
    if (apiKey !== process.env.BACKEND_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const messageData = req.body;
    console.log('📥 Received message from webhook service:', messageData);

    // Process the message based on type
    if (messageData.type === 'text') {
      try {
        const response = await processCustomerRequest(messageData.text, messageData.from);
        await whatsappService.sendTextMessage(messageData.from, response);
        console.log(`✅ Text response sent via webhook service`);
      } catch (error) {
        console.error(`❌ Error processing text message: ${error.message}`);
        const fallbackResponse = "I apologize, but I'm having trouble processing your request. Please try again.";
        await whatsappService.sendTextMessage(messageData.from, fallbackResponse);
      }
    } else if (messageData.type === 'audio') {
      try {
        console.log(`🎵 Processing voice message from webhook service...`);
        
        // Download and process audio
        const audioUrl = await whatsappService.getMediaUrl(messageData.audio.id);
        const audioBuffer = await whatsappService.downloadMedia(audioUrl);
        console.log(`✅ Audio downloaded: ${audioBuffer.length} bytes`);
        
        // Convert speech to text
        console.log(`🎤 Converting speech to text...`);
        const transcription = await voiceProcessor.speechToText(audioBuffer);
        console.log(`📝 Transcription: "${transcription}"`);
        
        // Detect language using Gemini
        console.log(`🌍 Detecting language with Gemini...`);
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
        const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' });
        
        // First check script - if Devanagari characters present, it's Hindi
        const hasDevanagari = /[\u0900-\u097F]/.test(transcription);
        let detectedLanguage = 'english';
        
        if (hasDevanagari) {
          detectedLanguage = 'hindi';
          console.log(`🌍 Detected language: hindi (Devanagari script found)`);
        } else {
          // Only use Gemini if no Devanagari - check if it's Hinglish
          const languageDetectionPrompt = `Is this text in Hindi/Hinglish or English? Return ONLY "hindi" or "english":

Text: "${transcription}"

Return ONLY one word: english or hindi`;

          const languageResult = await model.generateContent(languageDetectionPrompt);
          detectedLanguage = languageResult.response.text().trim().toLowerCase();
          console.log(`🌍 Detected language: ${detectedLanguage} (via Gemini)`);
        }
        
        // Process customer request
        console.log(`🤖 Processing customer request...`);
        const response = await processCustomerRequest(transcription, messageData.from);
        console.log(`✅ AI Response: "${response.substring(0, 100)}..."`);
        
        // Translate response to match input language using Gemini
        console.log(`🔄 Translating response to ${detectedLanguage}...`);
        let finalResponse = response;
        
        if (detectedLanguage === 'hindi') {
          const translationPrompt = `Translate this English text to natural Hindi/Hinglish (mix of Hindi and English):

English text: "${response}"

Return ONLY the Hindi/Hinglish translation:`;

          const translationResult = await model.generateContent(translationPrompt);
          finalResponse = translationResult.response.text().trim();
          console.log(`✅ Translated to Hindi: "${finalResponse.substring(0, 100)}..."`);
        }
        
        // Convert response to speech
        console.log(`🔊 Converting response to speech...`);
        const audioResponse = await voiceProcessor.textToSpeech(finalResponse);
        
        // Extract buffer and MIME type from TTS response object
        const audioBufferResponse = audioResponse.buffer || audioResponse;
        const mimeType = audioResponse.mimeType || 'audio/mpeg';
        console.log(`✅ Audio generated: ${audioBufferResponse.length} bytes, ${mimeType}`);
        
        // Send voice message back
        console.log(`📤 Sending voice response to WhatsApp...`);
        await whatsappService.sendVoiceMessage(messageData.from, audioBufferResponse, mimeType);
        console.log(`✅ Voice response sent via webhook service`);
      } catch (error) {
        console.error(`❌ Error processing voice message: ${error.message}`);
        console.error(error.stack);
        const fallbackResponse = "I apologize, but I'm having trouble processing your voice message. Please try again or send a text message.";
        await whatsappService.sendTextMessage(messageData.from, fallbackResponse);
      }
    }

    res.status(200).json({ success: true, message: 'Message processed' });
  } catch (error) {
    console.error('❌ Error processing forwarded message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;