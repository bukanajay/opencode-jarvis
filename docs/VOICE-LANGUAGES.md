# Talking to Jarvis in Hindi or Marathi (2026-10-26)

Settings → Voice → **I talk to Jarvis in**: English, Hindi / Hinglish, or
Marathi (`listenLanguage`, also settable by voice). It changes four things.

| | English | Hindi / Hinglish | Marathi |
|---|---|---|---|
| Hears you with | Parakeet | Whisper, Oriserve Apex (romanized Hinglish) | Whisper large-v3-turbo, `mr` (Devanagari) |
| Model | built in | `npm run fetch:whisper-model` | `npm run fetch:whisper-model -- multilingual` |
| Brain replies | English | Hindi / Hinglish, spoken line in Devanagari | Marathi, spoken line in Devanagari |
| Speaks with | your voice | your voice if it is a Hindi one, else Omega | same, Marathi pronunciation |

## What was broken

Speaking Marathi in voice mode went wrong at both ends. Parakeet (25
European languages) turned Marathi into Spanish- and French-looking words,
so the brain got nonsense. And FluidAudio's Kokoro always sounded words out
with eSpeak's **American English** rules (hard-coded `en-us`): every
Devanagari word came out as "he …enus". Whisper reading the old output
back: "ही नमस्कारेनूस, ही अजयेनूस, ही आजच्येनूस…". That is what the mic then
heard and showed as "he actoyanos, he ajayanos…".

## What changed

- **Voice:** `patches/fluidaudio-devanagari-g2p.patch` (applied by
  `build-parakeet.sh` after cloning FluidAudio): Devanagari words go to
  eSpeak's Hindi or Marathi rules (`FLUIDAUDIO_DEVANAGARI_VOICE`, set by
  `tts.js` from the language), everything else stays English. Kokoro's four
  Hindi voices (Omega, Psi, Alpha, Beta) are in the voice list, labelled
  Hindi / Marathi. English words inside a Marathi reply come out in an
  Indian accent ("pull request", "tests pass").
- **Hearing:** the one-shot helper takes `--engine whisper --model …
  --language hi|mr`; `audio.js` adds them from the setting (`languageArgs`).
- **Wake word:** `latinWake` turns Devanagari "hey Jarvis" (a pattern:
  जार्विस, जारविस, जार्व्हिस, and हिजार विस as Whisper ran it together)
  into Latin before the gate.
- **Brain:** voice turns in Hindi / Marathi ask for a reply in that language
  and a speak line in Devanagari (romanized Hindi would be read as English).

## Checked

- Whisper reading the new voices back: Hindi (Omega) word-perfect, Hindi
  (Alpha) near-perfect, Marathi (both) near-perfect.
- The loop: Jarvis's Marathi voice saying "हे जार्विस, आजच्या मीटिंगचा सारांश
  सांग" → listened to in Marathi mode → a wake turn "आजच्या मिटिंचा साराश
  सांग".
- Samples to listen to: `voice-samples/indic/` (Hindi, Marathi, Marathi +
  English, and the old English-rules version for comparison).
- Not yet: your own Marathi / Hindi speech, live.

## Limits

- Whisper loads per utterance in voice mode (the helper is one-shot), so a
  Hindi / Marathi reply starts ~1–2 s later than an English one.
- Kokoro lists its Hindi voices as experimental; Marathi borrows them with
  Marathi pronunciation rules. Judge by ear.
