const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsappService');
const voiceProcessor = require('../services/voiceProcessor');

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
      
      // Download and process voice message
      const audioUrl = await whatsappService.getMediaUrl(audioId);
      const audioBuffer = await whatsappService.downloadMedia(audioUrl);
      
      // Convert speech to text
      const transcription = await voiceProcessor.speechToText(audioBuffer);
      console.log(`📝 Transcription: ${transcription}`);
      
      // Process customer request and generate response
      const response = await processCustomerRequest(transcription, from);
      
      // Convert response to speech and send back
      const audioResponse = await voiceProcessor.textToSpeech(response);
      await whatsappService.sendVoiceMessage(from, audioResponse);
      
    } else if (message.type === 'text') {
      // Handle text messages as fallback
      const text = message.text.body;
      console.log(`💬 Text message: ${text}`);
      
      const response = await processCustomerRequest(text, from);
      await whatsappService.sendTextMessage(from, response);
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
    
    // Use the AI customer support agent to generate response
    const response = await customerSupportAgent.processMessage(input, customerPhone);
    
    console.log(`✅ Generated response: "${response}"`);
    
    return response;
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
      const response = await processCustomerRequest(messageData.text, messageData.from);
      await whatsappService.sendTextMessage(messageData.from, response);
    } else if (messageData.type === 'audio') {
      // Download and process audio
      const audioUrl = await whatsappService.getMediaUrl(messageData.audio.id);
      const audioBuffer = await whatsappService.downloadMedia(audioUrl);
      const transcription = await voiceProcessor.speechToText(audioBuffer);
      
      const response = await processCustomerRequest(transcription, messageData.from);
      const audioResponse = await voiceProcessor.textToSpeech(response);
      await whatsappService.sendVoiceMessage(messageData.from, audioResponse);
    }

    res.status(200).json({ success: true, message: 'Message processed' });
  } catch (error) {
    console.error('❌ Error processing forwarded message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;