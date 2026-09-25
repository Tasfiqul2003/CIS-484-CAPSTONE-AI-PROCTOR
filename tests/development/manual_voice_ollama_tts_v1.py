import time
import wave

import sounddevice as sd
from scipy.io.wavfile import write, read
from faster_whisper import WhisperModel
from piper import PiperVoice
import ollama


# --------------------------------
# SETTINGS
# --------------------------------

sample_rate = 44100
duration = 7

input_audio_file = "voice_ollama_input.wav"
output_audio_file = "ai_response.wav"

ollama_model = "oral-examiner-v2:latest"
piper_voice_file = "en_US-lessac-medium.onnx"


# --------------------------------
# LOAD WHISPER
# --------------------------------

print("Loading speech recognition model...")

whisper_model = WhisperModel(
    "base.en",
    device="cpu",
    compute_type="int8"
)

print("Speech recognition model loaded.")


# --------------------------------
# LOAD PIPER VOICE
# --------------------------------

print("Loading AI voice...")

voice = PiperVoice.load(
    piper_voice_file
)

print("AI voice loaded.")


# --------------------------------
# RECORD STUDENT
# --------------------------------

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

write(
    input_audio_file,
    sample_rate,
    recording
)

print("Recording complete.")


# --------------------------------
# SPEECH TO TEXT
# --------------------------------

print("\nConverting speech to text...")

segments, info = whisper_model.transcribe(
    input_audio_file,
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


# --------------------------------
# SEND TO OLLAMA
# --------------------------------

if transcription:

    print("\nSending transcription to AI Oral Examiner...")

    response = ollama.chat(
        model=ollama_model,
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


    # --------------------------------
    # CONVERT AI TEXT TO SPEECH
    # --------------------------------

    print("\nGenerating AI voice response...")

    with wave.open(output_audio_file, "wb") as wav_file:
        voice.synthesize_wav(
            ai_response,
            wav_file
        )

    print("AI voice generated.")


    # --------------------------------
    # PLAY AI RESPONSE
    # --------------------------------

    print("Playing AI response...")

    ai_sample_rate, ai_audio = read(
        output_audio_file
    )

    sd.play(
        ai_audio,
        ai_sample_rate
    )

    sd.wait()

    print("AI finished speaking.")

else:

    print("\nNo speech was detected.")


print("\nVoice interaction test complete.")