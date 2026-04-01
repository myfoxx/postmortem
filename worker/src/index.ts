import { VaultObject, Env } from './vault';
export { VaultObject };

// ── CORS HEADERS ─────────────────────────────────────────────────
function cors(origin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data: unknown, status = 200, origin = '*'): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

function err(msg: string, status = 400, origin = '*'): Response {
  return json({ error: msg }, status, origin);
}

// ── CRYPTO UTILS ─────────────────────────────────────────────────
async function uuid(): Promise<string> {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  arr[6] = (arr[6] & 0x0f) | 0x40;
  arr[8] = (arr[8] & 0x3f) | 0x80;
  const hex = [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// ── ELEVENLABS HELPERS ───────────────────────────────────────────
async function cloneVoiceEl(audioBlob: Blob, apiKey: string): Promise<string> {
  const fd = new FormData();
  fd.append('name', `postmortem-${Date.now()}`);
  fd.append('files', audioBlob, 'sample.webm');
  fd.append('description', 'PostMortem voice clone');

  const res = await fetch('https://api.elevenlabs.io/v1/voices/add', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: fd,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ElevenLabs clone error: ${text}`);
  }

  const data = await res.json() as { voice_id: string };
  return data.voice_id;
}

async function generateTTS(text: string, voiceId: string, apiKey: string): Promise<ArrayBuffer> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key':   apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.85 },
    }),
  });

  if (!res.ok) {
    const text2 = await res.text();
    throw new Error(`ElevenLabs TTS error: ${text2}`);
  }

  return res.arrayBuffer();
}

// ── VAULT DO STUB HELPER ─────────────────────────────────────────
function getVaultStub(env: Env, vaultId: string): DurableObjectStub {
  const doId = env.VAULT.idFromName(vaultId);
  return env.VAULT.get(doId);
}

// ── MAIN HANDLER ─────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url    = new URL(request.url);
    const origin = env.FRONTEND_URL || '*';
    const method = request.method.toUpperCase();

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // ── POST /clone ──────────────────────────────────────────────
    // Receives multipart with audio file, returns { voice_id }
    if (method === 'POST' && url.pathname === '/clone') {
      try {
        const form  = await request.formData();
        const audio = form.get('audio') as File | null;
        if (!audio) return err('No audio file provided', 400, origin);

        const voiceId = await cloneVoiceEl(audio, env.ELEVENLABS_API_KEY);
        return json({ voice_id: voiceId }, 200, origin);

      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(msg, 500, origin);
      }
    }

    // ── POST /message ────────────────────────────────────────────
    // Receives JSON, generates TTS, stores in R2, creates Vault DO
    // Body: { voice_id, text, recipient, sender, unlock_type, unlock_value }
    if (method === 'POST' && url.pathname === '/message') {
      try {
        const body = await request.json() as {
          voice_id: string; text: string; recipient: string;
          sender: string; unlock_type: 'date' | 'code'; unlock_value: string;
        };

        const { voice_id, text, recipient, sender, unlock_type, unlock_value } = body;

        if (!voice_id || !text || !recipient || !sender || !unlock_type || !unlock_value) {
          return err('Missing required fields', 400, origin);
        }

        // 1. Generate TTS audio
        const audioBuffer = await generateTTS(text, voice_id, env.ELEVENLABS_API_KEY);

        // 2. Store audio in R2
        const vaultId    = await uuid();
        const r2Key      = `vaults/${vaultId}/message.mp3`;
        await env.AUDIO_BUCKET.put(r2Key, audioBuffer, {
          httpMetadata: { contentType: 'audio/mpeg' },
        });

        // 3. Normalize unlock value
        // For code-based: store lowercase trimmed (simple, acceptable for demo)
        const normalizedUnlock = unlock_type === 'code'
          ? unlock_value.trim().toLowerCase()
          : unlock_value; // ISO date string

        // 4. Create Vault Durable Object
        const stub = getVaultStub(env, vaultId);
        await stub.create({
          vault_id:     vaultId,
          sender,
          recipient,
          voice_id,
          message_text: text,
          audio_r2_key: r2Key,
          unlock_type,
          unlock_value: normalizedUnlock,
        });

        return json({ vault_id: vaultId }, 200, origin);

      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(msg, 500, origin);
      }
    }

    // ── GET /vault/:id/status ────────────────────────────────────
    const statusMatch = url.pathname.match(/^\/vault\/([^/]+)\/status$/);
    if (method === 'GET' && statusMatch) {
      const vaultId = statusMatch[1];
      const stub    = getVaultStub(env, vaultId);
      const status  = await stub.status(vaultId);
      if (!status) return err('Vault not found', 404, origin);
      return json(status, 200, origin);
    }

    // ── POST /vault/:id/unlock ───────────────────────────────────
    const unlockMatch = url.pathname.match(/^\/vault\/([^/]+)\/unlock$/);
    if (method === 'POST' && unlockMatch) {
      try {
        const vaultId = unlockMatch[1];
        const { code } = await request.json() as { code: string };

        const stub  = getVaultStub(env, vaultId);
        const result = await stub.unlock(vaultId, code ?? '');

        if ('error' in result) return err(result.error, 403, origin);

        // Generate a short-lived presigned R2 URL (1 hour)
        const r2Object = await env.AUDIO_BUCKET.get(result.audio_r2_key);
        if (!r2Object) return err('Audio not found', 404, origin);

        // Stream the audio directly through the Worker
        // (R2 doesn't support presigned URLs in free tier — serve directly)
        // We return metadata + a special audio endpoint
        return json({
          sender:     result.sender,
          recipient:  result.recipient,
          created_at: result.created_at,
          text:       result.message_text,
          audio_url:  `/vault/${vaultId}/audio?code=${encodeURIComponent(code)}`,
        }, 200, origin);

      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(msg, 500, origin);
      }
    }

    // ── GET /vault/:id/audio ─────────────────────────────────────
    // Streams the actual audio after re-verifying the code
    const audioMatch = url.pathname.match(/^\/vault\/([^/]+)\/audio$/);
    if (method === 'GET' && audioMatch) {
      const vaultId = audioMatch[1];
      const code    = url.searchParams.get('code') || '';

      const stub   = getVaultStub(env, vaultId);
      const result = await stub.unlock(vaultId, code);

      if ('error' in result) return err(result.error, 403, origin);

      const r2Object = await env.AUDIO_BUCKET.get(result.audio_r2_key);
      if (!r2Object) return err('Audio not found', 404, origin);

      return new Response(r2Object.body, {
        headers: {
          'Content-Type':  'audio/mpeg',
          'Cache-Control': 'private, no-store',
          ...cors(origin),
        },
      });
    }

    // ── POST /generate ─────────────────────────────────────────
    if (method === 'POST' && url.pathname === '/generate') {
      try {
        const { lang, mode } = await request.json() as { lang: string; mode: string };
        const prompts: Record<string, Record<string, string>> = {
          record: { en: 'Write a 60-second reading script about 150 words for voice cloning. Natural, emotional. No title.', it: 'Scrivi 150 parole da leggere per clonare la voce. Naturale, emotivo. Nessun titolo.', es: 'Escribe 150 palabras para clonar la voz. Natural, emotivo. Sin título.', fr: 'Écris 150 mots pour cloner la voix. Naturel, émouvant. Sans titre.', de: '150 Wörter zum Klonen der Stimme. Natürlich, emotional. Kein Titel.', pt: 'Escreva 150 palavras para clonar a voz. Natural, emotivo. Sem título.' },
          message: { en: 'Write a 60-90 word farewell voice message from a parent to a child. Warm, honest, melancholic. No clichés. Start mid-thought. No title.', it: 'Scrivi 60-90 parole di addio da genitore a figlio. Caldo, malinconico. Niente cliché. Inizia a metà pensiero.', es: 'Escribe 60-90 palabras de despedida. Cálido, melancólico. Sin clichés. Empieza en medio de un pensamiento.', fr: 'Écris 60-90 mots d adieu. Chaleureux, mélancolique. Pas de clichés. Commence au milieu d une pensée.', de: '60-90 Wörter Abschied. Warm, wehmütig. Keine Klischees. Mitten im Gedanken beginnen.', pt: 'Escreva 60-90 palavras de despedida. Calorosa, melancólica. Sem clichês. Comece no meio de um pensamento.' }
        };
        const prompt = (prompts[mode] ?? prompts['message'])[lang] ?? prompts['message']['en'];
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] }) });
        if (!claudeRes.ok) throw new Error(await claudeRes.text());
        const d = await claudeRes.json() as { content: Array<{type:string;text:string}> };
        const text = d.content.find(b => b.type === 'text')?.text ?? '';
        return json({ text }, 200, origin);
      } catch(e: unknown) { return err(e instanceof Error ? e.message : String(e), 500, origin); }
    }

    return err('Not found', 404, origin);
  },
};
