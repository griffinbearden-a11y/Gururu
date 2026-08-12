// Thin wrapper around ElevenLabs' text-to-speech API, used for the Howlin'
// Minute audio segment. Free tier: no card required, ~10,000 credits/month
// (roughly 10 minutes of audio at default quality) — plenty for a couple of
// ~60-second clips a week.
const ELEVEN_LABS_URL = (voiceId: string) => `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

// Wolf's voice, added to the ElevenLabs account's voice library. Override
// via ELEVENLABS_VOICE_ID if you swap it out later.
const DEFAULT_VOICE_ID = '7fbQ7yJuEo56rYjrYaEh';

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;

  const res = await fetch(ELEVEN_LABS_URL(voiceId), {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.6, use_speaker_boost: true },
    }),
  });

  if (!res.ok) {
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text()}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
