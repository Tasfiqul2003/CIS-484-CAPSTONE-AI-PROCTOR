import sounddevice as sd
from scipy.io.wavfile import write

sample_rate = 44100
duration = 5

print("Recording will begin now...")
print("Speak into your microphone.")

recording = sd.rec(
    int(duration * sample_rate),
    samplerate=sample_rate,
    channels=1,
    dtype="int16"
)

sd.wait()

write("microphone_test.wav", sample_rate, recording)

print("Recording complete.")
print("Saved as microphone_test.wav")