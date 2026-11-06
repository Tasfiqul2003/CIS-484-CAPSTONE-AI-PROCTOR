export type StandardVoiceProfile = "calm" | "clear";
type Voice = { lang: string; localService: boolean; default: boolean };

/** Prefer an installed English voice; never imitate an uploaded or real person's voice. */
export function selectEnglishVoice<T extends Voice>(voices: readonly T[]): T | undefined {
  const english = voices.filter(voice => /^en(?:-|$)/i.test(voice.lang));
  return english.find(voice => voice.localService && /^en[-_]US$/i.test(voice.lang))
    ?? english.find(voice => voice.localService)
    ?? english.find(voice => voice.default)
    ?? english[0];
}

export function standardVoiceDelivery(profile: StandardVoiceProfile, speed: number, volume: number) {
  if (!["calm", "clear"].includes(profile) || !Number.isFinite(speed) || speed < .5 || speed > 2 ||
      !Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error("Invalid speech preferences.");
  return { lang: "en-US", rate: speed * (profile === "calm" ? .92 : 1), pitch: profile === "calm" ? .95 : 1, volume: volume / 100 };
}

type Utterance = Pick<SpeechSynthesisUtterance, "lang" | "rate" | "pitch" | "volume" | "voice" | "onstart" | "onend" | "onerror">;
type SpeechEngine = { cancel(): void; getVoices(): SpeechSynthesisVoice[]; speak(utterance: SpeechSynthesisUtterance): void };

/** Generation guards keep cancelled speech callbacks from changing the current avatar state. */
export function createExamSpeaker(engine: SpeechEngine, makeUtterance: (text: string) => Utterance) {
  let generation = 0;
  return {
    stop() { generation += 1; engine.cancel(); },
    speak(text: string, profile: StandardVoiceProfile, speed: number, volume: number,
      onState: (state: "Idle" | "Speaking" | "Error") => void, onError: (message: string) => void) {
      generation += 1;
      const active = generation;
      engine.cancel();
      const delivery = standardVoiceDelivery(profile, speed, volume);
      if (!text.trim()) throw new Error("There is no question to read.");
      const utterance = makeUtterance(text);
      Object.assign(utterance, delivery);
      utterance.voice = selectEnglishVoice(engine.getVoices()) ?? null;
      utterance.onstart = () => { if (active === generation) onState("Speaking"); };
      utterance.onend = () => { if (active === generation) onState("Idle"); };
      utterance.onerror = () => {
        if (active !== generation) return;
        onState("Error");
        onError("Question audio is unavailable. Continue using the question text or try reading it aloud again.");
      };
      engine.speak(utterance as SpeechSynthesisUtterance);
    },
  };
}
