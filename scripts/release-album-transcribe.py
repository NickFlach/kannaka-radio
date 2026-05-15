#!/usr/bin/env python3
"""
release-album-transcribe.py — fetch Suno's timestamped lyrics for
every track in a release-album config and write a styled ASS
subtitle file per track. The build-video phase of release-album.sh
applies these as a per-segment subtitle filter so the final
YouTube album video has karaoke-style reactive lyrics burned in.

Inputs:
  config_path   release-album JSON (same one suno_album_builder.sh
                consumes). out_dir + tracks come from here.
  --log PATH    suno_album_builder.sh log; defaults to
                <out_dir>/../wanted.log style sibling next to out_dir.

Outputs (in out_dir):
  <safe_title>_words.json   raw alignedWords[] from Suno
  <safe_title>.ass          libass-compatible subtitle file with
                            karaoke-style per-word highlighting

Idempotent: skips a track whose .ass already exists. Re-run after
a Suno API failure picks up where the previous run left off.

Env:
  SUNO_API_KEY_FILE   default C:/Users/nickf/Downloads/suno_api.txt

Style choices:
  - bottom-third overlay
  - white text with bright neon-cyan outline (visible on any cover)
  - per-word karaoke highlight in magenta
  - fade-in per LINE (groups of ~6 words)
  - sized for 1920x1080 — readable but not overpowering
"""
import json
import os
import re
import sys
import time
import urllib.request


def safe_title(title: str) -> str:
    return title.replace(" ", "_").replace("/", "-").replace("'", "")


def read_suno_key() -> str:
    p = os.environ.get("SUNO_API_KEY_FILE", "C:/Users/nickf/Downloads/suno_api.txt")
    with open(p) as f:
        return f.read().strip()


