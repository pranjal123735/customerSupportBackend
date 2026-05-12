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
      console.error('❌ Error sending text message:', error.response?.data || error.message);
      throw error;
    }
  }

  async sendVoiceMessage(to, audioBuffer) {
    try {
      // First, upload the audio file
      const mediaId = await this.uploadMedia(audioBuffer, 'audio/ogg');
      
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

      console.log('🎵 Voice message sent successfully');
      return response.data;
    } catch (error) {
      console.error('❌ Error sending voice message:', error.response?.data || error.message);
      throw error;
    }
  }

  async uploadMedia(buffer, mimeType) {
    try {
      const url = `${this.baseUrl}/${this.phoneNumberId}/media`;
      
      const formData = new FormData();
      formData.append('file', buffer, {
        filename: 'audio.ogg',
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

      return response.data.id;
    } catch (error) {
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