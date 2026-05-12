#!/usr/bin/env python3
"""
Simple TTS Script using pyttsx3
Works on Windows without DLL issues.

Usage:
  python3 scripts/simpleTTS.py "Hello world" "./outputs/output.wav"
"""

import sys
import os
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def main():
    if len(sys.argv) < 3:
        logger.error("Usage: python3 simpleTTS.py <text> <output_path>")
        sys.exit(1)

    text = sys.argv[1]
    output_path = sys.argv[2]

    logger.info(f"🔊 Simple TTS Initialization")
    logger.info(f"📝 Text: {text[:50]}{'...' if len(text) > 50 else ''}")
    logger.info(f"📁 Output: {output_path}")

    try:
        import pyttsx3
        
        # Initialize TTS engine
        logger.info("🔄 Initializing TTS engine...")
        engine = pyttsx3.init()
        
        # Configure voice properties
        engine.setProperty('rate', 150)    # Speed of speech
        engine.setProperty('volume', 1.0)  # Volume (0.0 to 1.0)
        
        # Get available voices
        voices = engine.getProperty('voices')
        if voices:
            # Use first available voice (usually default)
            engine.setProperty('voice', voices[0].id)
            logger.info(f"🎤 Using voice: {voices[0].name}")
        
        # Ensure output directory exists
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        
        # Synthesize and save to file
        logger.info("🎤 Synthesizing speech...")
        engine.save_to_file(text, output_path)
        engine.runAndWait()
        
        # Verify file was created
        if os.path.exists(output_path):
            file_size = os.path.getsize(output_path)
            logger.info(f"✅ Audio file generated: {output_path}")
            logger.info(f"📊 File size: {file_size} bytes")
            sys.exit(0)
        else:
            raise RuntimeError("Output file was not created")

    except ImportError as e:
        logger.error(f"❌ Import error: {e}")
        logger.error("Install dependencies with: pip install pyttsx3")
        sys.exit(1)

    except Exception as e:
        logger.error(f"❌ Error during TTS synthesis: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
