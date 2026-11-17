"""Stock lines the talking examiner can say. The avatar service makes their clips ahead of time,
so saying one costs no wait, and they cover the seconds a live follow-up takes to render.

None of them hint whether an answer was right.
"""
import hashlib
import random

# Said before the first question, so the exam does not open with the examiner already talking.
GREETINGS = ["Hello. I will be your examiner today. Let's begin.",
             "Hello, and welcome. Let's get started.",
             "Hello. I'll be asking your questions today. Here is the first one."]

# Said before moving on to the next question from the professor's bank.
REACTIONS = ["Thank you.", "Okay, thank you.", "Alright, thank you.", "Got it, thank you.", "Okay, let's keep going."]

# Said before a follow-up. These also tell the student another question on the same topic is coming.
FOLLOW_UP_LEADS = ["Okay.", "Alright.", "Thank you.", "Let me follow up on that.", "One more thing on that."]

# Used when a short answer needs a follow-up and the model gives nothing usable.
FOLLOW_UP_FALLBACKS = ["Can you give me one example of that?", "Can you explain that a little more?",
                       "Why do you think that is?", "How would that work in practice?"]

# Every line the speak route accepts as a lead-in, and that is rendered ahead of time.
LEAD_LINES = GREETINGS + REACTIONS + FOLLOW_UP_LEADS
PRERENDER_LINES = LEAD_LINES + FOLLOW_UP_FALLBACKS


def greeting_for(session_id: str) -> str:
    """The same greeting every time for one exam session, so reloading does not change it."""
    digest = hashlib.sha1(str(session_id).encode()).digest()
    return GREETINGS[digest[0] % len(GREETINGS)]


def pick_reaction() -> str:
    return random.choice(REACTIONS)


def pick_follow_up_lead() -> str:
    return random.choice(FOLLOW_UP_LEADS)
