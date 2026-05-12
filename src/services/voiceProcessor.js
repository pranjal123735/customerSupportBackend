const fs = require("fs");
const path = require("path");
const { PythonShell } = require("python-shell");
const { pipeline } = require("@xenova/transformers");
const wav = require("wav");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const { ElevenLabsClient } = require("elevenlabs");
const { AssemblyAI } = require("assemblyai");
const textToSpeech = require("@google-cloud/text-to-speech");
const speech = require("@google-cloud/speech");
const axios = require("axios");
const FormData = require("form-data");

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

class VoiceProcessor {
  constructor() {
    this.whisperModel = null;
    this.whisperModelSize = process.env.WHISPER_MODEL_SIZE || "small";
    this.piperModelPath =
      process.env.PIPER_MODEL_PATH || "./models/piper/en_US-lessac-medium.onnx";
    this.piperConfigPath =
      process.env.PIPER_CONFIG_PATH ||
      "./models/piper/en_US-lessac-medium.onnx.json";
    this.ttsOutputDir = process.env.TTS_OUTPUT_DIR || "./outputs";
    
    // Google Cloud configuration
    this.googleCloudApiKey = process.env.GOOGLE_CLOUD_TTS_API_KEY;
    this.googleCloudSTTClient = null;
    this.googleCloudTTSClient = null;
    
    // AssemblyAI configuration
    this.assemblyAIApiKey = process.env.ASSEMBLYAI_API_KEY;
    this.assemblyAIClient = null;
    
    // ElevenLabs configuration
    this.elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
    this.elevenLabsClient = null;
    
    // Initialize Google Cloud STT if API key is available
    if (this.googleCloudApiKey) {
      this.googleCloudSTTClient = new speech.SpeechClient({
        apiKey: this.googleCloudApiKey,
      });
      console.log("🎤 Speech-to-Text (STT) Services:");
      console.log("✅ Google Cloud STT - Primary (Fast & Accurate)");
      if (this.assemblyAIApiKey) {
        this.assemblyAIClient = new AssemblyAI({
          apiKey: this.assemblyAIApiKey,
        });
        console.log("✅ AssemblyAI STT - Secondary");
      }
      console.log(`✅ Local Whisper (${this.whisperModelSize}) - Fallback`);
      console.log("🌍 Multi-language Support: Auto-detect (125+ languages)");
    } else if (this.assemblyAIApiKey) {
      this.assemblyAIClient = new AssemblyAI({
        apiKey: this.assemblyAIApiKey,
      });
      console.log("🎤 Speech-to-Text (STT) Services:");
      console.log("✅ AssemblyAI STT - Primary (High Accuracy)");
      console.log(`✅ Local Whisper (${this.whisperModelSize}) - Fallback`);
      console.log("🌍 Multi-language Support: Auto-detect (99 languages)");
    } else {
      console.log("🎤 Speech-to-Text (STT) Services:");
      console.log(`✅ Local Whisper (${this.whisperModelSize}) - Real Transcription`);
      console.log("🌍 Multi-language Support: Auto-detect (99 languages)");
    }
    
    // Initialize Google Cloud TTS if API key is available
    if (this.googleCloudApiKey) {
      this.googleCloudTTSClient = new textToSpeech.TextToSpeechClient({
        apiKey: this.googleCloudApiKey,
      });
      console.log("\n🔊 Text-to-Speech (TTS) Services:");
      console.log("✅ Google Cloud TTS - Primary (Multi-language, Neural Voices)");
      console.log("✅ Piper TTS (Local) - Fallback");
    } else if (this.elevenLabsApiKey) {
      this.elevenLabsClient = new ElevenLabsClient({
        apiKey: this.elevenLabsApiKey,
      });
      console.log("\n🔊 Text-to-Speech (TTS) Services:");
      console.log(`✅ ElevenLabs TTS (Voice: ${this.elevenLabsVoiceId}) - Primary`);
      console.log("✅ Piper TTS (Local) - Fallback");
    } else {
      console.log("\n🔊 Text-to-Speech (TTS) Services:");
      console.log("✅ Piper TTS (Local) - High Quality Voice");
    }

    // Ensure output directory exists
    this.ensureOutputDir();
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

      // Validate audio buffer
      if (!audioBuffer || audioBuffer.length === 0) {
        throw new Error("Audio buffer is empty");
      }

      if (audioBuffer.length < 1000) {
        console.warn("⚠️ Audio buffer is very small (<1KB) - may result in poor transcription");
      }

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

      // Convert audio to proper WAV format (16kHz, mono, PCM) for cloud services
      let convertedFilePath = tempFilePath;
      try {
        console.log("🔄 Converting audio to 16kHz WAV format...");
        convertedFilePath = await this.convertAudioToWav(tempFilePath);
        console.log("✅ Audio converted successfully");
      } catch (conversionError) {
        console.log("⚠️ Audio conversion failed, using original file...");
        console.error("Conversion error:", conversionError.message);
      }

      // Try Google Cloud STT first if available
      if (this.googleCloudSTTClient) {
        try {
          console.log("🎤 Trying Google Cloud STT...");
          const result = await this.googleCloudSTT(convertedFilePath);

          // Clean up temp files
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }
          if (convertedFilePath !== tempFilePath && fs.existsSync(convertedFilePath)) {
            fs.unlinkSync(convertedFilePath);
          }
          console.log("🗑️ Cleaned up temp files");

          console.log("✅ STT completed (Google Cloud):", result);
          return result;
        } catch (googleCloudError) {
          console.log("⚠️ Google Cloud STT failed, trying AssemblyAI...");
          console.error("Error details:", googleCloudError.message);
        }
      }

