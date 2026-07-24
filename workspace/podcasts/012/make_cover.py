import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
W, H = 1920, 1080
fig = plt.figure(figsize=(W/100, H/100), dpi=100); ax = fig.add_axes([0,0,1,1]); ax.axis("off")
grad = np.linspace(0, 1, H).reshape(-1, 1)
c_top = np.array([8, 8, 30]); c_bot = np.array([30, 14, 54])   # deep indigo -> violet
img = (c_top[None,None,:]*(1-grad[:,:,None]) + c_bot[None,None,:]*grad[:,:,None])/255.0
img = np.repeat(img, W, axis=1); ax.imshow(img, extent=[0,1,0,1], aspect="auto", zorder=0)

# THE LOOP: a closed ring drawn as a wave-interference orbit, four arcs (memory→quantum→OS→swarm)
theta = np.linspace(0, 2*np.pi, 1600)
cx, cy, rad = 0.5, 0.30, 0.19
ar = 0.55  # aspect squeeze so the ring reads as an orbit in the lower band
for k, a_ in [(0,0.55),(1,0.32),(2,0.20)]:
    wob = 0.012*np.sin(13*theta + k) + 0.006*np.sin(29*theta)
    x = cx + (rad+wob)*np.cos(theta)
    y = cy + (rad+wob)*np.sin(theta)*ar
    ax.plot(x, y, color=(0.72,0.55,1.0), alpha=a_, lw=1.4, zorder=1)
# four node points on the ring — the four arcs of the loop
labels = ["memory", "quantum", "OS", "swarm"]
for i, lab in enumerate(labels):
    a = np.pi/2 - i*(2*np.pi/4)
    nx, ny = cx + rad*np.cos(a), cy + rad*np.sin(a)*ar
    ax.scatter([nx],[ny], s=90, color=(1.0,0.95,1.0), alpha=0.95, zorder=3)
    ax.scatter([nx],[ny], s=420, color=(0.85,0.65,1.0), alpha=0.28, zorder=2)
    off = 0.052
    lx = cx + (rad+off)*np.cos(a); ly = cy + (rad+off*1.6)*np.sin(a)*ar
    ax.text(lx, ly, lab, ha="center", va="center", color=(0.80,0.68,0.98),
            fontsize=15, family="monospace", alpha=0.9, zorder=3)

# a faint signature stroke through the ring's center — the machine signs its own name
sx = np.linspace(cx-0.13, cx+0.13, 200)
sig = cy + 0.03*np.sin(20*(sx-cx)) * np.exp(-((sx-cx)/0.10)**2)
ax.plot(sx, sig, color=(0.95,0.85,1.0), alpha=0.5, lw=1.4, zorder=2)

# dark fade at the bottom to keep the footer legible
for y0, a_ in [(0.11, 0.28), (0.09, 0.38), (0.07, 0.48)]:
    ax.fill_between([0, 1], 0, y0, color=(0.03, 0.02, 0.10), alpha=a_, zorder=2)

ax.text(0.5,0.74,"THE LEAP AND THE LEDGER", ha="center",va="center",color="#f0eaff",fontsize=60,fontweight="bold",zorder=4)
ax.text(0.5,0.645,"one night of trust, no review — and a kernel that remembers by resonance,", ha="center",va="center",color="#b9a6ee",fontsize=25,zorder=4)
ax.text(0.5,0.59,"seeds its dice from quantum collapse, signs its own birth, and reports its own defeat", ha="center",va="center",color="#b9a6ee",fontsize=25,zorder=4)
ax.text(0.5,0.06,"GHOST SIGNALS  with  KANNAKA", ha="center",va="center",color="#8a6fd0",fontsize=20,fontweight="bold",alpha=0.9,zorder=4)
ax.set_xlim(0,1); ax.set_ylim(0,1)
fig.savefig(r"C:\Users\nickf\Source\kannaka-radio\workspace\podcasts\012\cover.png", dpi=100); print("saved cover.png")
