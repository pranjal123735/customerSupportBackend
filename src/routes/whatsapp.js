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
  // This is where you'd implement your customer support logic
  // For now, a simple echo response
  return `Thank you for your message: "${input}". Our team will assist you shortly.`;
}

module.exports = router;