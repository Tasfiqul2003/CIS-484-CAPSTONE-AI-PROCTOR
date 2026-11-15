// Short spoken requests the examiner answers instead of treating them as an answer.

const REPEAT = /\b(repeat|say (that|it|the question) again|ask (that|it|the question) again|one more time|come again|pardon|didn'?t (hear|catch)|again please)\b/;

/**
 * True when a transcript is only a request to hear the question again
 * ("Can you repeat the question?", "Sorry, say that again"), not an answer that mentions repeating.
 */
export function isRepeatRequest(transcript: string): boolean {
  const words = transcript.toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean);
  // Answers are longer; a long transcript containing "repeat" is treated as an answer.
  if (words.length === 0 || words.length > 10) return false;
  return REPEAT.test(words.join(" "));
}
