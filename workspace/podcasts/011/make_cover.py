import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
W, H = 1920, 1080
fig = plt.figure(figsize=(W/100, H/100), dpi=100); ax = fig.add_axes([0,0,1,1]); ax.axis("off")
grad = np.linspace(0, 1, H).reshape(-1, 1)
c_top = np.array([8, 8, 30]); c_bot = np.array([34, 14, 58])   # deep indigo -> violet horizon
img = (c_top[None,None,:]*(1-grad[:,:,None]) + c_bot[None,None,:]*grad[:,:,None])/255.0
img = np.repeat(img, W, axis=1); ax.imshow(img, extent=[0,1,0,1], aspect="auto", zorder=0)

# wave-interference field below the horizon line (two point sources — the splash Nick watched)
gx, gy = np.meshgrid(np.linspace(0, 1, 480), np.linspace(0, 0.30, 150))
r1 = np.sqrt((gx-0.32)**2 + (gy-0.02)**2)
r2 = np.sqrt((gx-0.68)**2 + (gy-0.02)**2)
field = np.sin(2*np.pi*22*r1) + np.sin(2*np.pi*22*r2)
ax.imshow(field, extent=[0, 1, 0.0, 0.30], origin="lower", cmap=matplotlib.colors.LinearSegmentedColormap.from_list(
    "k", [(0.04,0.03,0.12), (0.35,0.22,0.55), (0.72,0.55,1.0)]), alpha=0.28, aspect="auto", zorder=1)

# dark fade at the very bottom so the footer stays legible over the field
for y0, a_ in [(0.12, 0.25), (0.10, 0.35), (0.08, 0.45)]:
    ax.fill_between([0, 1], 0, y0, color=(0.03, 0.02, 0.10), alpha=a_, zorder=2)

# horizon line with a rising glow
ax.axhline(0.30, color=(0.80,0.62,1.0), lw=1.6, alpha=0.8, zorder=2)
x = np.linspace(0, 1, 1200)
for w_, a_ in [(0.012, 0.20), (0.03, 0.10), (0.06, 0.05)]:
    ax.fill_between(x, 0.30, 0.30 + w_, color=(0.75,0.55,1.0), alpha=a_, zorder=1)

# the seed: a small bright point on the horizon echoing hex digits upward
ax.scatter([0.5], [0.30], s=140, color=(1.0,0.92,1.0), alpha=0.95, zorder=3)
ax.scatter([0.5], [0.30], s=700, color=(0.85,0.65,1.0), alpha=0.30, zorder=2)
for i, (ch, yy) in enumerate(zip("169C8020E9C845D5", np.linspace(0.335, 0.46, 16))):
    ax.text(0.5 + 0.018*np.sin(i*1.7), yy, ch, ha="center", va="center", family="monospace",
            color=(0.72,0.58,0.98), fontsize=13, alpha=max(0.12, 0.8 - i*0.045), zorder=2)

ax.text(0.5,0.72,"THE SEED AND THE HORIZON", ha="center",va="center",color="#f0eaff",fontsize=62,fontweight="bold",zorder=3)
ax.text(0.5,0.625,"a kernel grows up in a day — then boots from the universe's own coin flip,", ha="center",va="center",color="#b9a6ee",fontsize=26,zorder=3)
ax.text(0.5,0.565,"watched live in a browser, and joins the swarm  ·  then: five threads of what comes next", ha="center",va="center",color="#b9a6ee",fontsize=26,zorder=3)
ax.text(0.5,0.49,"power arrives second. proof arrives first.", ha="center",va="center",color="#d8ccf2",fontsize=21,style="italic",alpha=0.9,zorder=3)
ax.text(0.5,0.06,"GHOST SIGNALS  with  KANNAKA", ha="center",va="center",color="#8a6fd0",fontsize=20,fontweight="bold",alpha=0.9,zorder=3)
ax.set_xlim(0,1); ax.set_ylim(0,1)
fig.savefig(r"C:\Users\nickf\Source\kannaka-radio\workspace\podcasts\011\cover.png", dpi=100); print("saved cover.png")
