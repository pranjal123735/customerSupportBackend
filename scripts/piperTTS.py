#!/usr/bin/env python3
"""
Piper TTS Script
Converts text to speech using Piper TTS model and saves as WAV file.

Usage:
  python3 scripts/piperTTS.py "Hello world" "./outputs/output.wav" "./models/piper/en_US-lessac-medium.onnx" "./models/piper/en_US-lessac-medium.onnx.json"

Arguments:
  1. Text: The text to synthesize
  2. Output path: Where to save the WAV file
  3. Model path: Path to ONNX model file
  4. Config path: Path to ONNX config JSON file

Requirements:
  - pip install piper-tts
  - pip install soundfile
"""

import sys
import os
import json
import logging
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def main():
    # Parse arguments
    if len(sys.argv) < 5:
        logger.error("Usage: python3 piperTTS.py <text> <output_path> <model_path> <config_path>")
        sys.exit(1)

    text = sys.argv[1]
    output_path = sys.argv[2]
    model_path = sys.argv[3]
    config_path = sys.argv[4]

    logger.info(f"🔊 Piper TTS Initialization")
    logger.info(f"📝 Text: {text[:50]}{'...' if len(text) > 50 else ''}")
    logger.info(f"📁 Output: {output_path}")
    logger.info(f"🤖 Model: {model_path}")
    logger.info(f"⚙️ Config: {config_path}")

    try:
        # Import Piper and soundfile
        logger.info("📦 Importing dependencies...")
        from piper.voice import PiperVoice
        import soundfile as sf

        # Check if model files exist
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Model file not found: {model_path}")
        
        if not os.path.exists(config_path):
            raise FileNotFoundError(f"Config file not found: {config_path}")

        # Load Piper model
        logger.info("🔄 Loading Piper voice model...")
        voice = PiperVoice.load(
            model_path,
            config_path=config_path,
            use_cuda=False  # Set to True if you have CUDA
        )

        # Synthesize speech
        logger.info("🎤 Synthesizing speech...")
        sample_rate = voice.config.sample_rate
        
        # Synthesize returns a generator of AudioFrame objects
        with sf.SoundFile(
            output_path,
            "w",
            samplerate=sample_rate,
            channels=1,
            format="WAV"
        ) as wav_file:
            for chunk in voice.synthesize(text):
                # Write audio data
                if hasattr(chunk, 'audio_int16_array'):
                    wav_file.write(chunk.audio_int16_array)
                else:
                    wav_file.write(chunk.audio)

        logger.info(f"✅ Audio file generated successfully: {output_path}")
        
        # Verify file was created
        if os.path.exists(output_path):
            file_size = os.path.getsize(output_path)
            logger.info(f"📊 File size: {file_size} bytes")
            sys.exit(0)
        else:
            raise RuntimeError("Output file was not created")

    except ImportError as e:
        logger.error(f"❌ Import error: {e}")
        logger.error("Install dependencies with: pip install piper-tts soundfile")
        sys.exit(1)

    except FileNotFoundError as e:
        logger.error(f"❌ File not found: {e}")
        sys.exit(1)

    except Exception as e:
        logger.error(f"❌ Error during TTS synthesis: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
