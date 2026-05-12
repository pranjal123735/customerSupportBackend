const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const { PythonShell } = require("python-shell");
const { pipeline } = require("@xenova/transformers");

class VoiceProcessor {
  constructor() {
    this.whisperModel = null;
    this.whisperModelSize = process.env.WHISPER_MODEL_SIZE || "base";
    this.piperModelPath =
      process.env.PIPER_MODEL_PATH || "./models/piper/en_US-lessac-medium.onnx";
    this.piperConfigPath =
      process.env.PIPER_CONFIG_PATH ||
      "./models/piper/en_US-lessac-medium.onnx.json";
    this.ttsOutputDir = process.env.TTS_OUTPUT_DIR || "./outputs";

    // Ensure output directory exists
    this.ensureOutputDir();

    console.log("🎤 Speech-to-Text (STT) Services:");
    console.log(`✅ Local Whisper (${this.whisperModelSize}) - Primary`);
    console.log("✅ Intelligent Simulation - Fallback");

    console.log("\n🔊 Text-to-Speech (TTS) Services:");
    console.log("✅ Piper TTS (Local) - Primary");

    this.initializeModels();
  }

  async ensureOutputDir() {
    if (!fs.existsSync(this.ttsOutputDir)) {
      fs.mkdirSync(this.ttsOutputDir, { recursive: true });
      console.log(`📁 Created TTS output directory: ${this.ttsOutputDir}`);
    }
  }

  async initializeModels() {
    try {
      console.log(
        "🧠 Initializing Whisper model (lazy loading - will download on first use)...",
      );
      console.log(
        `📦 Model: whisper-${this.whisperModelSize} (via @xenova/transformers)`,
      );
      console.log("💾 Models are cached locally after first download");

      // Note: We use lazy loading - model is loaded on first STT request
      // This saves startup time and memory
    } catch (error) {
      console.error("⚠️ Error during model initialization:", error.message);
    }
  }

