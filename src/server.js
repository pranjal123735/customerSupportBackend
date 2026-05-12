const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
require("dotenv").config();

const whatsappRoutes = require("./routes/whatsapp");
const voiceRoutes = require("./routes/voice");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan("combined"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/webhook", whatsappRoutes);
app.use("/api/voice", voiceRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// Create temp directory if it doesn't exist
const fs = require("fs");
const path = require("path");
const tempDir = path.join(__dirname, "../temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Create outputs directory for TTS if it doesn't exist
const outputsDir =
  process.env.TTS_OUTPUT_DIR || path.join(__dirname, "../outputs");
if (!fs.existsSync(outputsDir)) {
  fs.mkdirSync(outputsDir, { recursive: true });
  console.log(`📁 Created TTS output directory: ${outputsDir}`);
}

// Check Piper model files on startup
const piperModelPath =
  process.env.PIPER_MODEL_PATH || "./models/piper/en_US-lessac-medium.onnx";
const piperConfigPath =
  process.env.PIPER_CONFIG_PATH ||
  "./models/piper/en_US-lessac-medium.onnx.json";

console.log("\n🚀 Startup Health Checks:");

if (!fs.existsSync(piperModelPath)) {
  console.warn(`⚠️ Piper TTS model not found: ${piperModelPath}`);
  console.warn("   TTS will fail until model files are available.");
  console.warn(
    "   Download from: https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US",
  );
} else {
  console.log(`✅ Piper TTS model found: ${piperModelPath}`);
}

if (!fs.existsSync(piperConfigPath)) {
  console.warn(`⚠️ Piper config not found: ${piperConfigPath}`);
} else {
  console.log(`✅ Piper config found: ${piperConfigPath}`);
}

// Verify Whisper model will be available (lazy loaded from HuggingFace)
console.log(
  `✅ Whisper STT ready (${process.env.WHISPER_MODEL_SIZE || "base"} model)`,
);
console.log(
  "   Note: Whisper model will auto-download on first use (~300MB for base)",
);

app.listen(PORT, () => {
  console.log("🚀 WhatsApp Voice Agent Backend running on port ${PORT}");
  console.log("📱 Webhook URL: http://localhost:${PORT}/webhook");
  console.log("🎵 Voice API: http://localhost:${PORT}/api/voice");
  console.log("🧠 RAG System: Active with Knowledge Base");
});

module.exports = app;