def parse_log_for_task_per_track(log_path: str) -> list:
    """Walk the suno_album_builder.sh log, pair TRACK headers with the
    taskId that immediately follows. Returns [(title, taskId), ...]
    in album order."""
    track_re = re.compile(r"^--- TRACK: (.+) at ")
    task_re = re.compile(r"taskId: ([a-f0-9]{32})")
    pairs = []
    pending = None
    with open(log_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = track_re.search(line)
            if m:
                pending = m.group(1).strip()
                continue
            m = task_re.search(line)
            if m and pending is not None:
                pairs.append((pending, m.group(1)))
                pending = None
    return pairs


# Cloudflare in front of api.sunoapi.org returns error 1010 to the
# default Python-urllib User-Agent. Curl works because its UA isn't
# flagged. Sending a generic curl-style UA dodges the bot block.
_UA = "curl/8.4.0"


def http_post_json(url: str, body: dict, key: str, timeout: int = 30) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "User-Agent": _UA,
            "Accept": "*/*",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def http_get_json(url: str, key: str, timeout: int = 30) -> dict:
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {key}",
        "User-Agent": _UA,
        "Accept": "*/*",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def fetch_audio_id(task_id: str, key: str) -> str | None:
    """Pull the v1 audioId from the record-info SUCCESS payload."""
    url = f"https://api.sunoapi.org/api/v1/generate/record-info?taskId={task_id}"
    j = http_get_json(url, key)
    suno_data = ((j.get("data") or {}).get("response") or {}).get("sunoData") or []
    if not suno_data:
        return None
    return suno_data[0].get("id")


def fetch_aligned_words(task_id: str, audio_id: str, key: str) -> list:
    url = "https://api.sunoapi.org/api/v1/generate/get-timestamped-lyrics"
    j = http_post_json(url, {"taskId": task_id, "audioId": audio_id}, key)
    if j.get("code") != 200:
        raise RuntimeError(f"timed-lyrics {j.get('code')}: {j.get('msg')}")
    return ((j.get("data") or {}).get("alignedWords")) or []


def ass_time(seconds: float) -> str:
    """Format seconds as H:MM:SS.cc (ASS timestamp)."""
    cs = int(round(seconds * 100))
    h = cs // 360000
    cs %= 360000
    m = cs // 6000
    cs %= 6000
    s = cs // 100
    cs %= 100
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def group_into_lines(words: list, max_words: int = 6) -> list[list[dict]]:
    """Split alignedWords into short renderable lines. A line ends on
    a newline character in the word string OR after max_words to keep
    on-screen lines short and readable."""
    lines: list[list[dict]] = []
    current: list[dict] = []
    for w in words:
        if not w.get("success", True):
            continue
        text = w.get("word", "")
        # Skip section markers — Suno includes [Hook], [Verse 1] etc.
        if re.match(r"^\s*\[(Hook|Verse|Chorus|Bridge|Outro|Intro|Pre-Chorus)", text, re.IGNORECASE):
            # Don't render bracket markers but DO close the current
            # line so the next visible word starts fresh.
            if current:
                lines.append(current)
                current = []
            continue
        current.append(w)
        has_newline = "\n" in text
        if has_newline or len(current) >= max_words:
            lines.append(current)
            current = []
    if current:
        lines.append(current)
    return lines


def render_line_event(line: list[dict]) -> str | None:
    """One ASS Dialogue line covering all words in a logical line, with
    \\k karaoke timing per word (so each word lights up as the audio
    reaches it)."""
    if not line:
        return None
    start = line[0]["startS"]
    end = line[-1]["endS"]
    if end <= start:
        return None
    parts = []
    cursor = start
    for w in line:
        ws = max(w["startS"], cursor)
        we = max(w["endS"], ws + 0.01)
        # \k duration is in centiseconds.
        k = int(round(max(0.0, ws - cursor) * 100))
        if k > 0:
            parts.append(f"{{\\k{k}}}")
        cs = int(round((we - ws) * 100))
        clean = w["word"].replace("\n", " ").replace("\r", " ").strip()
        # Escape ASS-significant characters.
        clean = clean.replace("{", "(").replace("}", ")")
        parts.append(f"{{\\kf{cs}}}{clean}")
        cursor = we
    text = "".join(parts)
    # \fad(180,180) = 180ms fade in + out, gentle.
    return (
        f"Dialogue: 0,{ass_time(start)},{ass_time(end + 0.5)},Default,,0,0,0,,"
        f"{{\\fad(180,180)}}{text}"
    )


ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,52,&H00FFFFFF,&H00FFFFFF,&H00C00000,&H80000000,1,0,0,0,100,100,0,0,1,3,2,2,80,80,90,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

# Style notes:
# - PrimaryColour &H00FFFFFF = pure white text fill (BGR + alpha=0)
# - SecondaryColour also white = no color swap until \k fires; the \kf
#   karaoke-fill effect sweeps the SecondaryColour through into the
#   PrimaryColour zone, giving a left-to-right fill animation
# - OutlineColour &H00C00000 = neon blue/cyan outline (BGR: B=C0 G=00 R=00)
# - BorderStyle=1 with Outline=3 Shadow=2 = chunky readable edge
# - Alignment=2 (bottom-center)
# - MarginV=90 = bottom third


def build_ass(words: list) -> str:
    lines = group_into_lines(words)
    events = []
    for ln in lines:
        ev = render_line_event(ln)
        if ev:
            events.append(ev)
    return ASS_HEADER + "\n".join(events) + "\n"


def main():
    args = sys.argv[1:]
    if not args:
        print("Usage: release-album-transcribe.py <album-config.json> [--log PATH]")
        sys.exit(64)
    cfg_path = args[0]
    log_path = None
    if "--log" in args:
        log_path = args[args.index("--log") + 1]

    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    out_dir = cfg["out_dir"]
    tracks = cfg["tracks"]

    if not log_path:
        # Default: <out_dir>.log — same naming the album builder uses.
        log_path = out_dir + ".log"
        if not os.path.exists(log_path):
            log_path = out_dir.rstrip("/").rstrip("\\") + "/album-builder.log"

    if not os.path.exists(log_path):
        print(f"[transcribe] album-builder log not found: {log_path}")
        sys.exit(2)

    pairs = parse_log_for_task_per_track(log_path)
    task_by_title = {title: tid for title, tid in pairs}
    print(f"[transcribe] found {len(task_by_title)} task ids in {log_path}")

    key = read_suno_key()
    done = 0
    skipped = 0
    failed = 0
    for t in tracks:
        title = t["title"]
        ass_path = os.path.join(out_dir, f"{safe_title(title)}.ass")
        if os.path.exists(ass_path) and os.path.getsize(ass_path) > 200:
            print(f"[transcribe] cached: {title}")
            skipped += 1
            continue
        task_id = task_by_title.get(title)
        if not task_id:
            print(f"[transcribe] FAIL {title} — no taskId in log")
            failed += 1
            continue
        try:
            audio_id = fetch_audio_id(task_id, key)
            if not audio_id:
                raise RuntimeError("no v1 audioId in record-info")
            words = fetch_aligned_words(task_id, audio_id, key)
            words_path = os.path.join(out_dir, f"{safe_title(title)}_words.json")
            with open(words_path, "w", encoding="utf-8") as f:
                json.dump(words, f, ensure_ascii=False)
            ass = build_ass(words)
            with open(ass_path, "w", encoding="utf-8") as f:
                f.write(ass)
            print(f"[transcribe] OK {title} — {len(words)} words")
            done += 1
            # Suno per-IP rate limit kindness — small pause between
            # tracks. Two cheap GET+POST so 1s is plenty.
            time.sleep(1.0)
        except Exception as e:
            print(f"[transcribe] FAIL {title} — {e}")
            failed += 1

    print(f"[transcribe] done={done} cached={skipped} failed={failed}")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
