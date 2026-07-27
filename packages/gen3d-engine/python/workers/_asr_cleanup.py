"""Fix what the recogniser mishears, and nothing else.

Parakeet already gets punctuation, capitalisation, sentence breaks and number
formatting right — MEASURED on unpunctuated dictation, "three hundred and eighty
four" comes back as "384". What it gets wrong is words it has no reason to know:

    spoken            heard
    retopo            Retapa / Ratapo / "re factor the top works"
    cube part         kubepart / "Q part"
    whether           weather

That is a vocabulary problem, not a grammar problem, so this pass is scoped to
it. Anything broader is a downgrade: a model rewriting punctuation it was never
asked about will eventually "improve" a sentence the user actually said.

THE GUARD IS THE POINT. A language model handed a transcript will sometimes
answer it, summarise it, translate it, or continue it. Every result here is
checked against the raw transcript before it is allowed to replace it — word
count, similarity, and a floor on how much may change — and ANY failure falls
back to the raw text. The worst outcome for dictation is not a missed fix; it
is text the user never said.
"""

from __future__ import annotations

import difflib
import re
import time

# jedd asked for this one by name. Worth recording that it is a 3.58 GB Gemma-4
# (nvfp4, MLX) rather than the "<1 GB" originally scoped: MEASURED here, it
# loads in 2.7s and corrects in 0.25-0.93s, which is fast enough that the size
# costs memory rather than time. Swapping in a smaller model means changing
# these two constants and re-running test_asr_cleanup.py plus the dictation
# probe — the guard below is model-independent on purpose.
CLEANUP_REPO = "altic-dev/FluidIntelligence"
CLEANUP_SUBDIR = "models/fluid-1-nvfp4-mlx"

# Terms this app's users say out loud that a general model has no reason to
# spell correctly. Given to the model as a vocabulary, NOT as a substitution
# table: "retopo" must not be pattern-matched into text where it was not said.
GLOSSARY = (
    "retopo, retopology, voxel, mesh, MLX, Metal, TRELLIS, CubePart, GLB, "
    "UV unwrap, quad topology, marching cubes, safetensors, Parakeet, "
    "Electron, renderer, IPC, Bobble"
)

_SYSTEM = (
    "You correct speech-recognition transcripts. You are given one transcript "
    "and you return the same transcript with misheard words fixed.\n"
    "\n"
    "Fix ONLY:\n"
    "  - words misheard as similar-sounding ones (whether/weather, their/there)\n"
    f"  - technical terms misheard as ordinary words, from this vocabulary: {GLOSSARY}\n"
    "\n"
    "You may also drop filler words (um, uh, er).\n"
    "\n"
    "Change NOTHING else. Keep every other word exactly as given. Keep the "
    "punctuation, the capitalisation, the numbers and the sentence structure. "
    "Do not answer the transcript, do not summarise it, do not continue it, do "
    "not comment on it.\n"
    "\n"
    "Return only the corrected transcript."
)

# The model answers on a channel: `<|channel>thought ... <channel|>ANSWER`.
# Splitting on the closer is what makes the answer usable even on the runs where
# it thinks anyway despite being told not to.
_CHANNEL_CLOSE = "<channel|>"
_CHANNEL_OPEN = re.compile(r"<\|?channel\|?>[a-z]*")

# How different the result may be before it is treated as a rewrite rather than
# a correction. 0.72 admits several word-level fixes in a sentence and rejects a
# paraphrase; MEASURED against the fixtures in test_asr_cleanup.py.
MIN_SIMILARITY = 0.72
# A correction does not change how much was said.
MAX_WORD_DRIFT = 0.25
# Long transcripts cost proportionally, and dictation is the one place a user is
# waiting with a finished sentence on screen. Beyond this the raw text wins.
MAX_INPUT_CHARS = 1200

