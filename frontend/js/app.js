const WORKER_URL = 'https://postmortem-worker.myfox.workers.dev';

// State
let mediaRecorder = null;
let audioChunks   = [];
let audioBlob     = null;
let voiceId       = null;
let recInterval   = null;
let recSeconds    = 0;
let isPlaying     = false;

// Vault page routing
const params  = new URLSearchParams(location.search);
const vaultId = params.get('vault');

if (vaultId) {
  document.getElementById('main-page').style.display = 'none';
  document.getElementById('vault-page').style.display = 'flex';
  initVaultPage(vaultId);
}

// Build waveform bars
(function buildWaveform() {
  const wf = document.getElementById('waveform');
  for (let i = 0; i < 40; i++) {
    const b = document.createElement('div');
    b.className = 'wave-bar';
    b.style.setProperty('--h', (8 + Math.random() * 44) + 'px');
    wf.appendChild(b);
  }
})();

// Step navigation
function goStep(n) {
  document.querySelectorAll('.step-panel').forEach((p, i) => {
    p.classList.toggle('active', i + 1 === n);
  });
  document.querySelectorAll('.step-tab').forEach((t, i) => {
    t.classList.remove('active', 'done');
    if (i + 1 === n) t.classList.add('active');
    if (i + 1 < n)   t.classList.add('done');
  });
  document.getElementById('app').scrollIntoView({ behavior: 'smooth' });
}

// Unlock type toggle
document.querySelectorAll('input[name="unlock-type"]').forEach(r => {
  r.addEventListener('change', () => {
    const isDate = r.value === 'date';
    document.getElementById('date-field').style.display = isDate ? '' : 'none';
    document.getElementById('code-field').style.display = isDate ? 'none' : '';
  });
});

// Character counter
document.getElementById('message-text').addEventListener('input', function () {
  document.getElementById('char-count').textContent = this.value.length + ' characters';
});

// Recording
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks   = [];

    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.onstop = () => {
      audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      document.getElementById('clone-btn').disabled = false;
      setRecStatus('done', 'Recording complete — ready to clone');
    };

    mediaRecorder.start();
    recSeconds = 0;
    document.getElementById('rec-start-btn').disabled = true;
    document.getElementById('rec-stop-btn').disabled  = false;
    document.getElementById('waveform').classList.add('recording');
    setRecStatus('active', '&#9679; Recording…');

    recInterval = setInterval(() => {
      recSeconds++;
      const m = Math.floor(recSeconds / 60);
      const s = String(recSeconds % 60).padStart(2, '0');
      document.getElementById('rec-timer').textContent = `${m}:${s}`;
      document.querySelectorAll('.wave-bar').forEach(b => {
        b.style.setProperty('--h', (6 + Math.random() * 48) + 'px');
      });
    }, 1000);

  } catch (e) {
    setRecStatus('', 'Microphone access denied. Please upload a file instead.');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
  }
  clearInterval(recInterval);
  document.getElementById('rec-start-btn').disabled = false;
  document.getElementById('rec-stop-btn').disabled  = true;
  document.getElementById('waveform').classList.remove('recording');
}

function handleUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  audioBlob = file;
  document.getElementById('clone-btn').disabled = false;
  setRecStatus('done', 'File loaded: ' + file.name);
}

function setRecStatus(cls, msg) {
  const el = document.getElementById('rec-status');
  el.className = cls;
  el.innerHTML = msg;
}

