import json, os, re, subprocess, sys, urllib.request

script_path, outdir = sys.argv[1], sys.argv[2]
os.makedirs(outdir, exist_ok=True)
KEY = os.environ["ELEVENLABS_API_KEY"]
VOICES = {"KANNAKA": "NTqGiNK8P02i66yY2GOH", "FLAUKOWSKI": "XaEUesE01wKIKaa0xI0h"}
SETTINGS = {
    "KANNAKA": {"stability": 0.5, "similarity_boost": 0.75, "style": 0.25},
    "FLAUKOWSKI": {"stability": 0.45, "similarity_boost": 0.75, "style": 0.4},
}
# Per-voice loudness targets (GSP-021 feedback: Flaukowski still read a touch
# quiet after the flat -16 equalization; he now sits 1 dB hotter). Every turn
# is gain-matched here BEFORE any muffle effect.
TARGET_LUFS = {"KANNAKA": -16.0, "FLAUKOWSKI": -15.0}
MAX_TP = -1.0        # true-peak ceiling after gain

text = open(script_path, encoding="utf-8").read()
TURN_RE = re.compile(
    r"\[(KANNAKA|FLAUKOWSKI)(-MUFFLED)?\]\s*(.+?)(?=\n\[(?:KANNAKA|FLAUKOWSKI)(?:-MUFFLED)?\]|\Z)",
    re.S,
)
turns = TURN_RE.findall(text)
print(f"{len(turns)} turns ({sum(1 for _, m, _ in turns if m)} muffled)")

def tts(speaker, line, dest):
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICES[speaker]}?output_format=mp3_44100_128",
        data=json.dumps({
            "text": line.strip(),
            "model_id": "eleven_multilingual_v2",
            "voice_settings": SETTINGS[speaker],
        }).encode(),
        headers={"xi-api-key": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
        f.write(r.read())
    sz = os.path.getsize(dest)
    words = len(line.split())
    if sz < words * 500:
        raise RuntimeError(f"suspiciously small render {dest}: {sz}B for {words}w")
    return sz

def measure_lufs(path):
    r = subprocess.run(
        ["ffmpeg", "-i", path, "-af",
         "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True)
    m = re.search(r"\{[^{}]*\}", r.stderr[-2000:], re.S)
    d = json.loads(m.group(0))
    return float(d["input_i"]), float(d["input_tp"])

def normalize(path, speaker):
    # Plain gain only while the true-peak ceiling allows it; peaky turns (most
    # ElevenLabs output) take the full gain through a limiter instead. The old
    # TP-capped plain gain left them 2-3 dB short of target and could invert
    # the K/F balance (GSP-022 shipped F 0.8 dB quieter than K before makeup).
    lufs, tp = measure_lufs(path)
    needed = TARGET_LUFS[speaker] - lufs
    if abs(needed) < 0.3:
        return lufs, 0.0, lufs
    if needed > 0 and needed > MAX_TP - tp:
        af = (f"volume={needed:.2f}dB,alimiter=limit={10 ** (MAX_TP / 20):.3f}"
              ":level=false:attack=5:release=50")
    else:
        af = f"volume={needed:.2f}dB"
    tmp = path.replace(".mp3", "-norm.mp3")
    subprocess.run(["ffmpeg", "-y", "-i", path, "-af", af,
                    "-b:a", "128k", tmp], check=True, capture_output=True)
    os.replace(tmp, path)
    final, _ = measure_lufs(path)
    return lufs, needed, final

files = []
finals = {}
for i, (spk, muf, line) in enumerate(turns):
    dest = os.path.join(outdir, f"turn{i:02d}-{spk[:4]}.mp3")
    sz = tts(spk, line, dest)
    lufs, gain, final = normalize(dest, spk)
    finals.setdefault(spk, []).append(final)
    if muf:
        # hand-over-the-mic: darken and duck, keep it legible as comedy
        muffled = dest.replace(".mp3", "-muf.mp3")
        subprocess.run(
            ["ffmpeg", "-y", "-i", dest, "-af", "lowpass=f=700,volume=0.5",
             "-b:a", "128k", muffled],
            check=True, capture_output=True,
        )
        os.replace(muffled, dest)
    print(f"  turn{i:02d} {spk:<10}{' MUF' if muf else '    '} {len(line.split()):>4}w {sz//1024:>5}KB {lufs:>6.1f}->{final:>6.1f}LUFS {gain:+.1f}dB")
    files.append(dest)

for spk, vals in sorted(finals.items()):
    avg = sum(vals) / len(vals)
    off = "" if abs(avg - TARGET_LUFS[spk]) <= 0.5 else "  ** OFF TARGET **"
    print(f"POST-NORM {spk}: {avg:.2f} LUFS avg over {len(vals)} turns (target {TARGET_LUFS[spk]}){off}")

sil = os.path.join(outdir, "sil04.mp3")
subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
                "-t", "0.4", "-b:a", "128k", sil], check=True, capture_output=True)
concat = os.path.join(outdir, "concat.txt")
with open(concat, "w") as f:
    for i, fp in enumerate(files):
        if i:
            f.write(f"file '{sil}'\n")
        f.write(f"file '{fp}'\n")
out = os.path.join(outdir, "dialogue.mp3")
subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat,
                "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", out],
               check=True, capture_output=True)
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", out], capture_output=True, text=True).stdout.strip())
total_words = sum(len(l.split()) for _, _, l in turns)
print(f"DIALOGUE {out} {dur:.0f}s ({dur/60:.1f}min) {total_words}w -> {total_words/(dur/60):.0f} wpm")