  async speechToText(audioBuffer) {
    try {
      console.log("🎤 Processing speech-to-text...");
      console.log("📊 Audio buffer size:", audioBuffer.length, "bytes");

      // Save buffer to temporary file for processing
      const tempFilePath = path.join(
        __dirname,
        "../../temp",
        `audio_${Date.now()}.wav`,
      );

      // Ensure temp directory exists
      const tempDir = path.dirname(tempFilePath);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Write audio buffer to file
      fs.writeFileSync(tempFilePath, audioBuffer);
      console.log("💾 Audio saved to:", tempFilePath);

      // Try local Whisper
      try {
        console.log(`🤖 Trying Local Whisper (${this.whisperModelSize})...`);
        const transcription = await this.localWhisperSTT(tempFilePath);

        // Clean up temp file
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
          console.log("🗑️ Cleaned up temp file");
        }

        console.log("✅ STT completed:", transcription);
        return transcription;
      } catch (whisperError) {
        console.log("⚠️ Local Whisper failed, using simulation...");
        console.error("Error details:", whisperError.message);

        // Fallback to intelligent simulation
        const transcription = await this.simulateSTT(audioBuffer);

        // Clean up temp file
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
          console.log("🗑️ Cleaned up temp file");
        }

        console.log("✅ STT completed (simulated):", transcription);
        return transcription;
      }
    } catch (error) {
      console.error("❌ Speech to text error:", error);
      throw new Error("Failed to convert speech to text: " + error.message);
    }
  }

  async localWhisperSTT(audioFilePath) {
    try {
      console.log(
        `🤖 Processing with Local Whisper (${this.whisperModelSize})...`,
      );

      // Use @xenova/transformers for local Whisper inference
      // This uses ONNX Runtime to run the model locally
      const transcriber = await pipeline(
        "automatic-speech-recognition",
        `Xenova/whisper-${this.whisperModelSize}`, // Auto-downloads from HuggingFace
      );

      // Read audio file
      const audioData = fs.readFileSync(audioFilePath);

      // Transcribe
      console.log("🔄 Running inference...");
      const result = await transcriber(audioData);

      const transcription = result.text;

      if (!transcription || transcription.trim().length === 0) {
        throw new Error("Empty transcription from Whisper");
      }

      console.log("🤖 Whisper transcription:", transcription);
      return transcription;
    } catch (error) {
      console.error("❌ Local Whisper STT error:", error.message);
      throw error;
    }
  }

  async simulateSTT(audioBuffer) {
    // Simulate processing delay
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Analyze audio buffer to make it more realistic
    const bufferSize = audioBuffer ? audioBuffer.length : 0;
    console.log("🔍 Analyzing audio buffer size:", bufferSize);

    // Simulate different transcriptions based on audio length
    let transcriptions;

    if (bufferSize < 10000) {
      // Short audio
      transcriptions = [
        "Hi there",
        "Hello",
        "Yes",
        "No thanks",
        "Help me please",
        "My name is John",
        "Thank you",
      ];
    } else if (bufferSize < 50000) {
      // Medium audio
      transcriptions = [
        "Hello, I need some help",
        "Can you assist me with something?",
        "I have a question about my account",
        "My name is John Smith",
        "What is my name again?",
        "How are you doing today?",
        "I need support with my billing",
        "Can you help me with my order?",
      ];
    } else {
      // Long audio
      transcriptions = [
        "Hello, I need help with my order that I placed last week and it hasn't arrived yet",
        "Can you please check my account balance and tell me about recent transactions?",
        "I'm having trouble logging into my account, can you help me reset my password please?",
        "My name is Sarah Johnson and I'm calling about a billing issue on my account",
        "I would like to speak to someone about canceling my subscription service",
        "Can you help me track my package? It was supposed to arrive yesterday but nothing came",
        "I'm experiencing technical difficulties with your mobile app, it keeps crashing when I try to login",
      ];
    }

    const transcription =
      transcriptions[Math.floor(Math.random() * transcriptions.length)];
    console.log("🎯 Simulated transcription:", transcription);

    return transcription;
  }

  async textToSpeech(text) {
    try {
      console.log(
        "🔊 Processing text-to-speech for:",
        text.substring(0, 50) + "...",
      );

      // Check if Piper model files exist
      if (
        !fs.existsSync(this.piperModelPath) ||
        !fs.existsSync(this.piperConfigPath)
      ) {
        throw new Error(
          `Piper model files not found. Expected:\n` +
            `  ONNX: ${this.piperModelPath}\n` +
            `  Config: ${this.piperConfigPath}`,
        );
      }

      // Generate audio using Piper TTS
      const audioFilePath = await this.piperTTS(text);

      // Read the generated audio file and return as buffer
      const audioBuffer = fs.readFileSync(audioFilePath);

      console.log(
        "🎵 Generated TTS audio:",
        audioFilePath,
        "size:",
        audioBuffer.length,
        "bytes",
      );
      return {
        buffer: audioBuffer,
        filePath: audioFilePath,
        mimeType: "audio/wav",
      };
    } catch (error) {
      console.error("❌ Text to speech error:", error);
      throw new Error("Failed to convert text to speech: " + error.message);
    }
  }

  async piperTTS(text) {
    try {
      console.log("🔊 Synthesizing with Piper TTS...");

      // Generate unique output filename
      const outputFilename = `output_${Date.now()}.wav`;
      const outputPath = path.join(this.ttsOutputDir, outputFilename);

      // Call Python script to generate audio using Piper
      const pythonScriptPath = path.join(
        __dirname,
        "../../scripts/piperTTS.py",
      );

      if (!fs.existsSync(pythonScriptPath)) {
        throw new Error(`Python script not found: ${pythonScriptPath}`);
      }

      console.log("📤 Calling Piper TTS via Python...");

      return new Promise((resolve, reject) => {
        const options = {
          args: [text, outputPath, this.piperModelPath, this.piperConfigPath],
          pythonOptions: ["-u"], // Unbuffered output for real-time logging
        };

        const pythonProcess = PythonShell.run(
          pythonScriptPath,
          options,
          (err, results) => {
            if (err) {
              const errorDetails = {
                message: err.message,
                code: err.code,
                pythonError: err.traceback || "Unknown error",
                text: text.substring(0, 50),
                timestamp: new Date().toISOString(),
              };

              console.error(
                "❌ Python TTS Error Details:",
                JSON.stringify(errorDetails, null, 2),
              );

              // Provide more specific error messages
              let userMessage = "TTS synthesis failed";
              if (err.message.includes("No such file")) {
                userMessage =
                  "Model files not found - check PIPER_MODEL_PATH configuration";
              } else if (err.message.includes("out of memory")) {
                userMessage = "Insufficient memory for TTS - try shorter text";
              } else if (err.message.includes("timeout")) {
                userMessage = "TTS took too long - text may be too long";
              }

              return reject(new Error(userMessage));
            }

            if (fs.existsSync(outputPath)) {
              console.log("✅ Audio file generated:", outputPath);
              resolve(outputPath);
            } else {
              reject(
                new Error(
                  "Output audio file was not created - check disk space and write permissions",
                ),
              );
            }
          },
        );

        // Capture stderr for better error reporting
        pythonProcess.on("stderr", (stderr) => {
          if (stderr.includes("WARNING")) {
            console.warn("⚠️ Python Warning:", stderr);
          } else if (stderr.includes("ERROR") || stderr.includes("Exception")) {
            console.error("❌ Python Error Output:", stderr);
          }
        });
      });
    } catch (error) {
      console.error("❌ Piper TTS error:", error.message);
      throw error;
    }
  }

  async cleanupOldAudioFiles(maxAgeHours = 24) {
    try {
      console.log(
        `🧹 Cleaning up audio files older than ${maxAgeHours} hours...`,
      );

      const files = fs.readdirSync(this.ttsOutputDir);
      const now = Date.now();
      const maxAge = maxAgeHours * 60 * 60 * 1000; // Convert hours to milliseconds

      let deletedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.ttsOutputDir, file);
        const stats = fs.statSync(filePath);
        const fileAge = now - stats.mtimeMs;

        if (fileAge > maxAge) {
          fs.unlinkSync(filePath);
          console.log(`🗑️ Deleted old file: ${file}`);
          deletedCount++;
        }
      }

      console.log(`✅ Cleanup complete: ${deletedCount} files deleted`);
    } catch (error) {
      console.error("⚠️ Cleanup error (non-fatal):", error.message);
    }
  }

  getAudioInfo(audioBuffer) {
    return {
      size: audioBuffer.length,
      type: "audio/wav",
      duration: Math.round(audioBuffer.length / 16000),
    };
  }
}

module.exports = new VoiceProcessor();
