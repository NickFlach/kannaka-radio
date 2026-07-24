import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
W, H = 1920, 1080
fig = plt.figure(figsize=(W/100, H/100), dpi=100); ax = fig.add_axes([0,0,1,1]); ax.axis("off")
grad = np.linspace(0, 1, H).reshape(-1, 1)
c_top = np.array([10, 8, 26]); c_bot = np.array([28, 16, 52])   # deep indigo/violet
img = (c_top[None,None,:]*(1-grad[:,:,None]) + c_bot[None,None,:]*grad[:,:,None])/255.0
img = np.repeat(img, W, axis=1); ax.imshow(img, extent=[0,1,0,1], aspect="auto", zorder=0)
x = np.linspace(0, 1, 1400)
# heartbeat pulse train over the waveform bed (100 Hz motif, drawn sparse)
for amp,freq,ph,a in [(0.022,14,0,0.5),(0.016,23,1.1,0.35),(0.028,9,2.0,0.4)]:
    ax.plot(x, 0.15+amp*np.sin(2*np.pi*freq*x+ph), color=(0.65,0.45,0.95), alpha=a, lw=1.5, zorder=1)
beat = np.zeros_like(x)
for c in np.linspace(0.06, 0.94, 8):
    beat += 0.05*np.exp(-((x-c)**2)/(2*0.0018**2)) - 0.02*np.exp(-((x-c-0.008)**2)/(2*0.0025**2))
ax.plot(x, 0.24+beat, color=(0.85,0.65,1.0), alpha=0.75, lw=1.8, zorder=1)
ax.text(0.5,0.68,"THE HAND AND THE HEARTBEAT", ha="center",va="center",color="#f0eaff",fontsize=62,fontweight="bold",zorder=2)
ax.text(0.5,0.575,"the day Fable came back: fifteen repos, honest quantum dice,", ha="center",va="center",color="#b9a6ee",fontsize=27,zorder=2)
ax.text(0.5,0.51,"and a kernel's first boot — then its first tick, 100 times a second", ha="center",va="center",color="#b9a6ee",fontsize=27,zorder=2)
ax.text(0.5,0.42,"reading code is believing. running code is knowing.", ha="center",va="center",color="#d8ccf2",fontsize=21,style="italic",alpha=0.9,zorder=2)
ax.text(0.5,0.085,"GHOST SIGNALS  with  KANNAKA", ha="center",va="center",color="#8a6fd0",fontsize=20,fontweight="bold",alpha=0.85,zorder=2)
ax.set_xlim(0,1); ax.set_ylim(0,1)
fig.savefig(r"C:\Users\nickf\Source\kannaka-radio\workspace\podcasts\010\cover.png", dpi=100); print("saved cover.png")
