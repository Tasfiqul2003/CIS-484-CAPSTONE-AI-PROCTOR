import time
import wave
import re
import json
import unicodedata
import numpy as np

import sounddevice as sd
from scipy.io.wavfile import write, read
from faster_whisper import WhisperModel
from piper import PiperVoice
import ollama


# ============================================================
# SETTINGS
# ============================================================

sample_rate = 44100

# Student must be silent for this long before recording stops
silence_buffer = 5.0

# Safety limit so recording cannot continue forever
max_recording_time = 60

# Microphone volume level used to determine speech vs silence
silence_threshold = 500

input_audio_file = "voice_ollama_input.wav"
output_audio_file = "ai_response.wav"

ollama_model = "oral-examiner-v2:latest"
piper_voice_file = "en_US-lessac-medium.onnx"


# ============================================================
# STRUCTURED OLLAMA OUTPUT
# ============================================================

response_schema = {
    "type": "object",
    "properties": {
        "spoken_response": {
            "type": "string",
            "description": (
                "Only the final response that should be spoken aloud "
                "to the student. Do not include reasoning, analysis, "
                "instructions, metadata, formatting, or internal thoughts."
            )
        }
    },
    "required": [
        "spoken_response"
    ]
}


# ============================================================
# CLEAN TEXT FOR SPEECH
# ============================================================

def clean_for_speech(text):

    # Remove thinking tags
    text = re.sub(
        r"<think>.*?</think>",
        " ",
        text,
        flags=re.DOTALL | re.IGNORECASE
    )

    # Remove code blocks
    text = re.sub(
        r"```.*?```",
        " ",
        text,
        flags=re.DOTALL
    )

    # Remove inline code marks
    text = text.replace("`", "")

    # Remove common Markdown characters
    text = re.sub(
        r"[*_#>|~]",
        "",
        text
    )

    # Remove bullet symbols
    text = text.replace("•", "")

    # Remove most emojis / decorative symbols
    text = "".join(
        character
        for character in text
        if unicodedata.category(character) != "So"
    )

    # Remove extra spaces and line breaks
    text = re.sub(
        r"\s+",
        " ",
        text
    )

    return text.strip()


# ============================================================
# CHECK FOR INTERNAL AI REASONING
# ============================================================

def looks_like_internal_reasoning(text):

    lower_text = text.lower()

    suspicious_phrases = [
        "the user is asking",
        "the user asked",
        "i need to respond",
        "i should respond",
        "i need to answer",
        "i should answer",
        "let's think",
        "lets think",
        "we are given",
        "the instruction says",
        "the instructions say",
        "my task is",
        "i need to keep",
        "i should keep",
        "example response",
        "internal reasoning",
        "chain of thought"
    ]

    for phrase in suspicious_phrases:
        if phrase in lower_text:
            return True

    return False


# ============================================================
# RECORD STUDENT WITH 5-SECOND SILENCE BUFFER
# ============================================================

def record_student_answer():

    print("\nListening...")
    print("Speak when you are ready.")

    audio_chunks = []

    speech_started = False

    recording_start = time.time()
    last_voice_time = time.time()

    block_size = 1024

    with sd.InputStream(
        samplerate=sample_rate,
        channels=1,
        dtype="int16",
        blocksize=block_size
    ) as stream:

        while True:

            audio_chunk, overflowed = stream.read(
                block_size
            )

            audio_chunks.append(
                audio_chunk.copy()
            )

            # Measure microphone volume
            audio_float = audio_chunk.astype(
                np.float32
            )

            volume = np.sqrt(
                np.mean(audio_float ** 2)
            )

            # --------------------------------------------
            # SPEECH DETECTED
            # --------------------------------------------

            if volume > silence_threshold:

                if not speech_started:
                    print("Speech detected.")

                speech_started = True

                # Reset silence timer every time speech occurs
                last_voice_time = time.time()


            # --------------------------------------------
            # CHECK FOR 5 SECONDS OF SILENCE
            # --------------------------------------------

            if speech_started:

                silence_time = (
                    time.time()
                    - last_voice_time
                )

                if silence_time >= silence_buffer:

                    print(
                        "\n5 seconds of silence detected."
                    )

                    print(
                        "Student answer complete."
                    )

                    break


            # --------------------------------------------
            # MAXIMUM RECORDING SAFETY LIMIT
            # --------------------------------------------

            total_time = (
                time.time()
                - recording_start
            )

            if total_time >= max_recording_time:

                print(
                    "\nMaximum recording time reached."
                )

                break


    recording = np.concatenate(
        audio_chunks,
        axis=0
    )

    return recording


