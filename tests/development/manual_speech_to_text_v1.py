from faster_whisper import WhisperModel

print("Loading Faster-Whisper model...")

model = WhisperModel(
    "base.en",
    device="cpu",
    compute_type="int8"
)

print("Model loaded.")
print("Transcribing microphone_test.wav...")

segments, info = model.transcribe(
    "microphone_test.wav",
    beam_size=5
)

print("\nDetected language:", info.language)
print("\nYou said:")

for segment in segments:
    print(segment.text.strip())

print("\nTranscription complete.")