// Clone voice
async function cloneVoice() {
  if (voiceId && !audioBlob) {
    showStatus(document.getElementById('clone-status'), 'success', '&#10003; Voice ID loaded. Proceed to write your message.');
    setTimeout(() => goStep(2), 800);
    return;
  }

  if (!audioBlob) return;
  const btn    = document.getElementById('clone-btn');
  const status = document.getElementById('clone-status');

  btn.disabled = true;
  showStatus(status, '', '<span class="spinner"></span> Cloning your voice…');

  try {
    const fd = new FormData();
    fd.append('audio', audioBlob, 'voice_sample.webm');

    const res  = await fetch(WORKER_URL + '/clone', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Clone failed');

    voiceId = data.voice_id;
    showStatus(status, 'success', '&#10003; Voice cloned. Proceed to write your message.');
    setTimeout(() => goStep(2), 1200);

  } catch (e) {
    showStatus(status, 'error', 'Error: ' + e.message);
    btn.disabled = false;
  }
}

// Seal vault
async function sealVault() {
  const recipient  = document.getElementById('recipient-name').value.trim();
  const text       = document.getElementById('message-text').value.trim();
  const sender     = document.getElementById('sender-name').value.trim();
  const unlockType = document.querySelector('input[name="unlock-type"]:checked').value;
  const unlockVal  = unlockType === 'date'
    ? document.getElementById('unlock-date').value
    : document.getElementById('unlock-code').value.trim();
  const status = document.getElementById('seal-status');

  if (!recipient || !text || !sender || !unlockVal) {
    showStatus(status, 'error', 'Please fill in all fields.');
    return;
  }
  if (!voiceId) {
    showStatus(status, 'error', 'No voice clone found. Go back to step one.');
    return;
  }

  const btn = document.getElementById('seal-btn');
  btn.disabled = true;
  showStatus(status, '', '<span class="spinner"></span> Generating your voice and sealing the vault…');

  try {
    const res = await fetch(WORKER_URL + '/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_id: voiceId, text, recipient, sender, unlock_type: unlockType, unlock_value: unlockVal })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to seal vault');

    const vaultUrl = location.origin + '?vault=' + data.vault_id;
    document.getElementById('vault-link-display').textContent = vaultUrl;

    if (unlockType === 'code') {
      document.getElementById('code-reminder').style.display = '';
      document.getElementById('code-display-reminder').textContent = '"' + unlockVal + '"';
    }

    goStep(4);

    if (voiceId) document.getElementById('voice-id-display').textContent = voiceId;

  } catch (e) {
    showStatus(status, 'error', 'Error: ' + e.message);
    btn.disabled = false;
  }
}

// Vault player
async function initVaultPage(id) {
  try {
    const res  = await fetch(WORKER_URL + '/vault/' + id + '/status');
    const data = await res.json();

    if (data.unlock_type === 'date') {
      document.querySelector('#vault-locked p').textContent =
      'This vault is time-locked. It opens on its scheduled date.';
      document.getElementById('vault-code-input').style.display = 'none';
      document.getElementById('unlock-btn').textContent = 'Open the Vault';
    }
  } catch (e) { /* silent */ }
}

async function unlockVault() {
  const status    = document.getElementById('vault-status');
  const btn       = document.getElementById('unlock-btn');
  const codeInput = document.getElementById('vault-code-input');
  const isDate    = codeInput.style.display === 'none';
  const code      = isDate ? '' : codeInput.value.trim();

  if (!isDate && !code) {
    showStatus(status, 'error', 'Please enter the access code.');
    return;
  }

  btn.disabled = true;
  showStatus(status, '', '<span class="spinner"></span> Verifying…');

  try {
    const res  = await fetch(WORKER_URL + '/vault/' + vaultId + '/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code || '' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Invalid code or vault not yet unlocked');

    document.getElementById('vault-locked').style.display = 'none';

    const player = document.getElementById('audio-player');
    player.classList.add('visible');

    document.getElementById('audio-from').textContent = 'A message from ' + data.sender;
    document.getElementById('audio-date').textContent = new Date(data.created_at).toLocaleDateString('en-GB', {
      year: 'numeric', month: 'long', day: 'numeric'
    });
    document.getElementById('audio-msg-text').textContent = data.text || '';

    const audio = document.getElementById('vault-audio');
    audio.src   = WORKER_URL + data.audio_url;
    audio.load();

  } catch (e) {
    showStatus(status, 'error', e.message);
    btn.disabled = false;
  }
}

function togglePlay() {
  const audio = document.getElementById('vault-audio');
  const btn   = document.getElementById('play-btn');
  if (isPlaying) {
    audio.pause();
    btn.innerHTML = '&#9654;';
    isPlaying = false;
  } else {
    audio.play();
    btn.innerHTML = '&#9646;&#9646;';
    isPlaying = true;
    audio.onended = () => { btn.innerHTML = '&#9654;'; isPlaying = false; };
  }
}

function copyVaultLink() {
  const url = document.getElementById('vault-link-display').textContent;
  navigator.clipboard.writeText(url).then(() => alert('Link copied!'));
}

function resetAll() {
  voiceId = null;
  audioBlob = null;
  document.getElementById('message-text').value    = '';
  document.getElementById('recipient-name').value  = '';
  document.getElementById('sender-name').value     = '';
  document.getElementById('rec-timer').textContent = '0:00';
  setRecStatus('', 'Ready to record');
  document.getElementById('clone-btn').disabled     = true;
  document.getElementById('rec-start-btn').disabled = false;
  document.querySelectorAll('.status-box').forEach(b => b.classList.remove('visible', 'error', 'success'));
  goStep(1);
}

function copyVoiceId() {
  navigator.clipboard.writeText(voiceId).then(() => alert('Voice ID copied!'));
}

function useExistingVoiceId() {
  const id = document.getElementById('existing-voice-id').value.trim();
  if (!id) return;
  voiceId = id;
  document.getElementById('clone-btn').disabled = false;
  setRecStatus('done', 'Voice ID loaded — ready to proceed.');
}

// AI helper modal
let currentModalMode = 'record';

const PROMPTS = {
  record: {
    en: 'Write a 60-second reading script (about 150 words) for someone who wants to clone their voice using AI. Natural, emotional, varied in rhythm. Like a personal letter or reflection. No title, just the text.',
    it: "Scrivi un testo da leggere ad alta voce di circa 150 parole per clonare la voce con l'AI. Naturale, emotivo, vario nel ritmo. Come una lettera personale. Solo il testo, nessun titolo.",
    es: 'Escribe un texto de lectura de unos 150 palabras para clonar la voz con IA. Natural, emotivo, variado. Como una carta personal. Solo el texto, sin título.',
    fr: "Écris un texte de lecture d'environ 150 mots pour cloner sa voix avec l'IA. Naturel, émouvant, varié. Comme une lettre personnelle. Juste le texte, sans titre.",
    de: 'Schreibe einen Lesetext von etwa 150 Wörtern zum Klonen der Stimme mit KI. Natürlich, emotional, abwechslungsreich. Wie ein persönlicher Brief. Nur den Text, ohne Titel.',
    pt: 'Escreva um texto de leitura de cerca de 150 palavras para clonar a voz com IA. Natural, emotivo, variado. Como uma carta pessoal. Apenas o texto, sem título.'
  },
  message: {
    en: "Write a short, deeply personal farewell voice message (60-90 words) from a parent to their child or to someone they love. Warm, honest, a little melancholic. No clichés. Don't start with 'I love you'. Start in the middle of a thought. No title.",
    it: "Scrivi un breve messaggio vocale di addio (60-90 parole) da un genitore al figlio o a qualcuno che ama. Caldo, onesto, malinconico. Niente cliché. Non iniziare con 'ti voglio bene'. Inizia nel mezzo di un pensiero. Solo il testo.",
    es: "Escribe un breve mensaje de voz de despedida (60-90 palabras). Cálido, honesto, melancólico. Sin clichés. No empieces con 'te quiero'. Empieza en medio de un pensamiento. Solo el texto.",
    fr: "Écris un court message vocal d'adieu (60-90 mots). Chaleureux, honnête, mélancolique. Pas de clichés. Ne commence pas par 'je t'aime'. Commence au milieu d'une pensée. Juste le texte.",
    de: "Schreibe eine kurze Abschiedsvoicenachricht (60-90 Wörter). Warm, ehrlich, wehmütig. Keine Klischees. Nicht mit 'Ich liebe dich' anfangen. Mitten in einem Gedanken beginnen. Nur den Text.",
    pt: "Escreva uma curta mensagem de despedida (60-90 palavras). Calorosa, honesta, melancólica. Sem clichês. Não comece com 'eu te amo'. Comece no meio de um pensamento. Apenas o texto."
  }
};

const LANG_LABELS = { en: 'English', it: 'Italiano', es: 'Español', fr: 'Français', de: 'Deutsch', pt: 'Português' };

function openModal(mode) {
  currentModalMode = mode;
  const isRecord = mode === 'record';
  document.getElementById('modal-title').textContent    = isRecord ? 'Generate a reading script' : 'Generate your message';
  document.getElementById('modal-desc').textContent     = isRecord
    ? "Choose a language — we'll write a 60-second script to read aloud while recording."
    : "Choose a language — we'll write a heartfelt message you can personalise.";
  document.getElementById('generated-text').className   = 'generated-text';
  document.getElementById('generated-text').textContent = '';
  document.getElementById('modal-status').className     = 'status-box';
  document.getElementById('modal-actions').style.display = 'none';
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

function closeModalOutside(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

async function generateText(lang) {
  const status  = document.getElementById('modal-status');
  const textBox = document.getElementById('generated-text');
  const actions = document.getElementById('modal-actions');

  textBox.className   = 'generated-text';
  textBox.textContent = '';
  actions.style.display = 'none';
  showStatus(status, '', '<span class="spinner"></span> Writing in ' + LANG_LABELS[lang] + '…');

  try {
    const res = await fetch(WORKER_URL + '/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, mode: currentModalMode })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');

    status.className        = 'status-box';
    textBox.textContent     = data.text;
    textBox.className       = 'generated-text visible';
    actions.style.display   = 'flex';

  } catch (e) {
    showStatus(status, 'error', 'Error: ' + e.message);
  }
}

function useGeneratedText() {
  const text = document.getElementById('generated-text').textContent;
  if (!text) return;
  if (currentModalMode === 'record') {
    closeModal();
    showReadingScript(text);
  } else {
    document.getElementById('message-text').value = text;
    document.getElementById('char-count').textContent = text.length + ' characters';
    closeModal();
  }
}

function showReadingScript(text) {
  let panel = document.getElementById('reading-script-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'reading-script-panel';
    panel.style.cssText = [
      'position:fixed', 'bottom:0', 'left:0', 'right:0',
      'background:#18160f', 'border-top:1px solid rgba(184,150,90,0.3)',
      'padding:1.5rem 2rem', 'z-index:500',
      'max-height:40vh', 'overflow-y:auto',
      "font-family:'Cormorant Garamond',serif",
      'font-size:1.05rem', 'line-height:1.8', 'color:#f5f0e8'
    ].join(';');
    document.body.appendChild(panel);
  }
  panel.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">' +
      '<span style="font-family:\'Courier Prime\',monospace;font-size:0.62rem;letter-spacing:0.2em;color:#b8965a;text-transform:uppercase">Reading script — read this aloud while recording</span>' +
      '<button onclick="document.getElementById(\'reading-script-panel\').remove()" style="background:none;border:none;color:#7a7268;cursor:pointer;font-size:1.1rem">&#10005;</button>' +
    '</div>' +
    '<p style="font-style:italic">' + text + '</p>';
}

// Shared helper
function showStatus(el, type, msg) {
  el.className = 'status-box visible' + (type ? ' ' + type : '');
  el.innerHTML = msg;
}