_model = None
_tokenizer = None


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def is_safe(raw: str, cleaned: str) -> tuple[bool, str]:
    """Would accepting `cleaned` risk showing the user something they did not say?

    Split out from the generation so it is testable without a 3.58 GB model,
    which is also the only reason the thresholds above can be tuned honestly.
    """
    if cleaned == "":
        return False, "empty"
    raw_w, new_w = _words(raw), _words(cleaned)
    if not raw_w:
        return False, "nothing to compare"
    drift = abs(len(new_w) - len(raw_w)) / len(raw_w)
    if drift > MAX_WORD_DRIFT:
        return False, f"word count moved {drift:.0%}"
    ratio = difflib.SequenceMatcher(None, raw_w, new_w).ratio()
    if ratio < MIN_SIMILARITY:
        return False, f"only {ratio:.0%} similar"
    # A model that starts explaining itself has stopped transcribing.
    lowered = cleaned.lstrip().lower()
    for lead in ("here is", "here's", "sure", "corrected transcript", "the transcript"):
        if lowered.startswith(lead):
            return False, "answered instead of corrected"
    return True, f"{ratio:.0%} similar"


def load(local_only: bool = True):
    """Load once, keep for the process. Returns None when not installed."""
    global _model, _tokenizer
    if _model is not None:
        return _model, _tokenizer
    from huggingface_hub import snapshot_download
    from mlx_lm import load as mlx_load

    root = snapshot_download(
        CLEANUP_REPO,
        allow_patterns=[f"{CLEANUP_SUBDIR}/*"],
        local_files_only=local_only,
    )
    _model, _tokenizer = mlx_load(f"{root}/{CLEANUP_SUBDIR}")
    return _model, _tokenizer


def _answer(out: str) -> str:
    """The transcript the model settled on, without its channel scaffolding."""
    text = out.split(_CHANNEL_CLOSE)[-1]
    text = _CHANNEL_OPEN.sub("", text).strip()
    # A model that thought out loud and never closed the channel has not given
    # an answer; returning its reasoning would be worse than returning nothing,
    # and the guard treats "" as a rejection.
    if _CHANNEL_CLOSE not in out and out.lstrip().startswith("<"):
        return ""
    return text.strip().strip('"')


def clean(raw: str, log=None) -> str:
    """Correct `raw`, or return it untouched if anything at all is off."""
    text = raw.strip()
    if text == "" or len(text) > MAX_INPUT_CHARS:
        return raw
    try:
        model, tokenizer = load()
        from mlx_lm import generate
        from mlx_lm.sample_utils import make_sampler

        messages = [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": text},
        ]
        # Thinking OFF. This model reasons by default and it is not free —
        # MEASURED on the same transcript, 3.70s thinking vs 0.67s not, for the
        # same correction. A user is watching a finished sentence while this
        # runs; 3 seconds of that is worse than the misheard word.
        try:
            prompt = tokenizer.apply_chat_template(
                messages, add_generation_prompt=True, enable_thinking=False
            )
        except TypeError:
            # A template that does not take the flag still works, just slower.
            prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True)
        t0 = time.time()
        out = generate(
            model,
            tokenizer,
            prompt=prompt,
            # Greedy. This is a correction task with one right answer; sampling
            # would make the same audio clean up differently run to run.
            sampler=make_sampler(temp=0.0),
            # A correction is never much longer than its input.
            max_tokens=min(512, len(text) // 2 + 64),
            verbose=False,
        )
        took = time.time() - t0
    except Exception as err:  # noqa: BLE001
        # Not installed, out of memory, an MLX kernel that does not like this
        # quantisation — none of it is a reason to lose the transcript.
        if log is not None:
            log(f"cleanup unavailable ({type(err).__name__}: {err}), keeping the raw transcript")
        return raw

    cleaned = _answer(out)
    ok, why = is_safe(text, cleaned)
    if log is not None:
        log(f"cleanup {'applied' if ok else 'REJECTED'} in {took:.2f}s ({why})")
    return cleaned if ok else raw
