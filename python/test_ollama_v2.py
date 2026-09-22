import ollama

print("AI Oral Examiner Version 2 started.")
print("Type 'exit' to stop.\n")

while True:
    question = input("You: ")

    if question.lower() == "exit":
        print("Oral Examiner stopped.")
        break

    response = ollama.chat(
        model="oral-examiner-v2:latest",
        messages=[
            {
                "role": "user",
                "content": question
            }
        ]
    )

    print("\nOral Examiner:")
    print(response["message"]["content"])
    print()