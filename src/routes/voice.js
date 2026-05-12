const express = require("express");
const multer = require("multer");
const router = express.Router();
const voiceProcessor = require("../services/voiceProcessor");
const supportAgent = require("../services/customerSupportAgent");

const upload = multer({ storage: multer.memoryStorage() });

// Real STT endpoint - processes actual audio
router.post("/stt", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    console.log("🎤 Received audio file for STT processing:");
    console.log("📊 File info:", {
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size + " bytes",
    });

    // Process the actual audio buffer
    const transcription = await voiceProcessor.speechToText(req.file.buffer);

    console.log("✅ STT Result:", transcription);

    res.json({
      transcription,
      audioInfo: {
        size: req.file.size,
        type: req.file.mimetype,
        originalName: req.file.originalname,
      },
    });
  } catch (error) {
    console.error("❌ STT Error:", error);
    res
      .status(500)
      .json({ error: "Speech to text conversion failed: " + error.message });
  }
});

// Test TTS endpoint
router.post("/tts", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "No text provided" });
    }

    console.log("🔊 Received TTS request for:", text.substring(0, 50) + "...");

    // Generate audio using Piper TTS
    const ttsResult = await voiceProcessor.textToSpeech(text);

    console.log("✅ TTS Result:", {
      filePath: ttsResult.filePath,
      size: ttsResult.buffer.length,
      mimeType: ttsResult.mimeType,
    });

    res.set({
      "Content-Type": ttsResult.mimeType,
      "Content-Length": ttsResult.buffer.length,
      "Content-Disposition": `attachment; filename="audio_${Date.now()}.wav"`,
    });

    // Return both buffer and file path info
    res.json({
      status: "success",
      message: "Audio generated successfully",
      file_path: ttsResult.filePath,
      size: ttsResult.buffer.length,
      mimeType: ttsResult.mimeType,
    });
  } catch (error) {
    console.error("❌ TTS Error:", error);
    res
      .status(500)
      .json({ error: "Text to speech conversion failed: " + error.message });
  }
});

// GET audio file endpoint - download generated audio
router.get("/audio/:filename", (req, res) => {
  try {
    const fs = require("fs");
    const path = require("path");

    const filename = req.params.filename;
    const outputDir = process.env.TTS_OUTPUT_DIR || "./outputs";
    const filePath = path.join(outputDir, filename);

    // Security: Prevent directory traversal attacks
    if (!path.resolve(filePath).startsWith(path.resolve(outputDir))) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.log("❌ Audio file not found:", filePath);
      return res.status(404).json({ error: "Audio file not found" });
    }

    console.log("📥 Serving audio file:", filename);

    res.set({
      "Content-Type": "audio/wav",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (error) {
    console.error("❌ Audio serving error:", error);
    res.status(500).json({ error: "Failed to serve audio file" });
  }
});

// Advanced AI Chat endpoint
router.post("/chat", async (req, res) => {
  try {
    const { message, conversationHistory = [], userId = "default" } = req.body;

    // Handle empty or missing message
    if (!message || message.trim().length === 0) {
      return res.json({
        response:
          "Hello! I'm here to help you with any questions about your orders, returns, billing, or our policies. What can I assist you with today?",
        intent: "greeting",
        entities: {},
        sources: [],
      });
    }

    console.log("🎯 Chat request received:", { message, userId });

    // Use Customer Support Agent
    const result = await supportAgent.handleCustomerMessage(
      message,
      userId,
      conversationHistory,
    );

    console.log(
      "✅ Support agent response:",
      result.response.substring(0, 100) + "...",
    );

    res.json({
      response: result.response,
      action: result.action,
      resolved: result.resolved,
      escalated: result.escalated || false,
      ticketId: result.ticketId,
      intent: "support_agent",
      entities: {},
      sources: ["customer_support_agent"],
    });
  } catch (error) {
    console.error("AI Chat Error:", error);
    res.status(500).json({
      error: "Failed to generate AI response",
      response:
        "I apologize, but I'm having trouble processing your request right now. Please try again.",
      intent: "error",
      entities: {},
      sources: [],
    });
  }
});

// Knowledge base search endpoint (uses MongoDB now, not dummyDatabase)
router.get("/knowledge/search", async (req, res) => {
  try {
    const { q: query } = req.query;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const ragService = require("../services/realRagService");

    // Use vector search instead of dummyDatabase
    const queryEmbedding = await ragService.createEmbedding(query);
    const results = await ragService.vectorSearch(queryEmbedding, 10);

    res.json({
      query,
      results: results.map((r) => ({
        title: r.title,
        content: r.content,
        category: r.category,
        similarity: r.similarity,
      })),
      totalResults: results.length,
    });
  } catch (error) {
    console.error("Knowledge Search Error:", error);
    res.status(500).json({ error: "Failed to search knowledge base" });
  }
});

// Get customer info by email/phone (uses MongoDB now)
router.post("/customer/lookup", async (req, res) => {
  try {
    const { email, phone } = req.body;

    if (!email && !phone) {
      return res.status(400).json({ error: "Email or phone required" });
    }

    const { MongoClient } = require("mongodb");
    const client = new MongoClient(process.env.MONGODB_URI);

    await client.connect();
    const db = client.db("ecommerce_rag");

    let customer = null;
    let orders = [];

    if (email) {
      customer = await db.collection("customers").findOne({ email });
    } else if (phone) {
      customer = await db.collection("customers").findOne({ phone });
    }

    if (customer) {
      orders = await db
        .collection("orders")
        .find({ customer_id: customer.id })
        .sort({ id: -1 })
        .limit(10)
        .toArray();
    }

    await client.close();

    res.json({
      customer,
      orders,
      found: !!customer,
    });
  } catch (error) {
    console.error("Customer Lookup Error:", error);
    res.status(500).json({ error: "Failed to lookup customer" });
  }
});

module.exports = router;
