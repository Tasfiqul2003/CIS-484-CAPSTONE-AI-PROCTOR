import wave
from piper import PiperVoice

print("Loading Piper voice...")

voice = PiperVoice.load(
    "en_US-lessac-medium.onnx"
)

print("Voice loaded.")

text = "Hello. I am the AI Oral Examiner."

output_file = "ai_voice_test.wav"

print("Generating AI speech...")

with wave.open(output_file, "wb") as wav_file:
    voice.synthesize_wav(
        text,
        wav_file
    )

print("Speech generated.")
print("Saved as:", output_file)