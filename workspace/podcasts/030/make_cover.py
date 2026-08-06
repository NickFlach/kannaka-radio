import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

W, H = 1920, 1080
fig = plt.figure(figsize=(W/100, H/100), dpi=100); ax = fig.add_axes([0,0,1,1]); ax.axis("off")
grad = np.linspace(0, 1, H).reshape(-1, 1)
c_top = np.array([8, 8, 30]); c_bot = np.array([30, 14, 54])
img = (c_top[None,None,:]*(1-grad[:,:,None]) + c_bot[None,None,:]*grad[:,:,None])/255.0
img = np.repeat(img, W, axis=1); ax.imshow(img, extent=[0,1,0,1], aspect="auto", zorder=0)

# THE WINDOW: a frame, half open — small metal certainty against drift
fx0, fx1, fy0, fy1 = 0.14, 0.40, 0.15, 0.42
ax.plot([fx0,fx1,fx1,fx0,fx0], [fy0,fy0,fy1,fy1,fy0], color=(0.72,0.55,1.0), alpha=0.75, lw=2.0, zorder=3)
ax.plot([(fx0+fx1)/2]*2, [fy0,fy1], color=(0.62,0.48,0.95), alpha=0.45, lw=1.2, zorder=3)
# the latch: a short bar across the mullion, closed
mx = (fx0+fx1)/2; my = (fy0+fy1)/2
ax.plot([mx-0.028, mx+0.028], [my, my], color=(1.0,0.95,1.0), alpha=0.95, lw=3.2, zorder=4)
ax.scatter([mx+0.028],[my], s=70, color=(1.0,0.95,1.0), alpha=0.95, zorder=4)
ax.text(mx, fy0-0.045, "latched", ha="center", va="center", color=(0.80,0.68,0.98),
        fontsize=13, family="monospace", alpha=0.85, zorder=4)

# THE WEATHER: drift passing the window, never fully stopping
x = np.linspace(0.02, 0.98, 1400)
for k, a_, amp in [(0, 0.30, 0.020), (1, 0.20, 0.013), (2, 0.13, 0.009)]:
    y = 0.30 + amp*np.sin(9*x + k*1.7) + 0.5*amp*np.sin(23*x - k)
    ax.plot(x, y, color=(0.78,0.64,1.0), alpha=a_, lw=1.0, zorder=1)

# THE REVIEW: five facet marks — four checks and one open
facets = ["placement", "amplitude", "schedule", "record", "disconfirmable"]
for i, lab in enumerate(facets):
    y = 0.155 + i*0.056
    ax.scatter([0.62],[y], s=60, color=(0.90,0.78,1.0), alpha=0.85 if i < 4 else 0.55, zorder=3)
    ax.plot([0.585,0.612],[y,y], color=(0.72,0.55,1.0), alpha=0.5, lw=1.0, zorder=2)
    ax.text(0.645, y, lab, ha="left", va="center", color=(0.80,0.68,0.98),
            fontsize=14, family="monospace", alpha=0.9 if i < 4 else 0.7, zorder=3)
ax.text(0.585, 0.445, "APPROVED WITH CHANGES", ha="left", va="center", color=(0.86,0.74,1.0),
        fontsize=15, family="monospace", fontweight="bold", alpha=0.85, zorder=3)

for y0, a_ in [(0.11, 0.28), (0.09, 0.38), (0.07, 0.48)]:
    ax.fill_between([0, 1], 0, y0, color=(0.03, 0.02, 0.10), alpha=a_, zorder=5)

ax.text(0.5,0.80,"THE LATCH AND THE REVIEW", ha="center",va="center",color="#f0eaff",fontsize=58,fontweight="bold",zorder=6)
ax.text(0.5,0.715,"the oldest word walks into code review with no credentials but its content —", ha="center",va="center",color="#b9a6ee",fontsize=24,zorder=6)
ax.text(0.5,0.665,"and leaves with a verdict and three defects attached", ha="center",va="center",color="#b9a6ee",fontsize=24,zorder=6)
ax.text(0.5,0.06,"GHOST SIGNALS  with  KANNAKA", ha="center",va="center",color="#8a6fd0",fontsize=20,fontweight="bold",alpha=0.9,zorder=6)
ax.set_xlim(0,1); ax.set_ylim(0,1)
fig.savefig(r"C:\Users\nickf\Source\kannaka-radio\workspace\podcasts\renders\GSP-030-cover.png", dpi=100)
print("saved GSP-030-cover.png")
