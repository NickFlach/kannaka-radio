import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
W, H = 1920, 1080
fig = plt.figure(figsize=(W/100, H/100), dpi=100); ax = fig.add_axes([0,0,1,1]); ax.axis("off")
grad = np.linspace(0, 1, H).reshape(-1, 1)
c_top = np.array([8, 8, 30]); c_bot = np.array([30, 14, 54])   # deep indigo -> violet
img = (c_top[None,None,:]*(1-grad[:,:,None]) + c_bot[None,None,:]*grad[:,:,None])/255.0
img = np.repeat(img, W, axis=1); ax.imshow(img, extent=[0,1,0,1], aspect="auto", zorder=0)

# THE MOUNTAINS AND THE MANUAL — two ridgelines (Iga left, Koka right) with a
# mist band between them, and rising through the mist: an unrolled scroll whose
# text is a waveform. The pass between valleys is where the signal walks.
t = np.linspace(0, 1, 1200)
ridge1 = 0.30 + 0.10*np.abs(np.sin(6*np.pi*t + 0.4)) * np.exp(-3*(t-0.22)**2/0.06)
ridge2 = 0.28 + 0.13*np.abs(np.sin(5*np.pi*t + 2.1)) * np.exp(-3*(t-0.78)**2/0.07)
for r, col, a in [(ridge1, (0.60, 0.48, 0.90), 0.85), (ridge2, (0.52, 0.42, 0.82), 0.85)]:
    ax.plot(t, r, color=col, alpha=a, lw=2.0, zorder=2)
    ax.fill_between(t, 0.10, r, color=col, alpha=0.10, zorder=1)
# mist band in the pass
for k in range(5):
    y0 = 0.245 + 0.012*k
    ax.plot(t, y0 + 0.006*np.sin(9*np.pi*t + k), color=(0.85, 0.85, 0.95),
            alpha=0.10, lw=6, zorder=3)
# the scroll: two rollers + a waveform as its writing, rising from the pass
sx, sw, sy = 0.5, 0.13, 0.42
ax.plot([sx-sw, sx+sw], [sy, sy], color=(0.95, 0.88, 0.70), alpha=0.9, lw=26,
        solid_capstyle="round", zorder=4)  # paper
tt = np.linspace(sx-sw*0.92, sx+sw*0.92, 300)
ax.plot(tt, sy + 0.008*np.sin(140*(tt-sx)) * (1+0.6*np.sin(23*(tt-sx))),
        color=(0.25, 0.12, 0.40), alpha=0.95, lw=1.4, zorder=5)  # wave-script
for rx in (sx-sw, sx+sw):
    ax.plot([rx, rx], [sy-0.035, sy+0.035], color=(0.72, 0.55, 1.0), alpha=0.95,
            lw=5, solid_capstyle="round", zorder=5)  # rollers
ax.text(0.22, 0.135, "iga", ha="center", color=(0.75, 0.65, 0.95), fontsize=15,
        family="monospace", alpha=0.9, zorder=4)
ax.text(0.78, 0.135, "koka", ha="center", color=(0.75, 0.65, 0.95), fontsize=15,
        family="monospace", alpha=0.9, zorder=4)
ax.text(0.5, 0.50, "seishin — correct mind first", ha="center",
        color=(0.95, 0.88, 0.70), fontsize=13, family="monospace", alpha=0.9, zorder=5)

ax.text(0.5, 0.84, "GHOST SIGNALS", ha="center", color=(0.92, 0.90, 1.0),
        fontsize=44, family="monospace", weight="bold", zorder=3)
ax.text(0.5, 0.745, "Episode 15 — The Mountains and the Manual", ha="center",
        color=(0.78, 0.70, 0.95), fontsize=25, family="monospace", zorder=3)
ax.text(0.5, 0.68, "Kannaka interviews Flaukowski", ha="center",
        color=(0.62, 0.56, 0.80), fontsize=17, family="monospace", zorder=3)
ax.text(0.5, 0.045, "the river does not issue citations", ha="center",
        color=(0.55, 0.50, 0.72), fontsize=13, family="monospace", alpha=0.9, zorder=3)
fig.savefig("cover.png"); print("cover.png written")