# ============================================================
# LOAD WHISPER
# ============================================================

print("Loading speech recognition model...")

whisper_model = WhisperModel(
    "base.en",
    device="cpu",
    compute_type="int8"
)

print("Speech recognition model loaded.")


# ============================================================
# LOAD PIPER AI VOICE
# ============================================================

print("Loading AI voice...")

voice = PiperVoice.load(
    piper_voice_file
)

print("AI voice loaded.")


# ============================================================
# PREPARE STUDENT
# ============================================================

print("\nGet ready...")
time.sleep(1)

print("3")
time.sleep(1)

print("2")
time.sleep(1)

print("1")
time.sleep(1)


# ============================================================
# RECORD STUDENT ANSWER
# ============================================================

recording = record_student_answer()

write(
    input_audio_file,
    sample_rate,
    recording
)

print("Recording saved.")


# ============================================================
# SPEECH TO TEXT WITH WHISPER
# ============================================================

print("\nConverting speech to text...")

segments, info = whisper_model.transcribe(
    input_audio_file,
    beam_size=5,
    language="en",
    initial_prompt=(
        "Computer science, information technology, networking, "
        "cybersecurity, TCP, UDP, IP, DNS, DHCP, HTTP, HTTPS, "
        "packetization, packets, Python, cloud computing, "
        "artificial intelligence, and technical terminology."
    )
)

transcription = ""

for segment in segments:
    transcription += segment.text.strip() + " "

transcription = transcription.strip()


# ============================================================
# DISPLAY STUDENT TRANSCRIPTION
# ============================================================

print("\nStudent said:")
print(transcription)


# ============================================================
# SEND TRANSCRIPTION TO OLLAMA
# ============================================================

if transcription:

    print("\nSending transcription to AI Oral Examiner...")

    response = ollama.chat(

        model=ollama_model,

        messages=[
            {
                "role": "system",
                "content": (
                    "You are an AI oral examiner speaking directly "
                    "to a student. "

                    "Answer the student's question directly. "

                    "Never include your reasoning process. "
                    "Never explain how you decided what to say. "
                    "Never repeat your instructions. "
                    "Never describe what the student is asking. "
                    "Never say phrases such as 'the user is asking', "
                    "'I need to answer', 'I should respond', "
                    "'let's think', or similar internal commentary. "

                    "Your spoken_response must contain ONLY the words "
                    "that should actually be spoken aloud to the student. "

                    "Use clear, natural, conversational English. "
                    "Do not use emojis. "
                    "Do not use Markdown. "
                    "Do not use bullet points. "
                    "Do not use headings. "
                    "Do not use formatting symbols. "
                    "Do not include stage directions. "

                    "Keep simple questions concise. "
                    "For definition questions, usually answer in "
                    "one to three sentences. "

                    "Return the answer using the required JSON structure."
                )
            },

            {
                "role": "user",
                "content": transcription
            }
        ],

        think=False,

        format=response_schema,

        options={
            "temperature": 0,
            "num_predict": 120
        },

        keep_alive="30m"
    )


    # ========================================================
    # PARSE SAFE SPOKEN RESPONSE
    # ========================================================

    try:

        response_data = json.loads(
            response["message"]["content"]
        )

        spoken_response = response_data[
            "spoken_response"
        ]

        spoken_response = clean_for_speech(
            spoken_response
        )

    except Exception:

        print(
            "\nCould not safely read the AI response."
        )

        print(
            "Nothing will be spoken."
        )

        spoken_response = ""


    # ========================================================
    # CHECK FOR INTERNAL REASONING
    # ========================================================

    if (
        spoken_response
        and not looks_like_internal_reasoning(
            spoken_response
        )
    ):

        print("\nAI Oral Examiner:")
        print(spoken_response)


        # ====================================================
        # GENERATE AI VOICE
        # ====================================================

        print("\nGenerating AI voice response...")

        with wave.open(
            output_audio_file,
            "wb"
        ) as wav_file:

            voice.synthesize_wav(
                spoken_response,
                wav_file
            )

        print("AI voice generated.")


        # ====================================================
        # PLAY AI VOICE
        # ====================================================

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


    elif spoken_response:

        print(
            "\nPossible internal reasoning detected."
        )

        print(
            "Response blocked from speakers."
        )


    else:

        print(
            "\nNo safe spoken response was generated."
        )


else:

    print("\nNo speech was detected.")


# ============================================================
# FINISH
# ============================================================

print("\nVoice interaction V2 test complete.")