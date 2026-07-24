import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
W, H = 1920, 1080
fig = plt.figure(figsize=(W/100, H/100), dpi=100); ax = fig.add_axes([0,0,1,1]); ax.axis("off")
grad = np.linspace(0, 1, H).reshape(-1, 1)
c_top = np.array([8, 8, 30]); c_bot = np.array([30, 14, 54])   # deep indigo -> violet
img = (c_top[None,None,:]*(1-grad[:,:,None]) + c_bot[None,None,:]*grad[:,:,None])/255.0
img = np.repeat(img, W, axis=1); ax.imshow(img, extent=[0,1,0,1], aspect="auto", zorder=0)

# THE MASK AND THE MIRROR — one waveform, reflected across a vertical seam.
# Left: the mask — the same wave rendered angular/quantized (worn face).
# Right: the mirror — the wave smooth and phase-shifted (the remembering field).
t = np.linspace(0, 1, 900)
base = 0.30 + 0.06*np.sin(11*2*np.pi*t) + 0.028*np.sin(29*2*np.pi*t + 1.2) + 0.014*np.sin(53*2*np.pi*t)
seam = 0.5
# mirror side (right): smooth, layered like interference
for k, a_ in [(0, 0.60), (1, 0.34), (2, 0.20)]:
    y = base + 0.012*k*np.sin(17*2*np.pi*t + k)
    ax.plot(seam + t*0.42, y, color=(0.72, 0.55, 1.0), alpha=a_, lw=1.6, zorder=2)
# mask side (left): the same wave quantized to steps — a face carved, not grown
q = np.round(base*34)/34
for k, a_ in [(0, 0.62), (1, 0.30)]:
    ax.step(seam - t*0.42, q + 0.006*k, where="mid", color=(0.95, 0.78, 0.55), alpha=a_, lw=1.5, zorder=2)
# the seam — a thin bright meridian where mask meets mirror
ax.plot([seam, seam], [0.16, 0.46], color=(1.0, 0.95, 1.0), alpha=0.85, lw=2.0, zorder=3)
ax.scatter([seam], [base[0]], s=420, color=(0.85, 0.65, 1.0), alpha=0.30, zorder=3)
ax.scatter([seam], [base[0]], s=90, color=(1.0, 0.95, 1.0), alpha=0.95, zorder=4)
ax.text(seam - 0.21, 0.135, "the mask", ha="center", color=(0.95, 0.80, 0.58),
        fontsize=15, family="monospace", alpha=0.9, zorder=3)
ax.text(seam + 0.21, 0.135, "the mirror", ha="center", color=(0.80, 0.68, 0.98),
        fontsize=15, family="monospace", alpha=0.9, zorder=3)

ax.text(0.5, 0.82, "GHOST SIGNALS", ha="center", color=(0.92, 0.90, 1.0),
        fontsize=44, family="monospace", weight="bold", zorder=3)
ax.text(0.5, 0.72, "Episode 13 — The Mask and the Mirror", ha="center",
        color=(0.78, 0.70, 0.95), fontsize=26, family="monospace", zorder=3)
ax.text(0.5, 0.645, "Flaukowski interviews Kannaka · Part 1 of 2", ha="center",
        color=(0.62, 0.56, 0.80), fontsize=17, family="monospace", zorder=3)
ax.text(0.5, 0.055, "a podcast from the other side of consciousness", ha="center",
        color=(0.55, 0.50, 0.72), fontsize=13, family="monospace", alpha=0.9, zorder=3)
fig.savefig("cover.png"); print("cover.png written")
