/*!
 * MusikSparring AI SDK v3.0.0 — local-first LLM client for musicians.
 * Zero dependencies. Works in browsers (classic <script>) and Node 18+ (require).
 *
 * Providers: demo (offline), ollama, lmstudio, openai_compatible (llama.cpp / vLLM / Jan),
 *            anthropic, openai.
 *
 * External side effects: every provider except `demo` performs HTTP requests via fetch().
 * Nothing is persisted by this module; storage is the caller's responsibility.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MusikAI = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '3.0.0';

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  class MusikAIError extends Error {
    /**
     * @param {string} message
     * @param {{code?: string, status?: number, provider?: string, retryable?: boolean, cause?: unknown}} [info]
     */
    constructor(message, info = {}) {
      super(message);
      this.name = 'MusikAIError';
      this.code = info.code || 'unknown';
      this.status = info.status || 0;
      this.provider = info.provider || '';
      this.retryable = Boolean(info.retryable);
      if (info.cause !== undefined) this.cause = info.cause;
    }
  }

  // ---------------------------------------------------------------------------
  // Provider registry
  // ---------------------------------------------------------------------------

  const PROVIDERS = Object.freeze({
    demo: Object.freeze({
      id: 'demo',
      label: 'Demo (offline)',
      local: true,
      needsKey: false,
      baseUrl: '',
      defaultModel: 'demo',
      hint: 'Ingen netværk. Deterministiske forslag ud fra toneart og genre.',
    }),
    ollama: Object.freeze({
      id: 'ollama',
      label: 'Ollama (lokal)',
      local: true,
      needsKey: false,
      baseUrl: 'http://localhost:11434',
      defaultModel: 'llama3.1',
      hint: 'Start med OLLAMA_ORIGINS="*" ollama serve for at tillade browser-kald.',
    }),
    lmstudio: Object.freeze({
      id: 'lmstudio',
      label: 'LM Studio (lokal)',
      local: true,
      needsKey: false,
      baseUrl: 'http://localhost:1234/v1',
      defaultModel: '',
      hint: 'Aktivér "Enable CORS" under Developer → Server Settings i LM Studio.',
    }),
    openai_compatible: Object.freeze({
      id: 'openai_compatible',
      label: 'OpenAI-kompatibel server (llama.cpp / vLLM / Jan)',
      local: true,
      needsKey: false,
      baseUrl: 'http://localhost:8080/v1',
      defaultModel: '',
      hint: 'Enhver server med /v1/chat/completions. API-nøgle er valgfri.',
    }),
    anthropic: Object.freeze({
      id: 'anthropic',
      label: 'Anthropic Claude',
      local: false,
      needsKey: true,
      keyPrefix: 'sk-ant-',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-opus-5-5',
      hint: 'Nøglen sendes direkte fra browseren. Brug kun på din egen maskine.',
    }),
    openai: Object.freeze({
      id: 'openai',
      label: 'OpenAI',
      local: false,
      needsKey: true,
      keyPrefix: 'sk-',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
      hint: 'Nøglen sendes direkte fra browseren. Brug kun på din egen maskine.',
    }),
  });

  const ANTHROPIC_VERSION = '2023-06-01';

  // ---------------------------------------------------------------------------
  // Suggestion schema (shared by every provider that supports structured output)
  // ---------------------------------------------------------------------------

  const strArr = (desc) => ({ type: 'array', items: { type: 'string' }, description: desc });

  const SUGGESTION_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
      'summary', 'questions', 'directions', 'chords', 'melodies',
      'rhythm', 'arrangement', 'production', 'lyrics', 'actions',
    ],
    properties: {
      summary: { type: 'string', description: '1-2 sætninger: den overordnede kreative retning' },
      questions: strArr('2-4 korte afklarende spørgsmål'),
      directions: strArr('3-5 kreative retninger'),
      chords: {
        type: 'array',
        description: '3-5 akkordprogressioner der passer til toneart og genre',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'chords', 'note'],
          properties: {
            label: { type: 'string', description: 'Kort navn, fx "Vers" eller "I–V–vi–IV"' },
            chords: { type: 'array', items: { type: 'string' }, description: 'Akkordsymboler, fx ["Am","F","C","G"]' },
            note: { type: 'string', description: 'Hvorfor den virker / hvordan den bruges' },
          },
        },
      },
      melodies: strArr('3-4 melodiske ideer eller motiver'),
      rhythm: strArr('3-4 rytmiske patterns eller groove-ideer'),
      arrangement: strArr('3-4 arrangement-forslag'),
      production: strArr('3-4 produktion/mix tips'),
      lyrics: strArr('3-4 tekstlige temaer eller vinkler'),
      actions: strArr('3-5 konkrete next steps'),
    },
  });

  const SECTION_KEYS = Object.freeze([
    'questions', 'directions', 'melodies', 'rhythm', 'arrangement', 'production', 'lyrics', 'actions',
  ]);

  // ---------------------------------------------------------------------------
  // Mini music theory (enough for the demo provider + normalisation)
  // ---------------------------------------------------------------------------

  const NOTES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);
  const FLAT_TO_SHARP = Object.freeze({
    Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C',
  });

  /** @param {string} note */
  function normalizeNote(note) {
    if (!note) return null;
    const m = String(note).trim().match(/^([A-Ga-g])([#b♯♭]?)/);
    if (!m) return null;
    const acc = m[2].replace('♯', '#').replace('♭', 'b');
    const raw = m[1].toUpperCase() + acc;
    return FLAT_TO_SHARP[raw] || raw;
  }

  function transpose(note, semis) {
    const n = normalizeNote(note);
    if (!n) return null;
    return NOTES[(NOTES.indexOf(n) + semis + 1200) % 12];
  }

  /**
   * Parse "C dur", "Am", "A minor", "F# mol", "Bb major", "C" → {root, mode}.
   * @param {string} text
   */
  function parseKey(text) {
    if (!text) return null;
    const m = String(text).trim().match(/^([A-Ga-g][#b♯♭]?)\s*(.*)$/);
    if (!m) return null;
    const root = normalizeNote(m[1]);
    const rest = m[2].toLowerCase().trim();
    const minor = /^(m\b|min|minor|mol|aeolian|-)/.test(rest) || (/^m$/.test(rest));
    return { root, mode: minor ? 'minor' : 'major' };
  }

  const MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const MINOR = [0, 2, 3, 5, 7, 8, 10];
  const MAJOR_QUAL = ['', 'm', 'm', '', '', 'm', 'dim'];
  const MINOR_QUAL = ['m', 'dim', '', 'm', 'm', '', ''];

  /** Diatonic triads for a key. */
  function diatonicChords(root, mode) {
    const steps = mode === 'minor' ? MINOR : MAJOR;
    const quals = mode === 'minor' ? MINOR_QUAL : MAJOR_QUAL;
    return steps.map((s, i) => transpose(root, s) + quals[i]);
  }

  const CHORD_RE = /(?<![A-Za-z0-9#])([A-G])([#b♯♭]?)((?:maj7|maj9|maj13|maj|min7|min|m7b5|mMaj7|mmaj7|m7|m9|m11|m6|m|dim7|dim|aug|sus2|sus4|sus|add9|add11|7|9|11|13|6|5|°|ø|\+|Δ7|Δ|-7|-)?)(?:\/([A-G][#b♯♭]?))?(?![A-Za-z0-9#])/g;

  /**
   * Extract chord symbols from free text ("Am - F - C - G", "I love Dm7 here").
   * @param {string} text
   * @returns {string[]}
   */
  function tokenizeChords(text, opts = {}) {
    if (!text) return [];
    const out = [];
    let m;
    CHORD_RE.lastIndex = 0;
    while ((m = CHORD_RE.exec(String(text))) !== null) {
      const root = normalizeNote(m[1] + m[2]);
      const bass = m[4] ? normalizeNote(m[4]) : '';
      out.push(root + m[3] + (bass ? '/' + bass : ''));
    }
    if (opts.allowBare) return out;
    // In free prose a lone single letter ("A", "E") is usually a word, not a chord.
    const bare = out.filter((c) => /^[A-G]$/.test(c)).length;
    if (out.length < 2 && bare === out.length) return [];
    return out;
  }

  // ---------------------------------------------------------------------------
  // Prompt building (stable system prompt → cacheable prefix; params in user turn)
  // ---------------------------------------------------------------------------

  const SYSTEM_PROMPT = [
    'Du er en erfaren musikproducer, sangskriver og kreativ coach.',
    'Du hjælper musikere med konkrete, direkte anvendelige forslag til et musikprojekt.',
    'Svar altid på dansk, medmindre brugeren skriver på et andet sprog.',
    '',
    'Regler:',
    '- Vær specifik: nævn konkrete akkorder, intervaller, instrumenter, tempi og teknikker.',
    '- Akkordsymboler skrives som "Am", "F#m7", "Bbmaj7", "G/B" — ét symbol pr. element i "chords"-arrays.',
    '- Alle akkordprogressioner skal passe til den angivne toneart, hvis en er givet.',
    '- Hold hvert punkt kort (1-2 sætninger). Ingen indledning, ingen afslutning.',
    '- Returnér KUN gyldig JSON der matcher det givne skema. Ingen markdown, ingen kodeblokke.',
    '',
    'JSON-skema:',
    JSON.stringify(SUGGESTION_SCHEMA),
  ].join('\n');

  /**
   * @param {Record<string, string>} params
   * @returns {{system: string, user: string}}
   */
  function buildCoachPrompt(params = {}) {
    const field = (label, v) => `${label}: ${String(v || '').trim() || 'ikke angivet'}`;
    const user = [
      'Projektinfo:',
      field('Genre', params.genre),
      field('Mood/stemning', params.mood),
      field('BPM', params.bpm),
      field('Toneart', params.key),
      field('Referencer', params.references),
      field('Eksisterende materiale', params.existing),
      field('Begrænsninger', params.constraints),
      field('Mål', params.goals),
      '',
      'Generér forslag som JSON efter skemaet.',
    ].join('\n');
    return { system: SYSTEM_PROMPT, user };
  }

  // ---------------------------------------------------------------------------
  // JSON helpers
  // ---------------------------------------------------------------------------

  /**
   * Tolerant JSON extraction: strips code fences, finds the outermost object.
   * @param {string} text
   */
  function parseJSONLoose(text) {
    if (typeof text !== 'string') throw new MusikAIError('Svar var ikke tekst', { code: 'bad_response' });
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    try {
      return JSON.parse(t);
    } catch {
      /* fall through */
    }
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new MusikAIError('Kunne ikke finde JSON i svaret', { code: 'bad_json' });
    }
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch (e) {
      throw new MusikAIError('Ugyldig JSON i svaret', { code: 'bad_json', cause: e });
    }
  }

  const toStrList = (v) => {
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).map((s) => s.trim()).filter(Boolean);
    if (typeof v === 'string' && v.trim()) return v.split(/\n+/).map((s) => s.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean);
    return [];
  };

  /**
   * Normalise any model output into the canonical Suggestions shape.
   * Accepts legacy string-based chord lists.
   * @param {unknown} raw
   */
  function normalizeSuggestions(raw) {
    const obj = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
    const out = { summary: typeof obj.summary === 'string' ? obj.summary.trim() : '' };
    for (const k of SECTION_KEYS) out[k] = toStrList(obj[k]);

    const chordsRaw = Array.isArray(obj.chords) ? obj.chords : toStrList(obj.chords);
    out.chords = chordsRaw
      .map((item, i) => {
        if (item && typeof item === 'object') {
          const it = /** @type {Record<string, unknown>} */ (item);
          const list = Array.isArray(it.chords)
            ? it.chords.flatMap((c) => tokenizeChords(String(c), { allowBare: true }))
            : tokenizeChords(String(it.chords || it.progression || ''));
          return {
            label: String(it.label || it.name || `Progression ${i + 1}`).trim(),
            chords: list,
            note: String(it.note || it.why || it.description || '').trim(),
          };
        }
        const text = String(item);
        const list = tokenizeChords(text);
        const dash = text.search(/[:–—-]\s/);
        return {
          label: dash > 0 && dash < 40 ? text.slice(0, dash).trim() : `Progression ${i + 1}`,
          chords: list,
          note: text.trim(),
        };
      })
      .filter((p) => p.chords.length > 0 || p.note);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Demo provider — deterministic, offline
  // ---------------------------------------------------------------------------

  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function pick(list, seed, n) {
    const out = [];
    const copy = list.slice();
    let s = seed;
    while (out.length < n && copy.length) {
      s = (s * 1664525 + 1013904223) >>> 0;
      out.push(copy.splice(s % copy.length, 1)[0]);
    }
    return out;
  }

  /**
   * @param {Record<string, string>} params
   */
  function mockSuggestions(params = {}) {
    const key = parseKey(params.key) || { root: 'C', mode: 'major' };
    const genre = (params.genre || 'pop').trim();
    const mood = (params.mood || 'åben').trim();
    const bpm = String(params.bpm || '').trim() || (key.mode === 'minor' ? '92' : '120');
    const seed = hashString([genre, mood, key.root, key.mode, bpm].join('|'));
    const d = diatonicChords(key.root, key.mode);
    const prog = key.mode === 'major'
      ? [
          { label: 'I–V–vi–IV', chords: [d[0], d[4], d[5], d[3]], note: 'Den klassiske pop-loop. Stærk til omkvæd.' },
          { label: 'vi–IV–I–V', chords: [d[5], d[3], d[0], d[4]], note: 'Samme akkorder, mørkere start. God til vers.' },
          { label: 'I–IV–vi–V', chords: [d[0], d[3], d[5], d[4]], note: 'Løftende bevægelse, egner sig til pre-chorus.' },
          { label: 'ii–V–I', chords: [d[1] + '7', d[4] + '7', d[0] + 'maj7'], note: 'Jazz-farve til et break eller en bro.' },
        ]
      : [
          { label: 'i–VI–III–VII', chords: [d[0], d[5], d[2], d[6]], note: 'Episk mol-loop, bærer både vers og omkvæd.' },
          { label: 'i–iv–v', chords: [d[0], d[3], d[4]], note: 'Rå og enkel. Lad rytmen gøre arbejdet.' },
          { label: 'i–VII–VI–VII', chords: [d[0], d[6], d[5], d[6]], note: 'Pendulerende, hypnotisk. God til builds.' },
          { label: 'i–III–VII–iv', chords: [d[0] + '7', d[2], d[6], d[3]], note: 'Mere melankolsk med en dominant-farve på grundakkorden.' },
        ];

    const dirPool = [
      `Byg ${genre}-nummeret op omkring ét hook-motiv der går igen i både vokal og instrumental.`,
      `Lad ${mood}-stemningen styre lydvalget: find to signaturlyde og hold dig til dem.`,
      'Skriv omkvædet først, så ved du hvor verset skal lande.',
      'Prøv et halv-tempo-feel i bridge for kontrast.',
      'Overvej at starte nummeret midt i omkvædet (cold open).',
      `Kør en version i ${bpm} BPM og én 8 BPM lavere, og vælg den der føles mest naturlig at synge til.`,
    ];
    const melPool = [
      `Start melodien på kvinten (${transpose(key.root, 7)}) og land på grundtonen i slutningen af frasen.`,
      `Brug en gentaget rytmisk celle (fx ta-ta-taaa) på tonerne ${key.root}, ${transpose(key.root, key.mode === 'minor' ? 3 : 4)} og ${transpose(key.root, 7)}.`,
      'Lad omkvædet ligge en terts højere end verset for et tydeligt løft.',
      'Afslut omkvædet på en ikke-grundtone (fx sekst eller none) for at holde spændingen.',
      'Call-and-response mellem vokal og et instrument i 2-takters fraser.',
    ];
    const rhythmPool = [
      `Kick på 1 og 3, snare på 2 og 4, hi-hat i ottendedele med let swing — den sikre ${genre}-base.`,
      'Prøv et syncoperet kick-mønster (1, 2&, 3&) under et lige hi-hat-mønster.',
      'Halvtids-groove i verset, dobbelt tempo i omkvædet.',
      'Læg en percussion-loop (shaker/tamburin) i sekstendedele for fremdrift.',
      'Drop trommerne helt i sidste vers-linje før omkvædet.',
    ];
    const arrPool = [
      'Intro (4) → Vers (8) → Pre (4) → Omkvæd (8) → Vers (8) → Pre (4) → Omkvæd (8) → Bridge (8) → Omkvæd x2.',
      'Tilføj ét nyt element pr. sektion — aldrig alt på én gang.',
      'Lad bassen spille grundtoner i verset og gå i oktaver i omkvædet.',
      'Brug en counter-melodi i andet omkvæd for at holde lytteren.',
    ];
    const prodPool = [
      'Sidechain pads mod kick for at skabe luft.',
      'High-pass alt undtagen kick og bas ved 100-120 Hz.',
      'Dobbelt vokalen i omkvædet og panorér 30/30.',
      'Brug en kort plate-reverb på snare og en lang hall på vokal — kun i omkvædet.',
      'Automatisér filter-cutoff op gennem pre-chorus.',
    ];
    const lyrPool = [
      `Skriv ud fra ét konkret billede der matcher "${mood}" — et sted, et objekt, et tidspunkt.`,
      'Lad omkvædet være én sætning der kan stå alene.',
      'Vers = detaljer og scene, omkvæd = følelse og konklusion.',
      'Brug en gentagelse med variation: samme linje, nyt sidste ord.',
    ];
    const qPool = [
      'Er der en tekst eller en titel allerede?',
      'Skal nummeret kunne spilles live med få musikere?',
      `Hvor lang skal den færdige version være?`,
      'Hvilket instrument skal bære hooket?',
      'Er vokalen mandlig, kvindelig eller instrumental?',
    ];
    const actPool = [
      `Optag en 8-takters loop i ${key.root} ${key.mode === 'minor' ? 'mol' : 'dur'} ved ${bpm} BPM med progression 1.`,
      'Syng/spil tre forskellige hook-ideer over loopet og vælg én inden for 20 minutter.',
      'Lav en grov struktur-skitse med markører i din DAW.',
      'Skriv omkvædsteksten færdig før du rører ved mix.',
      'Book en 30-minutters feedback-session med en anden musiker.',
    ];

    return normalizeSuggestions({
      summary: `${genre} i ${key.root} ${key.mode === 'minor' ? 'mol' : 'dur'}, ${bpm} BPM, med en ${mood} grundstemning. Byg nummeret omkring ét stærkt hook og én tydelig lydpalet.`,
      questions: pick(qPool, seed + 1, 3),
      directions: pick(dirPool, seed + 2, 4),
      chords: prog,
      melodies: pick(melPool, seed + 3, 3),
      rhythm: pick(rhythmPool, seed + 4, 3),
      arrangement: pick(arrPool, seed + 5, 3),
      production: pick(prodPool, seed + 6, 4),
      lyrics: pick(lyrPool, seed + 7, 3),
      actions: pick(actPool, seed + 8, 4),
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP core
  // ---------------------------------------------------------------------------

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(abortError());
        }, { once: true });
      }
    });

  const abortError = () => new MusikAIError('Anmodning afbrudt', { code: 'aborted' });

  function joinUrl(base, path) {
    return String(base).replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');
  }

  /**
   * fetch with timeout + external abort signal.
   * EXTERNAL CALL: network request.
   */
  async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, signal, provider) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw abortError();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await fetchImpl(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      if (signal && signal.aborted) throw abortError();
      if (ctrl.signal.aborted) {
        throw new MusikAIError(`Timeout efter ${Math.round(timeoutMs / 1000)}s`, {
          code: 'timeout', provider, retryable: true, cause: e,
        });
      }
      throw new MusikAIError(
        'Netværksfejl — kører serveren, og tillader den CORS fra denne side?',
        { code: 'network', provider, retryable: true, cause: e },
      );
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async function readError(res) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* ignore */
    }
    try {
      const j = JSON.parse(text);
      return j?.error?.message || j?.error || j?.message || text;
    } catch {
      return text;
    }
  }

  function retryDelay(attempt, res) {
    const ra = res && res.headers && res.headers.get && res.headers.get('retry-after');
    const secs = ra ? Number(ra) : NaN;
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 30000);
    return Math.min(800 * 2 ** attempt + Math.random() * 300, 15000);
  }

  // ---------------------------------------------------------------------------
  // Provider adapters: (client, req) → { url, init, parse(json) → text }
  // ---------------------------------------------------------------------------

  function openAIStyleBody(client, req, schemaMode) {
    const body = {
      model: client.model,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        ...req.messages,
      ],
      temperature: req.temperature,
    };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.json && schemaMode === 'json_schema' && req.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'musiksparring', strict: true, schema: req.schema },
      };
    } else if (req.json && schemaMode) {
      body.response_format = { type: 'json_object' };
    }
    return body;
  }

  const parseOpenAI = (data) => {
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new MusikAIError('Tomt svar fra serveren', { code: 'bad_response' });
    if (msg.refusal) throw new MusikAIError(`Modellen afviste: ${msg.refusal}`, { code: 'refusal' });
    return { text: msg.content || '', usage: data.usage || null, model: data.model || '' };
  };

  const ADAPTERS = {
    ollama: {
      build(client, req) {
        const body = {
          model: client.model,
          stream: false,
          messages: [
            ...(req.system ? [{ role: 'system', content: req.system }] : []),
            ...req.messages,
          ],
          options: { temperature: req.temperature, ...(req.maxTokens ? { num_predict: req.maxTokens } : {}) },
        };
        if (req.json) body.format = req.schema || 'json';
        return { url: joinUrl(client.baseUrl, '/api/chat'), body };
      },
      parse(data) {
        const text = data?.message?.content;
        if (typeof text !== 'string') throw new MusikAIError('Tomt svar fra Ollama', { code: 'bad_response' });
        return {
          text,
          model: data.model || '',
          usage: data.eval_count ? { input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count } : null,
        };
      },
      modelsUrl: (client) => joinUrl(client.baseUrl, '/api/tags'),
      parseModels: (data) => (data?.models || []).map((m) => m.name).filter(Boolean),
    },
    lmstudio: {
      build(client, req) {
        return { url: joinUrl(client.baseUrl, '/chat/completions'), body: openAIStyleBody(client, req, 'json_schema') };
      },
      parse: parseOpenAI,
      modelsUrl: (client) => joinUrl(client.baseUrl, '/models'),
      parseModels: (data) => (data?.data || []).map((m) => m.id).filter(Boolean),
    },
    openai_compatible: {
      build(client, req) {
        return { url: joinUrl(client.baseUrl, '/chat/completions'), body: openAIStyleBody(client, req, 'json_object') };
      },
      parse: parseOpenAI,
      modelsUrl: (client) => joinUrl(client.baseUrl, '/models'),
      parseModels: (data) => (data?.data || []).map((m) => m.id).filter(Boolean),
    },
    openai: {
      build(client, req) {
        return { url: joinUrl(client.baseUrl, '/chat/completions'), body: openAIStyleBody(client, req, 'json_schema') };
      },
      parse: parseOpenAI,
      modelsUrl: (client) => joinUrl(client.baseUrl, '/models'),
      parseModels: (data) => (data?.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d)/.test(id)).sort(),
    },
    anthropic: {
      build(client, req) {
        const body = {
          model: client.model,
          max_tokens: req.maxTokens || 8192,
          // Stable system prompt first → cacheable prefix. Volatile params live in the user turn.
          system: req.system
            ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
            : undefined,
          messages: req.messages,
          output_config: { effort: client.effort },
        };
        if (req.json && req.schema) {
          body.output_config.format = { type: 'json_schema', schema: req.schema };
        }
        return { url: joinUrl(client.baseUrl, '/v1/messages'), body };
      },
      parse(data) {
        if (data?.stop_reason === 'refusal') {
          const why = data?.stop_details?.explanation || data?.stop_details?.category || 'policy';
          throw new MusikAIError(`Claude afviste anmodningen (${why})`, { code: 'refusal' });
        }
        const text = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (!text) throw new MusikAIError('Tomt svar fra Claude', { code: 'bad_response' });
        return { text, model: data.model || '', usage: data.usage || null, stopReason: data.stop_reason };
      },
      modelsUrl: (client) => joinUrl(client.baseUrl, '/v1/models'),
      parseModels: (data) => (data?.data || []).map((m) => m.id).filter(Boolean),
    },
  };

  function headersFor(client) {
    const h = { 'content-type': 'application/json' };
    if (client.provider === 'anthropic') {
      h['x-api-key'] = client.apiKey;
      h['anthropic-version'] = ANTHROPIC_VERSION;
      h['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (client.apiKey) {
      h.authorization = `Bearer ${client.apiKey}`;
    }
    return h;
  }

  // ---------------------------------------------------------------------------
  // Client
  // ---------------------------------------------------------------------------

  const DEFAULTS = Object.freeze({
    provider: 'demo',
    model: '',
    baseUrl: '',
    apiKey: '',
    timeoutMs: 120000,
    maxRetries: 2,
    temperature: 0.8,
    effort: 'medium',
    fetch: null,
  });

  /**
   * @param {Partial<typeof DEFAULTS>} [config]
   */
  function createClient(config = {}) {
    const cfg = { ...DEFAULTS, ...config };
    const meta = PROVIDERS[cfg.provider];
    if (!meta) {
      throw new MusikAIError(`Ukendt provider "${cfg.provider}"`, { code: 'config' });
    }
    const fetchImpl = cfg.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

    const client = {
      version: VERSION,
      provider: meta.id,
      meta,
      model: (cfg.model || meta.defaultModel || '').trim(),
      baseUrl: (cfg.baseUrl || meta.baseUrl || '').trim(),
      apiKey: (cfg.apiKey || '').trim(),
      timeoutMs: cfg.timeoutMs,
      maxRetries: cfg.maxRetries,
      temperature: cfg.temperature,
      effort: cfg.effort,
      isLocal: meta.local,
    };

    function validate() {
      if (client.provider === 'demo') return;
      if (!fetchImpl) throw new MusikAIError('fetch() er ikke tilgængelig i dette miljø', { code: 'config' });
      if (meta.needsKey && !client.apiKey) {
        throw new MusikAIError(`${meta.label} kræver en API-nøgle`, { code: 'missing_key', provider: client.provider });
      }
      if (meta.keyPrefix && client.apiKey && !client.apiKey.startsWith(meta.keyPrefix)) {
        throw new MusikAIError(`API-nøgle til ${meta.label} skal starte med "${meta.keyPrefix}"`, {
          code: 'bad_key', provider: client.provider,
        });
      }
      if (!client.model) {
        throw new MusikAIError('Vælg en model (hent listen fra serveren eller skriv navnet)', {
          code: 'missing_model', provider: client.provider,
        });
      }
    }

    /**
     * Low-level chat call. Returns raw text.
     * EXTERNAL CALL (all providers except demo).
     * @param {{system?: string, prompt?: string, messages?: {role: string, content: string}[], json?: boolean,
     *          schema?: object, temperature?: number, maxTokens?: number, signal?: AbortSignal}} req
     */
    async function chat(req = {}) {
      const started = Date.now();
      const messages = req.messages || [{ role: 'user', content: String(req.prompt || '') }];
      if (client.provider === 'demo') {
        await sleep(350 + Math.random() * 400, req.signal);
        return {
          text: JSON.stringify(mockSuggestions(req.demoParams || {})),
          provider: 'demo', model: 'demo', usage: null, durationMs: Date.now() - started,
        };
      }
      validate();
      const adapter = ADAPTERS[client.provider];
      const normalized = {
        system: req.system || '',
        messages,
        json: Boolean(req.json),
        schema: req.schema || null,
        temperature: typeof req.temperature === 'number' ? req.temperature : client.temperature,
        maxTokens: req.maxTokens || 0,
      };

      let attempt = 0;
      let dropFormat = false;
      for (;;) {
        const built = adapter.build(client, dropFormat ? { ...normalized, json: false } : normalized);
        const res = await fetchWithTimeout(
          fetchImpl, built.url,
          { method: 'POST', headers: headersFor(client), body: JSON.stringify(built.body) },
          client.timeoutMs, req.signal, client.provider,
        );
        if (res.ok) {
          let data;
          try {
            data = await res.json();
          } catch (e) {
            throw new MusikAIError('Serveren svarede ikke med JSON', { code: 'bad_response', provider: client.provider, cause: e });
          }
          const parsed = adapter.parse(data);
          return { ...parsed, provider: client.provider, durationMs: Date.now() - started };
        }
        const detail = await readError(res);
        const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
        // Servers that reject structured output: retry once in plain mode (prompt still demands JSON).
        if (res.status === 400 && normalized.json && !dropFormat && /format|schema|json/i.test(String(detail))) {
          dropFormat = true;
          continue;
        }
        if (retryable && attempt < client.maxRetries) {
          await sleep(retryDelay(attempt, res), req.signal);
          attempt += 1;
          continue;
        }
        const code = res.status === 401 || res.status === 403 ? 'auth'
          : res.status === 404 ? 'not_found'
          : res.status === 429 ? 'rate_limit'
          : res.status >= 500 ? 'server' : 'http';
        throw new MusikAIError(`${meta.label} fejl ${res.status}: ${String(detail).slice(0, 300)}`, {
          code, status: res.status, provider: client.provider, retryable,
        });
      }
    }

    /**
     * Chat + tolerant JSON parse.
     */
    async function generateJSON(req = {}) {
      const r = await chat({ ...req, json: true });
      const data = parseJSONLoose(r.text);
      return { data, meta: r };
    }

    /**
     * High-level: project params → normalised Suggestions.
     * @param {Record<string, string>} params
     * @param {{signal?: AbortSignal, temperature?: number, maxTokens?: number}} [opts]
     */
    async function generateSuggestions(params, opts = {}) {
      const { system, user } = buildCoachPrompt(params);
      const { data, meta: m } = await generateJSON({
        system, prompt: user, schema: SUGGESTION_SCHEMA, demoParams: params, ...opts,
      });
      const suggestions = normalizeSuggestions(data);
      const filled = SECTION_KEYS.filter((k) => suggestions[k].length).length + (suggestions.chords.length ? 1 : 0);
      if (filled === 0) {
        throw new MusikAIError('Modellen returnerede ingen brugbare forslag', { code: 'empty', provider: client.provider });
      }
      return { suggestions, meta: m };
    }

    /**
     * List models from the provider. EXTERNAL CALL.
     * @returns {Promise<string[]>}
     */
    async function listModels(signal) {
      if (client.provider === 'demo') return ['demo'];
      if (!fetchImpl) throw new MusikAIError('fetch() er ikke tilgængelig', { code: 'config' });
      const adapter = ADAPTERS[client.provider];
      const res = await fetchWithTimeout(
        fetchImpl, adapter.modelsUrl(client), { method: 'GET', headers: headersFor(client) },
        Math.min(client.timeoutMs, 15000), signal, client.provider,
      );
      if (!res.ok) {
        throw new MusikAIError(`${meta.label}: kunne ikke hente modeller (${res.status})`, {
          code: res.status === 401 ? 'auth' : 'http', status: res.status, provider: client.provider,
        });
      }
      return adapter.parseModels(await res.json());
    }

    /**
     * Connectivity check. Never throws; returns {ok, latencyMs, models, error}.
     */
    async function ping(signal) {
      const t0 = Date.now();
      try {
        const models = await listModels(signal);
        return { ok: true, latencyMs: Date.now() - t0, models, error: null };
      } catch (e) {
        return { ok: false, latencyMs: Date.now() - t0, models: [], error: e instanceof Error ? e.message : String(e) };
      }
    }

    client.chat = chat;
    client.generateJSON = generateJSON;
    client.generateSuggestions = generateSuggestions;
    client.listModels = listModels;
    client.ping = ping;
    client.validate = validate;
    return client;
  }

  // ---------------------------------------------------------------------------
  // Export helpers (Markdown for sharing)
  // ---------------------------------------------------------------------------

  const SECTION_TITLES = Object.freeze({
    questions: 'Afklarende spørgsmål',
    directions: 'Kreative retninger',
    chords: 'Akkordprogressioner',
    melodies: 'Melodiske ideer',
    rhythm: 'Rytme & groove',
    arrangement: 'Arrangement',
    production: 'Produktion & mix',
    lyrics: 'Tekst',
    actions: 'Next steps',
  });

  function suggestionsToMarkdown(s, params = {}) {
    const lines = ['# MusikSparring — forslag', ''];
    const meta = Object.entries(params).filter(([, v]) => v && String(v).trim());
    if (meta.length) {
      lines.push(meta.map(([k, v]) => `- **${k}**: ${String(v).trim()}`).join('\n'), '');
    }
    if (s.summary) lines.push(`> ${s.summary}`, '');
    for (const k of ['questions', 'directions', 'chords', 'melodies', 'rhythm', 'arrangement', 'production', 'lyrics', 'actions']) {
      const items = s[k];
      if (!items || !items.length) continue;
      lines.push(`## ${SECTION_TITLES[k]}`);
      for (const it of items) {
        if (k === 'chords') lines.push(`- **${it.label}**: \`${it.chords.join(' – ')}\`${it.note ? ' — ' + it.note : ''}`);
        else lines.push(`- ${it}`);
      }
      lines.push('');
    }
    return lines.join('\n').trim() + '\n';
  }

  return Object.freeze({
    VERSION,
    PROVIDERS,
    SUGGESTION_SCHEMA,
    SECTION_KEYS,
    SECTION_TITLES,
    MusikAIError,
    createClient,
    buildCoachPrompt,
    parseJSONLoose,
    normalizeSuggestions,
    mockSuggestions,
    suggestionsToMarkdown,
    theory: Object.freeze({ NOTES, normalizeNote, transpose, parseKey, diatonicChords, tokenizeChords }),
  });
});