      // Try AssemblyAI STT if available
      if (this.assemblyAIClient) {
        try {
          console.log("🎤 Trying AssemblyAI STT...");
          const result = await this.assemblyAISTT(convertedFilePath);

          // Clean up temp files
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }
          if (convertedFilePath !== tempFilePath && fs.existsSync(convertedFilePath)) {
            fs.unlinkSync(convertedFilePath);
          }
          console.log("🗑️ Cleaned up temp files");

          console.log("✅ STT completed (AssemblyAI):", result);
          return result;
        } catch (assemblyAIError) {
          console.log("⚠️ AssemblyAI STT failed, trying local Whisper...");
          console.error("Error details:", assemblyAIError.message);
        }
      }

      // Fallback to local Whisper
      console.log(`🤖 Trying Local Whisper (${this.whisperModelSize})...`);
      const result = await this.localWhisperSTT(convertedFilePath);

      // Clean up temp files
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
      if (convertedFilePath !== tempFilePath && fs.existsSync(convertedFilePath)) {
        fs.unlinkSync(convertedFilePath);
      }
      console.log("🗑️ Cleaned up temp files");

      // Check confidence threshold
      if (result.confidence && result.confidence < 0.6) {
        console.warn(`⚠️ Low confidence transcription (${(result.confidence * 100).toFixed(1)}%)`);
        console.warn(`📝 Transcription: "${result.text}"`);
        // Still return it, but log the warning
      }

      console.log("✅ STT completed:", result.text);
      return result.text;
    } catch (error) {
      console.error("❌ Speech to text error:", error);
      throw new Error("Failed to convert speech to text: " + error.message);
    }
  }

  async googleCloudSTT(audioFilePath) {
    try {
      console.log("🎤 Processing with Google Cloud STT...");
      const startTime = Date.now();

      // Read the audio file
      const audioBytes = fs.readFileSync(audioFilePath).toString('base64');

      // Configure request
      const request = {
        audio: {
          content: audioBytes,
        },
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          languageCode: 'en-US',
          alternativeLanguageCodes: ['hi-IN', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP', 'zh-CN', 'ar-XA'],
          enableAutomaticPunctuation: true,
          model: 'latest_long',
        },
      };

      // Call Google Cloud Speech-to-Text API
      const [response] = await this.googleCloudSTTClient.recognize(request);

      const endTime = Date.now();
      const duration = endTime - startTime;

      if (!response.results || response.results.length === 0) {
        throw new Error("No transcription results from Google Cloud STT");
      }

      const transcription = response.results
        .map(result => result.alternatives[0].transcript)
        .join('\n')
        .trim();

      if (!transcription || transcription.length === 0) {
        throw new Error("Empty transcription from Google Cloud STT");
      }

      const confidence = response.results[0].alternatives[0].confidence || 0;
      const detectedLanguage = response.results[0].languageCode || 'unknown';

      console.log(`🎤 Google Cloud STT transcription: "${transcription}"`);
      console.log(`🌍 Detected language: ${detectedLanguage}`);
      console.log(`📊 Confidence: ${(confidence * 100).toFixed(1)}%`);
      console.log(`⏱️ Processing time: ${duration}ms`);

      return transcription;
    } catch (error) {
      console.error("❌ Google Cloud STT error:", error.message);
      throw error;
    }
  }

  async assemblyAISTT(audioFilePath) {
    try {
      console.log("🎤 Processing with AssemblyAI STT...");
      const startTime = Date.now();

      // Upload file and transcribe
      const transcript = await this.assemblyAIClient.transcripts.transcribe({
        audio: audioFilePath,
        language_detection: true, // Auto-detect language
      });

      const endTime = Date.now();
      const duration = endTime - startTime;

      console.log("📝 AssemblyAI response:", transcript);

      if (transcript.status === 'error') {
        throw new Error(`AssemblyAI error: ${transcript.error}`);
      }

      if (!transcript.text || transcript.text.trim().length === 0) {
        throw new Error("Empty transcription from AssemblyAI");
      }

      const transcription = transcript.text.trim();
      const detectedLanguage = transcript.language_code || 'unknown';
      const confidence = transcript.confidence || 0;

      console.log(`🎤 AssemblyAI transcription: "${transcription}"`);
      console.log(`🌍 Detected language: ${detectedLanguage}`);
      console.log(`📊 Confidence: ${(confidence * 100).toFixed(1)}%`);
      console.log(`⏱️ Processing time: ${duration}ms`);

      return transcription;
    } catch (error) {
      console.error("❌ AssemblyAI STT error:", error.message);
      throw error;
    }
  }

  async readAudioFile(audioFilePath) {
    return new Promise((resolve, reject) => {
      try {
        console.log("📖 Reading audio file:", audioFilePath);
        
        // Check if file is WAV format
        const fileBuffer = fs.readFileSync(audioFilePath);
        const isWav = fileBuffer.toString('utf8', 0, 4) === 'RIFF';
        
        if (!isWav) {
          console.log("⚠️ Audio file is not WAV format, needs conversion");
          reject(new Error("Audio file must be converted to WAV format first"));
          return;
        }
        
        // Create a WAV reader
        const reader = new wav.Reader();
        const audioChunks = [];
        
        reader.on('format', (format) => {
          console.log("🎵 Audio format:", format);
          // format contains: audioFormat, channels, sampleRate, byteRate, blockAlign, bitDepth
        });
        
        reader.on('data', (chunk) => {
          audioChunks.push(chunk);
        });
        
        reader.on('end', () => {
          try {
            // Concatenate all chunks
            const audioBuffer = Buffer.concat(audioChunks);
            
            // Convert Buffer to Float32Array
            // WAV files are typically 16-bit PCM, so we need to convert to float32 [-1, 1]
            const float32Array = new Float32Array(audioBuffer.length / 2);
            
            for (let i = 0; i < float32Array.length; i++) {
              // Read 16-bit signed integer (little-endian)
              const int16 = audioBuffer.readInt16LE(i * 2);
              // Convert to float32 in range [-1, 1]
              float32Array[i] = int16 / 32768.0;
            }
            
            console.log(`✅ Audio converted: ${float32Array.length} samples`);
            resolve(float32Array);
          } catch (conversionError) {
            reject(new Error(`Audio conversion failed: ${conversionError.message}`));
          }
        });
        
        reader.on('error', (error) => {
          reject(new Error(`WAV reader error: ${error.message}`));
        });
        
        // Read the file and pipe to WAV reader
        const fileStream = fs.createReadStream(audioFilePath);
        fileStream.on('error', (error) => {
          reject(new Error(`File read error: ${error.message}`));
        });
        
        fileStream.pipe(reader);
        
      } catch (error) {
        reject(new Error(`Failed to read audio file: ${error.message}`));
      }
    });
  }

  async convertAudioToWav(inputPath) {
    return new Promise((resolve, reject) => {
      const outputPath = inputPath.replace(/\.\w+$/, '_converted.wav');
      
      console.log("🔄 Converting audio to WAV format...");
      console.log("📥 Input:", inputPath);
      console.log("📤 Output:", outputPath);
      
      ffmpeg(inputPath)
        .toFormat('wav')
        .audioChannels(1)  // Mono
        .audioFrequency(16000)  // 16kHz sample rate (standard for speech)
        .audioBitrate('256k')  // Higher bitrate for better quality
        .audioCodec('pcm_s16le')  // 16-bit PCM
        // Add audio filters to improve quality
        .audioFilters([
          'highpass=f=200',  // Remove low-frequency noise
          'lowpass=f=3000',  // Remove high-frequency noise (speech is 200-3000 Hz)
          'volume=2.0'  // Increase volume
        ])
        .on('end', () => {
          console.log("✅ Audio conversion completed");
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error("❌ Audio conversion error:", err.message);
          reject(new Error(`Audio conversion failed: ${err.message}`));
        })
        .save(outputPath);
    });
  }

  async localWhisperSTT(audioFilePath) {
    try {
      console.log(
        `🤖 Processing with Local Whisper (${this.whisperModelSize})...`,
      );

      // Convert audio to WAV format if needed
      let wavFilePath = audioFilePath;
      try {
        wavFilePath = await this.convertAudioToWav(audioFilePath);
      } catch (conversionError) {
        console.log("⚠️ Audio conversion failed, trying original file...");
        console.error("Conversion error:", conversionError.message);
      }

      // Use @xenova/transformers for local Whisper inference
      // This uses ONNX Runtime to run the model locally
      const transcriber = await pipeline(
        "automatic-speech-recognition",
        `Xenova/whisper-${this.whisperModelSize}`, // Auto-downloads from HuggingFace
      );

      // Read audio file and convert to Float32Array
      // @xenova/transformers in Node.js requires raw audio data
      console.log("🔄 Reading and processing audio file...");
      const audioData = await this.readAudioFile(wavFilePath);

      // Clean up converted file if it was created
      if (wavFilePath !== audioFilePath && fs.existsSync(wavFilePath)) {
        fs.unlinkSync(wavFilePath);
        console.log("🗑️ Cleaned up converted file");
      }

      // Transcribe with automatic language detection
      console.log("🔄 Running inference with auto language detection...");
      const result = await transcriber(audioData, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: null,  // Auto-detect language (supports 99 languages including Hindi)
        task: 'transcribe',
        return_timestamps: false
      });

      console.log("📝 Raw Whisper result:", JSON.stringify(result));

      let transcription = result.text.trim();
      
      // Detect language if available
      if (result.language) {
        console.log("🌍 Detected language:", result.language);
      }

      // Detect and handle hallucinations
      const isHallucination = this.detectHallucination(transcription, audioData.length);
      
      if (isHallucination) {
        console.warn("⚠️ Hallucination detected! Whisper output doesn't match audio characteristics");
        console.warn("📝 Suspicious transcription:", transcription);
        throw new Error("Hallucination detected - please speak more clearly or for longer");
      }

      if (!transcription || transcription.length === 0) {
        console.warn("⚠️ Whisper returned empty transcription");
        console.warn("📊 Audio info: samples=" + audioData.length + ", duration=" + (audioData.length / 16000).toFixed(2) + "s");
        throw new Error("Empty transcription from Whisper - audio may be too short or silent");
      }

      // Estimate confidence based on transcription characteristics
      // This is a heuristic since @xenova/transformers doesn't provide confidence scores
      let confidence = 0.8; // Default confidence
      
      // Reduce confidence if transcription is very short (likely incomplete)
      if (transcription.length < 5) {
        confidence = 0.5;
        console.warn("⚠️ Very short transcription - confidence reduced");
      }
      
      // Reduce confidence if transcription has many special characters (likely noise)
      const specialCharCount = (transcription.match(/[^a-zA-Z0-9\s]/g) || []).length;
      if (specialCharCount > transcription.length * 0.3) {
        confidence = Math.max(0.4, confidence - 0.2);
        console.warn("⚠️ Many special characters detected - confidence reduced");
      }

      console.log(`🤖 Whisper transcription: "${transcription}" (confidence: ${(confidence * 100).toFixed(1)}%)`);
      
      return {
        text: transcription,
        confidence: confidence
      };
    } catch (error) {
      console.error("❌ Local Whisper STT error:", error.message);
      throw error;
    }
  }

  detectHallucination(transcription, audioSamples) {
    // Common hallucination patterns in Whisper
    const hallucinationPatterns = [
      /thank you for watching/i,
      /please subscribe/i,
      /like and subscribe/i,
      /i'm just a little bit/i,
      /a little bit of a little bit/i,
      /you know what i mean/i,
      /^\s*\.\s*$/,  // Just a period
      /^[\s\.,!?]+$/,  // Only punctuation
      /(.{10,})\1{2,}/,  // Repeated phrases
    ];

    // Check for hallucination patterns
    for (const pattern of hallucinationPatterns) {
      if (pattern.test(transcription)) {
        console.warn("🚨 Hallucination pattern detected:", pattern);
        return true;
      }
    }

    // Check if transcription is too long for audio duration
    const audioDuration = audioSamples / 16000; // seconds
    const wordsPerSecond = transcription.split(/\s+/).length / audioDuration;
    
    if (wordsPerSecond > 5) {
      // More than 5 words per second is suspicious (normal speech is 2-3 wps)
      console.warn("🚨 Transcription too long for audio duration:", wordsPerSecond.toFixed(1), "words/sec");
      return true;
    }

    // Check for very short audio with long transcription
    if (audioDuration < 2 && transcription.length > 50) {
      console.warn("🚨 Short audio with long transcription");
      return true;
    }

    return false;
  }

  async textToSpeech(text) {
    try {
      console.log(
        "🔊 Processing text-to-speech for:",
        text.substring(0, 50) + "...",
      );

      // Try Google Cloud TTS first if available
      if (this.googleCloudTTSClient) {
        try {
          console.log("🔊 Trying Google Cloud TTS...");
          const audioFilePath = await this.googleCloudTTS(text);

          // Read the generated audio file and return as buffer
          const audioBuffer = fs.readFileSync(audioFilePath);

          console.log(
            "🎵 Generated TTS audio (Google Cloud):",
            audioFilePath,
            "size:",
            audioBuffer.length,
            "bytes",
          );
          return {
            buffer: audioBuffer,
            filePath: audioFilePath,
            mimeType: "audio/mpeg",
          };
        } catch (googleError) {
          console.log("⚠️ Google Cloud TTS failed, trying ElevenLabs...");
          console.error("Error details:", googleError.message);
        }
      }

      // Try ElevenLabs TTS if available
      if (this.elevenLabsClient) {
        try {
          console.log("🔊 Trying ElevenLabs TTS...");
          const audioFilePath = await this.elevenLabsTTS(text);

          // Read the generated audio file and return as buffer
          const audioBuffer = fs.readFileSync(audioFilePath);

          console.log(
            "🎵 Generated TTS audio (ElevenLabs):",
            audioFilePath,
            "size:",
            audioBuffer.length,
            "bytes",
          );
          return {
            buffer: audioBuffer,
            filePath: audioFilePath,
            mimeType: "audio/mpeg",
          };
        } catch (elevenLabsError) {
          console.log("⚠️ ElevenLabs TTS failed, trying Piper TTS...");
          console.error("Error details:", elevenLabsError.message);
        }
      }

      // Fallback to Piper TTS
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
        "🎵 Generated TTS audio (Piper):",
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

  async googleCloudTTS(text) {
    try {
      console.log("🔊 Synthesizing with Google Cloud TTS...");

      // Generate unique output filename
      const outputFilename = `output_${Date.now()}.mp3`;
      const outputPath = path.join(this.ttsOutputDir, outputFilename);

      // Detect language from text (simple heuristic)
      const languageCode = this.detectLanguage(text);
      console.log(`🌍 Detected language for TTS: ${languageCode}`);

      // Select voice based on language
      let voiceName, voiceGender;
      if (languageCode === 'hi-IN') {
        voiceName = 'hi-IN-Neural2-A'; // Hindi female neural voice
        voiceGender = 'FEMALE';
      } else if (languageCode === 'en-US') {
        voiceName = 'en-US-Neural2-C'; // English female neural voice
        voiceGender = 'FEMALE';
      } else {
        voiceName = `${languageCode}-Standard-A`;
        voiceGender = 'FEMALE';
      }

      // Construct the request
      const request = {
        input: { text: text },
        voice: {
          languageCode: languageCode,
          name: voiceName,
          ssmlGender: voiceGender,
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 1.0,
          pitch: 0.0,
        },
      };

      // Call Google Cloud TTS API
      const [response] = await this.googleCloudTTSClient.synthesizeSpeech(request);

      // Save audio to file
      fs.writeFileSync(outputPath, response.audioContent, 'binary');

      const fileSize = fs.statSync(outputPath).size;
      console.log("✅ Audio file generated (Google Cloud):", outputPath);
      console.log("📊 File size:", fileSize, "bytes");
      console.log("🎤 Voice:", voiceName);

      return outputPath;
    } catch (error) {
      console.error("❌ Google Cloud TTS error:", error.message);
      throw error;
    }
  }

  detectLanguage(text) {
    // Simple language detection based on Unicode ranges
    const hindiRegex = /[\u0900-\u097F]/; // Devanagari script
    const arabicRegex = /[\u0600-\u06FF]/; // Arabic script
    const chineseRegex = /[\u4E00-\u9FFF]/; // Chinese characters
    const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF]/; // Hiragana and Katakana

    if (hindiRegex.test(text)) {
      return 'hi-IN'; // Hindi
    } else if (arabicRegex.test(text)) {
      return 'ar-XA'; // Arabic
    } else if (chineseRegex.test(text)) {
      return 'zh-CN'; // Chinese
    } else if (japaneseRegex.test(text)) {
      return 'ja-JP'; // Japanese
    } else {
      return 'en-US'; // Default to English
    }
  }

  async elevenLabsTTS(text) {
    try {
      console.log("🔊 Synthesizing with ElevenLabs TTS...");

      // Generate unique output filename
      const outputFilename = `output_${Date.now()}.mp3`;
      const outputPath = path.join(this.ttsOutputDir, outputFilename);

      // Call ElevenLabs Text-to-Speech API directly
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`,
        {
          text: text,
          model_id: "eleven_multilingual_v2",
        },
        {
          headers: {
            'xi-api-key': this.elevenLabsApiKey,
            'Content-Type': 'application/json',
          },
          responseType: 'arraybuffer'
        }
      );

      // Save audio buffer to file
      fs.writeFileSync(outputPath, response.data);

      const fileSize = fs.statSync(outputPath).size;
      console.log("✅ Audio file generated (ElevenLabs):", outputPath);
      console.log("📊 File size:", fileSize, "bytes");

      return outputPath;
    } catch (error) {
      console.error("❌ ElevenLabs TTS error:", error.message);
      if (error.response) {
        console.error("API Response:", error.response.status, error.response.data);
      }
      throw error;
    }
  }

  async piperTTS(text) {
    try {
      console.log("🔊 Synthesizing with TTS...");

      // Generate unique output filename
      const outputFilename = `output_${Date.now()}.wav`;
      const outputPath = path.join(this.ttsOutputDir, outputFilename);

      // Try Piper TTS first, fallback to simple TTS
      let pythonScriptPath = path.join(__dirname, "../../scripts/piperTTS.py");
      let args = [text, outputPath, this.piperModelPath, this.piperConfigPath];
      let useFallback = false;

      // Check if Piper model exists
      if (!fs.existsSync(this.piperModelPath)) {
        console.log("⚠️ Piper model not found, using simple TTS fallback");
        useFallback = true;
      }

      if (useFallback) {
        pythonScriptPath = path.join(__dirname, "../../scripts/simpleTTS.py");
        args = [text, outputPath];
        console.log("📤 Calling Simple TTS via Python...");
      } else {
        console.log("📤 Calling Piper TTS via Python...");
      }

      if (!fs.existsSync(pythonScriptPath)) {
        throw new Error(`Python script not found: ${pythonScriptPath}`);
      }

      return new Promise((resolve, reject) => {
        const options = {
          args: args,
          pythonOptions: ["-u"], // Unbuffered output for real-time logging
        };

        // PythonShell.run() is callback-based, not event-based
        // The callback receives (err, results) where results is an array of output lines
        PythonShell.run(
          pythonScriptPath,
          options,
          (err, results) => {
            if (err) {
              // If Piper failed and we haven't tried fallback yet, try fallback
              if (!useFallback) {
                console.log("⚠️ Piper TTS failed, trying simple TTS fallback...");
                const fallbackScript = path.join(__dirname, "../../scripts/simpleTTS.py");
                const fallbackOptions = {
                  args: [text, outputPath],
                  pythonOptions: ["-u"],
                };

                PythonShell.run(fallbackScript, fallbackOptions, (fallbackErr, fallbackResults) => {
                  if (fallbackErr) {
                    console.error("❌ Both TTS methods failed");
                    return reject(new Error("TTS synthesis failed"));
                  }

                  if (fallbackResults && fallbackResults.length > 0) {
                    console.log("📝 Python output:", fallbackResults.join("\n"));
                  }

                  if (fs.existsSync(outputPath)) {
                    const fileSize = fs.statSync(outputPath).size;
                    console.log("✅ Audio file generated (fallback):", outputPath);
                    console.log("📊 File size:", fileSize, "bytes");
                    resolve(outputPath);
                  } else {
                    reject(new Error("Output audio file was not created"));
                  }
                });
                return;
              }

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

              return reject(new Error("TTS synthesis failed"));
            }

            // Log Python output
            if (results && results.length > 0) {
              console.log("📝 Python output:", results.join("\n"));
            }

            // Check if output file was created
            if (fs.existsSync(outputPath)) {
              const fileSize = fs.statSync(outputPath).size;
              console.log("✅ Audio file generated:", outputPath);
              console.log("📊 File size:", fileSize, "bytes");
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
      });
    } catch (error) {
      console.error("❌ TTS error:", error.message);
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
