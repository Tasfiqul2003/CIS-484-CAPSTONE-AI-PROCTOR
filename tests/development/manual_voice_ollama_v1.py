print("Voice-to-Ollama program started.")

import time
import sounddevice as sd
from scipy.io.wavfile import write
from faster_whisper import WhisperModel
import ollama

print("Imports loaded successfully.")

sample_rate = 44100
duration = 7
audio_file = "voice_ollama_input.wav"

print("Loading speech recognition model...")

whisper_model = WhisperModel(
    "base.en",
    device="cpu",
    compute_type="int8"
)

print("Speech recognition model loaded.")

print("\nGet ready...")
time.sleep(1)

print("3")
time.sleep(1)

print("2")
time.sleep(1)

print("1")
time.sleep(1)

recording = sd.rec(
    int(duration * sample_rate),
    samplerate=sample_rate,
    channels=1,
    dtype="int16"
)

time.sleep(0.5)

print("Speak now!")

sd.wait()

write(audio_file, sample_rate, recording)

print("Recording complete.")

print("\nConverting speech to text...")

segments, info = whisper_model.transcribe(
    audio_file,
    beam_size=5,
    language="en",
    initial_prompt=(
        "Computer science, networking, cybersecurity, TCP, UDP, "
        "DNS, DHCP, HTTP, HTTPS, Python, cloud computing."
    )
)

transcription = ""

for segment in segments:
    transcription += segment.text.strip() + " "

transcription = transcription.strip()

print("\nStudent said:")
print(transcription)

if transcription:
    print("\nSending transcription to Ollama...")

    response = ollama.chat(
        model="oral-examiner-v2:latest",
        messages=[
            {
                "role": "user",
                "content": transcription
            }
        ]
    )

    ai_response = response["message"]["content"]

    print("\nAI Oral Examiner:")
    print(ai_response)

else:
    print("\nNo speech detected.")

print("\nVoice-to-Ollama test complete.")