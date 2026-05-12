const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

const whatsappRoutes = require('./routes/whatsapp');
const voiceRoutes = require('./routes/voice');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/webhook', whatsappRoutes);
app.use('/api/voice', voiceRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Create temp directory if it doesn't exist
const fs = require('fs');
const path = require('path');
const tempDir = path.join(__dirname, '../temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

app.listen(PORT, () => {
  console.log('🚀 WhatsApp Voice Agent Backend running on port ${PORT}');
  console.log('📱 Webhook URL: http://localhost:${PORT}/webhook');
  console.log('🎵 Voice API: http://localhost:${PORT}/api/voice');
  console.log('🧠 RAG System: Active with Knowledge Base');
});

module.exports = app;