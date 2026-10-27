"""Does a given Ollama model write relevant follow-up questions with the exam's own prompt?

Run on the Pod, next to avatar_app.py, in the chatterbox env (no GPU models are loaded by this script):
    cd /workspace && source miniconda/etc/profile.d/conda.sh && conda activate chatterbox
    python test_followups.py qwen3:4b
    python test_followups.py qwen3:4b qwen3:8b        # compare models (each must be pulled)
Prints, for each sample answer, the raw model output, the follow-up the app would actually say, and the time.
"""
import sys
import time

import avatar_app as a

SAMPLES = [
    ("In your own words, what is a use case?",
     "A use case is a description of how a user interacts with a system to reach a goal, like a customer checking out online."),
    ("In your own words, what is a use case?",
     "It is like a representation of a major piece of system functionality."),
    ("What is an actor in a use case diagram? Can you give me one example?",
     "An actor is someone or something that interacts with the system. An example could be a customer."),
    ("What is an actor in a use case diagram? Can you give me one example?",
     "I think it is a stick figure on the side, I do not remember exactly."),
    ("Tell me about one assignment you worked on. What was it about?",
     "I worked on an assignment where I had to model a transaction for a bookstore, with the cashier and the inventory system."),
    ("Tell me about one assignment you worked on. What was it about?",
     "It was a database project and it was hard."),
]

models = sys.argv[1:] or [a.LLM]
TRIES = 3
for model in models:
    a.LLM = model
    print(f"\n===== {model} =====")
    stock = total = 0
    for q, ans in SAMPLES:
        print(f"\nStudent: {ans}")
        for _ in range(TRIES):
            a.SESSION.pop("raw", None); a.SESSION.pop("rejected", None); a.SESSION.pop("used_fu", None)
            exchange = [f"Professor: {q}\nStudent: {ans}"]
            t0 = time.perf_counter()
            spoken = a.follow_up(exchange)
            dt = time.perf_counter() - t0
            is_stock = spoken in a.FALLBACK_FOLLOWUPS
            stock += is_stock
            total += 1
            note = "  (STOCK LINE)" if is_stock else ""
            print(f"  [{dt:.1f}s] {spoken}{note}")
            if a.SESSION.get("rejected"):
                print(f"          rejected first try: {a.SESSION['rejected'][:120]!r}")
    print(f"\n{model}: {total - stock}/{total} written by the model, {stock} fell back to a stock line")
