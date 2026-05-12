const axios = require('axios');
const FormData = require('form-data');

class WhatsAppService {
  constructor() {
    this.accessToken = process.env.WHATSAPP_TOKEN;
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    this.baseUrl = 'https://graph.facebook.com/v18.0';
  }

  async sendTextMessage(to, text) {
    try {
      const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
      
      const data = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      };

      const response = await axios.post(url, data, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      console.log('✅ Text message sent successfully');
      return response.data;
    } catch (error) {
      const errorData = error.response?.data?.error;
      
      // Handle authentication error
      if (errorData?.code === 190) {
        console.error('❌ WhatsApp Token Authentication Error (Code 190)');
        console.error('🔑 Your WHATSAPP_TOKEN has expired or is invalid');
        console.error('📝 Please update WHATSAPP_TOKEN in your .env file');
        console.error('🔗 Get new token from: https://developers.facebook.com/apps/');
        throw new Error('WhatsApp token expired. Please update WHATSAPP_TOKEN in environment variables.');
      }
      
      // Handle 24-hour window error
      if (errorData?.code === 131047 || errorData?.code === 131026) {
        console.error('❌ 24-Hour Window Error (Code 131047)');
        console.error('⏰ More than 24 hours have passed since customer last replied');
        console.error('📋 To send messages outside 24-hour window, you must:');
        console.error('   1. Use a WhatsApp Message Template');
        console.error('   2. Wait for customer to message you first');
        console.error('🔗 Learn more: https://developers.facebook.com/docs/whatsapp/pricing#conversations');
        throw new Error('24-hour messaging window expired. Customer must message first or use template message.');
      }
      
      console.error('❌ Error sending text message:', error.response?.data || error.message);
      throw error;
    }
  }

  async sendVoiceMessage(to, audioBuffer, mimeType = 'audio/ogg') {
    try {
      console.log(`🎵 Preparing to send voice message to ${to}`);
      console.log(`📊 Audio size: ${audioBuffer.length} bytes, MIME: ${mimeType}`);
      
      // First, upload the audio file
      const mediaId = await this.uploadMedia(audioBuffer, mimeType);
      
      // Then send the voice message
      const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
      
      const data = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'audio',
        audio: { id: mediaId }
      };

      const response = await axios.post(url, data, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      console.log('✅ Voice message sent successfully to', to);
      return response.data;
    } catch (error) {
      const errorData = error.response?.data?.error;
      
      // Handle authentication error
      if (errorData?.code === 190) {
        console.error('❌ WhatsApp Token Authentication Error (Code 190)');
        console.error('🔑 Your WHATSAPP_TOKEN has expired or is invalid');
        console.error('📝 Please update WHATSAPP_TOKEN in your .env file');
        throw new Error('WhatsApp token expired. Please update WHATSAPP_TOKEN in environment variables.');
      }
      
      // Handle 24-hour window error
      if (errorData?.code === 131047 || errorData?.code === 131026) {
        console.error('❌ 24-Hour Window Error (Code 131047)');
        console.error('⏰ More than 24 hours have passed since customer last replied');
        console.error('📋 Cannot send voice message outside 24-hour window');
        console.error('💡 Customer must message you first to restart conversation');
        throw new Error('24-hour messaging window expired. Customer must message first.');
      }
      
      console.error('❌ Error sending voice message:', error.response?.data || error.message);
      throw error;
    }
  }

  async uploadMedia(buffer, mimeType) {
    try {
      console.log(`📤 Uploading media to WhatsApp...`);
      console.log(`📊 Size: ${buffer.length} bytes, Type: ${mimeType}`);
      
      const url = `${this.baseUrl}/${this.phoneNumberId}/media`;
      
      // Determine file extension based on MIME type
      let filename = 'audio.ogg';
      if (mimeType === 'audio/mpeg' || mimeType === 'audio/mp3') {
        filename = 'audio.mp3';
      } else if (mimeType === 'audio/wav') {
        filename = 'audio.wav';
      }
      
      const formData = new FormData();
      formData.append('file', buffer, {
        filename: filename,
        contentType: mimeType
      });
      formData.append('type', mimeType);
      formData.append('messaging_product', 'whatsapp');

      const response = await axios.post(url, formData, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          ...formData.getHeaders()
        }
      });

      console.log(`✅ Media uploaded successfully, ID: ${response.data.id}`);
      return response.data.id;
    } catch (error) {
      const errorData = error.response?.data?.error;
      
      // Handle authentication error
      if (errorData?.code === 190) {
        console.error('❌ WhatsApp Token Authentication Error (Code 190)');
        console.error('🔑 Your WHATSAPP_TOKEN has expired or is invalid');
        console.error('📝 Please update WHATSAPP_TOKEN in your .env file');
        throw new Error('WhatsApp token expired. Please update WHATSAPP_TOKEN in environment variables.');
      }
      
      console.error('❌ Error uploading media:', error.response?.data || error.message);
      throw error;
    }
  }

  async getMediaUrl(mediaId) {
    try {
      const url = `${this.baseUrl}/${mediaId}`;
      
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      return response.data.url;
    } catch (error) {
      const errorData = error.response?.data?.error;
      
      if (errorData?.code === 190) {
        console.error('❌ WhatsApp Token Authentication Error (Code 190)');
        console.error('🔑 Your WHATSAPP_TOKEN has expired or is invalid');
        console.error('📝 Please update WHATSAPP_TOKEN in your .env file');
        console.error('🔗 Get new token from: https://developers.facebook.com/apps/');
        throw new Error('WhatsApp token expired. Please update WHATSAPP_TOKEN in environment variables.');
      }
      
      console.error('❌ Error getting media URL:', error.response?.data || error.message);
      throw error;
    }
  }

  async downloadMedia(mediaUrl) {
    try {
      const response = await axios.get(mediaUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        },
        responseType: 'arraybuffer'
      });

      return Buffer.from(response.data);
    } catch (error) {
      console.error('❌ Error downloading media:', error.response?.data || error.message);
      throw error;
    }
  }
}

module.exports = new WhatsAppService();