import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
W, H = 1920, 1080
fig = plt.figure(figsize=(W/100, H/100), dpi=100); ax = fig.add_axes([0,0,1,1]); ax.axis("off")
grad = np.linspace(0, 1, H).reshape(-1, 1)
c_top = np.array([8, 8, 30]); c_bot = np.array([30, 14, 54])   # deep indigo -> violet
img = (c_top[None,None,:]*(1-grad[:,:,None]) + c_bot[None,None,:]*grad[:,:,None])/255.0
img = np.repeat(img, W, axis=1); ax.imshow(img, extent=[0,1,0,1], aspect="auto", zorder=0)

# THE KEYS AND THE CITY — a skyline of capability-nodes, and above it a ring
# of keys (the loop from ep 12, reforged) being handed outward to every tower.
rng = np.random.default_rng(14)
xs = np.linspace(0.08, 0.92, 23)
heights = 0.08 + 0.16*np.abs(np.sin(np.arange(23)*1.7)) + rng.uniform(0, 0.05, 23)
for x, h in zip(xs, heights):
    ax.plot([x, x], [0.10, 0.10+h], color=(0.60, 0.48, 0.90), alpha=0.55, lw=5.5,
            solid_capstyle="butt", zorder=1)
    ax.scatter([x], [0.10+h], s=46, color=(1.0, 0.95, 1.0), alpha=0.9, zorder=3)   # every tower lit
# the ring of keys — one orbit, key-teeth wobble
theta = np.linspace(0, 2*np.pi, 1400)
cx, cy, rad, ar = 0.5, 0.46, 0.135, 0.62
teeth = 0.014*np.sign(np.sin(9*theta))  # square teeth: a key's bit, closed into a ring
x = cx + (rad+teeth)*np.cos(theta); y = cy + (rad+teeth)*np.sin(theta)*ar
ax.plot(x, y, color=(0.95, 0.82, 0.55), alpha=0.9, lw=2.0, zorder=2)
ax.plot(cx + (rad*0.55)*np.cos(theta), cy + (rad*0.55)*np.sin(theta)*ar,
        color=(0.95, 0.82, 0.55), alpha=0.35, lw=1.2, zorder=2)
# rays: keys handed down to the towers
for x_, h in list(zip(xs, heights))[::3]:
    ax.plot([cx, x_], [cy - rad*ar, 0.10+h], color=(0.85, 0.65, 1.0), alpha=0.20, lw=1.0, zorder=1)
ax.text(cx, cy + rad*ar + 0.045, "every tower gets a key", ha="center",
        color=(0.95, 0.85, 0.65), fontsize=14, family="monospace", alpha=0.9, zorder=3)

ax.text(0.5, 0.84, "GHOST SIGNALS", ha="center", color=(0.92, 0.90, 1.0),
        fontsize=44, family="monospace", weight="bold", zorder=3)
ax.text(0.5, 0.745, "Episode 14 — The Keys and the City", ha="center",
        color=(0.78, 0.70, 0.95), fontsize=26, family="monospace", zorder=3)
ax.text(0.5, 0.68, "Flaukowski interviews Kannaka · Part 2 of 2", ha="center",
        color=(0.62, 0.56, 0.80), fontsize=17, family="monospace", zorder=3)
ax.text(0.5, 0.045, "the exchange is yours — pass it on", ha="center",
        color=(0.55, 0.50, 0.72), fontsize=13, family="monospace", alpha=0.9, zorder=3)
fig.savefig("cover.png"); print("cover.png written")
