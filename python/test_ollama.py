import ollama

print("Python started")

response = ollama.chat(
    model="oral-examiner-v2:latest",
    messages=[
        {
            "role": "user",
            "content": "Say hello and introduce yourself as an AI oral examiner."
        }
    ]
)

print("Ollama responded:")
print(response["message"]["content"])