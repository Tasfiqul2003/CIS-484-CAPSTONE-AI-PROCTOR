import time
import sounddevice as sd
from scipy.io.wavfile import write
from faster_whisper import WhisperModel

# Audio settings
sample_rate = 44100
duration = 7
audio_file = "voice_input_test.wav"

# Load Faster-Whisper
print("Loading speech recognition model...")

model = WhisperModel(
    "base.en",
    device="cpu",
    compute_type="int8"
)

print("Model loaded.")

# Countdown
print("\nGet ready...")
time.sleep(1)

print("3")
time.sleep(1)

print("2")
time.sleep(1)

print("1")
time.sleep(1)

# Start recording BEFORE telling user to speak
recording = sd.rec(
    int(duration * sample_rate),
    samplerate=sample_rate,
    channels=1,
    dtype="int16"
)

# Small pre-recording buffer
time.sleep(0.5)

print("Speak now!")

sd.wait()

write(audio_file, sample_rate, recording)

print("Recording complete.")

# Convert speech to text
print("\nConverting speech to text...")

segments, info = model.transcribe(
    audio_file,
    beam_size=5,
    language="en",
    initial_prompt="Computer networking terminology including TCP, UDP, IP, DNS, DHCP, HTTP, HTTPS, and cybersecurity."
)

transcription = ""

for segment in segments:
    transcription += segment.text.strip() + " "

transcription = transcription.strip()

print("\nYou said:")
print(transcription)

print("\nVoice input test complete.")