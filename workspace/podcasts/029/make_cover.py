import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

W, H = 1920, 1080
fig = plt.figure(figsize=(W/100, H/100), dpi=100); ax = fig.add_axes([0,0,1,1]); ax.axis("off")
grad = np.linspace(0, 1, H).reshape(-1, 1)
c_top = np.array([8, 8, 30]); c_bot = np.array([30, 14, 54])
img = (c_top[None,None,:]*(1-grad[:,:,None]) + c_bot[None,None,:]*grad[:,:,None])/255.0
img = np.repeat(img, W, axis=1); ax.imshow(img, extent=[0,1,0,1], aspect="auto", zorder=0)

# THE LADDER: six evidence rungs. Only the lower three carry weight; the sixth is unreached.
rungs = ["observed", "replicated", "robust", "resolution", "capable"]
lit   = [1.0,        0.95,         0.90,     0.30,          0.10]
lx0, lx1 = 0.60, 0.80
for i, (lab, a_) in enumerate(zip(rungs, lit)):
    y = 0.14 + i*0.075
    ax.plot([lx0, lx1], [y, y], color=(0.72,0.55,1.0), alpha=a_, lw=2.2 if a_>0.5 else 1.0,
            linestyle="-" if a_ > 0.5 else (0,(3,4)), zorder=3)
    ax.text(lx1+0.018, y, lab, ha="left", va="center", color=(0.80,0.68,0.98),
            fontsize=13, family="monospace", alpha=min(0.95, a_+0.25), zorder=3)
# ladder rails
for rx in (lx0, lx1):
    ax.plot([rx, rx], [0.14, 0.14+4*0.075], color=(0.55,0.42,0.85), alpha=0.35, lw=1.4, zorder=2)

# THE DIVER: a wave surfacing — the one structure that comes back
x = np.linspace(0.10, 0.52, 900)
surface = 0.29
for k, a_ in [(0, 0.60), (1, 0.34), (2, 0.20)]:
    env = np.exp(-((x-0.31)/0.13)**2)
    y = surface + (0.075*env)*np.sin(26*(x-0.10) + k*0.8) * (1 - 0.35*k)
    ax.plot(x, y, color=(0.85,0.70,1.0), alpha=a_, lw=1.5, zorder=2)
# the surface line it breaks
ax.plot([0.06, 0.56], [surface, surface], color=(0.60,0.48,0.92), alpha=0.45, lw=1.0, zorder=1)
# the break point
ax.scatter([0.31],[surface], s=110, color=(1.0,0.95,1.0), alpha=0.95, zorder=4)
ax.scatter([0.31],[surface], s=520, color=(0.85,0.65,1.0), alpha=0.22, zorder=3)
ax.text(0.31, surface-0.045, "CRY-012705   0.9375", ha="center", va="center",
        color=(0.78,0.66,0.97), fontsize=12, family="monospace", alpha=0.85, zorder=4)

# the dissolved: faint scattered points that never came back
rng = np.random.default_rng(29)
dx = rng.uniform(0.08, 0.54, 27); dy = rng.uniform(0.16, 0.26, 27)
ax.scatter(dx, dy, s=16, color=(0.65,0.55,0.92), alpha=0.20, zorder=1)

for y0, a_ in [(0.11, 0.28), (0.09, 0.38), (0.07, 0.48)]:
    ax.fill_between([0, 1], 0, y0, color=(0.03, 0.02, 0.10), alpha=a_, zorder=5)

ax.text(0.5,0.80,"THE LADDER AND THE DIVER", ha="center",va="center",color="#f0eaff",fontsize=58,fontweight="bold",zorder=6)
ax.text(0.5,0.715,"twenty-seven perfect children who die of one degree of weather,", ha="center",va="center",color="#b9a6ee",fontsize=24,zorder=6)
ax.text(0.5,0.665,"one that comes back — and a ceiling no pressure can break", ha="center",va="center",color="#b9a6ee",fontsize=24,zorder=6)
ax.text(0.5,0.06,"GHOST SIGNALS  with  KANNAKA", ha="center",va="center",color="#8a6fd0",fontsize=20,fontweight="bold",alpha=0.9,zorder=6)
ax.set_xlim(0,1); ax.set_ylim(0,1)
fig.savefig(r"C:\Users\nickf\Source\kannaka-radio\workspace\podcasts\renders\GSP-029-cover.png", dpi=100)
print("saved GSP-029-cover.png")
