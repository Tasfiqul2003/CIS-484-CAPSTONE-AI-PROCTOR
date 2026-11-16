"""Stock lines the talking examiner can say. The avatar service makes their clips ahead of time,
so saying one adds no wait. The reactions never hint whether an answer was right.
"""
import random

REACTIONS = ["Thank you.", "Okay, thank you.", "Alright, thank you.", "Got it, thank you.", "Okay, let's keep going."]


# Used when a short answer needs a follow-up and the model gives nothing usable.
FOLLOW_UP_FALLBACKS = ["Can you give me one example of that?", "Can you explain that a little more?",
                       "Why do you think that is?", "How would that work in practice?"]


def pick_reaction() -> str:
    return random.choice(REACTIONS)
