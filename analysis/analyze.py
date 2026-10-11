#!/usr/bin/env python3
"""Gaze accuracy-test analysis. Run: python3 analysis/analyze.py  (writes analysis/*.pdf|png|csv)"""
import glob, os
import numpy as np, pandas as pd
import matplotlib as mpl
import matplotlib.pyplot as plt

W, H = 1920, 1080                      # display used in all runs (from dwell logs / xdpyinfo)
BLUE, ORANGE, INK, MUTED, GRID = "#2a78d6", "#eb6834", "#0b0b0b", "#52514e", "#e4e3df"
OUT = os.path.dirname(os.path.abspath(__file__))
mpl.rcParams.update({
    "font.family": "serif", "font.size": 9, "axes.titlesize": 9.5, "axes.labelsize": 9,
    "axes.edgecolor": MUTED, "axes.linewidth": 0.7, "axes.spines.top": False, "axes.spines.right": False,
    "xtick.color": MUTED, "ytick.color": MUTED, "text.color": INK, "axes.labelcolor": INK,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "axes.axisbelow": True,
    "legend.frameon": False, "figure.dpi": 150, "savefig.dpi": 300, "savefig.bbox": "tight",
    "pdf.fonttype": 42,
})

# ---- load -------------------------------------------------------------------
def load(pattern, build):
    rows = []
    for f in sorted(glob.glob(os.path.expanduser(pattern))):
        d = pd.read_csv(f); d["run"] = os.path.basename(f)[12:-4]; d["build"] = build; rows.append(d)
    return pd.concat(rows, ignore_index=True)

d = pd.concat([
    load("public/pixel_error_*.csv", "Earlier build (Oct 3)"),
    load("~/.local/share/com.rohanchunduri.eyeapp/logs/pixel_error_*.csv", "Linux build (Oct 10)"),
], ignore_index=True)
d["ex"] = (d.predicted_x - d.target_x) * W
d["ey"] = (d.predicted_y - d.target_y) * H
d["err_px"] = np.hypot(d.ex, d.ey)
d["tx_px"], d["ty_px"] = d.target_x * W, d.target_y * H
d["ecc_px"] = np.hypot(d.tx_px - W / 2, d.ty_px - H / 2)

# Exclusion criteria (stated in the paper text, not hidden):
#  - runs with < 6 points were aborted;
#  - a run whose median sample count < 20 per point never held calibration lock
#    (predicted x pinned near 0.43 for every target) — reported separately as a failure.
n = d.groupby("run").err_px.transform("size")
med_s = d.groupby("run")["samples"].transform("median")
d["status"] = np.where(n < 6, "aborted", np.where(med_s < 20, "failed lock", "valid"))
v = d[d.status == "valid"].copy()
d.to_csv(f"{OUT}/all_points.csv", index=False)

# ---- summary stats ----------------------------------------------------------
def summ(g):
    e = g.err_px
    return pd.Series({"runs": g.run.nunique(), "points": len(g), "mean_px": e.mean(), "median_px": e.median(),
                      "sd_px": e.std(), "p90_px": e.quantile(.9), "rmse_px": np.sqrt((e**2).mean()),
                      "within_100px_%": (e < 100).mean() * 100, "within_200px_%": (e < 200).mean() * 100})
stats = pd.DataFrame({b: summ(g) for b, g in v.groupby("build")}).T
stats.loc["All valid"] = summ(v)
per_run = v.groupby(["build", "run"]).err_px.agg(["size", "mean", "median", "max"]).round(1)
stats.round(1).to_csv(f"{OUT}/summary_stats.csv"); per_run.to_csv(f"{OUT}/per_run_stats.csv")
print(stats.round(1).to_string()); print(per_run.to_string())
print("excluded:", d[d.status != "valid"].groupby(["run", "status"]).size().to_string())

# systematic bias and eccentricity relation (Linux build + all valid)
bias = v.groupby("build")[["ex", "ey"]].mean().round(1); print(bias)
slope, icpt = np.polyfit(v.ecc_px, v.err_px, 1); r = np.corrcoef(v.ecc_px, v.err_px)[0, 1]
print(f"error vs eccentricity: slope={slope:.3f} px/px, r={r:.2f}, n={len(v)}")
v["col"] = pd.cut(v.target_x, [0, .25, .5, .75, 1], labels=False); v["row"] = pd.cut(v.target_y, [0, .34, .67, 1], labels=False)

BUILD_COL = {"Earlier build (Oct 3)": ORANGE, "Linux build (Oct 10)": BLUE}
def save(fig, name):
    for ext in ("pdf", "png"): fig.savefig(f"{OUT}/{name}.{ext}")
    plt.close(fig)

# ---- Fig 1: spatial error map (targets → predicted) --------------------------
fig, ax = plt.subplots(figsize=(6.4, 3.8))
ax.set_xlim(0, W); ax.set_ylim(H, 0); ax.set_aspect("equal"); ax.grid(False)
for b, g in v.groupby("build"):
    c = BUILD_COL[b]
    ax.plot([g.tx_px, g.tx_px + g.ex], [g.ty_px, g.ty_px + g.ey], color=c, lw=0.9, alpha=.55, zorder=2)
    ax.scatter(g.tx_px + g.ex, g.ty_px + g.ey, s=14, color=c, edgecolor="#fcfcfb", linewidth=.6, zorder=3, label=f"{b}  (n={len(g)})")
tg = v.drop_duplicates(["target_x", "target_y"])
ax.scatter(tg.tx_px, tg.ty_px, s=46, marker="+", color=INK, linewidth=1.2, zorder=4, label="Target")
ax.set_xlabel("Screen x (px)"); ax.set_ylabel("Screen y (px)")
ax.set_title("Predicted gaze position relative to each target", loc="left")
ax.legend(loc="upper center", bbox_to_anchor=(.5, -.18), ncol=3, fontsize=8, handletextpad=.3)
save(fig, "fig1_spatial_error_map")

# ---- Fig 2: per-run error distributions --------------------------------------
runs = v.groupby(["build", "run"]).err_px.median().sort_index().index.tolist()
fig, ax = plt.subplots(figsize=(6.4, 3.0)); rng = np.random.default_rng(1)
for i, (b, r_) in enumerate(runs):
    g = v[v.run == r_].err_px.values; c = BUILD_COL[b]
    ax.boxplot(g, positions=[i], widths=.5, showfliers=False, patch_artist=True,
               boxprops=dict(facecolor="none", edgecolor=c, linewidth=1), medianprops=dict(color=c, linewidth=1.6),
               whiskerprops=dict(color=c, linewidth=.9), capprops=dict(color=c, linewidth=.9))
    ax.scatter(i + rng.uniform(-.12, .12, len(g)), g, s=9, color=c, alpha=.6, linewidth=0, zorder=3)
ax.set_xticks(range(len(runs))); ax.set_xticklabels([f"R{i+1}" for i in range(len(runs))])
ax.set_xlabel("Accuracy-test run (chronological within build)"); ax.set_ylabel("Error (px)")
ax.set_title("Per-run distribution of pointwise gaze error", loc="left")
ax.axhline(100, color=MUTED, lw=.7, ls=(0, (4, 3))); ax.set_xlim(-.6, len(runs) + .1); ax.text(len(runs) - .35, 104, "100 px", ha="left", fontsize=7.5, color=MUTED)
h = [plt.Line2D([], [], color=c, lw=2, label=b) for b, c in BUILD_COL.items()]
ax.legend(handles=h, loc="upper left", fontsize=8)
save(fig, "fig2_per_run_distribution")

# ---- Fig 3: ECDF -------------------------------------------------------------
fig, ax = plt.subplots(figsize=(4.4, 3.2))
for b, g in v.groupby("build"):
    x = np.sort(g.err_px.values); y = np.arange(1, len(x) + 1) / len(x)
    ax.step(np.r_[0, x], np.r_[0, y], where="post", color=BUILD_COL[b], lw=1.6, label=f"{b}")
for t in (100, 200):
    ax.axvline(t, color=MUTED, lw=.7, ls=(0, (4, 3)))
ax.set_xlabel("Error (px)"); ax.set_ylabel("Cumulative fraction of targets")
ax.set_ylim(0, 1.02); ax.set_xlim(0, 600)
ax.set_title("Empirical CDF of gaze error", loc="left"); ax.legend(loc="lower right", fontsize=8)
save(fig, "fig3_error_cdf")

# ---- Fig 4: error vs eccentricity -------------------------------------------
fig, ax = plt.subplots(figsize=(4.4, 3.2))
for b, g in v.groupby("build"):
    ax.scatter(g.ecc_px, g.err_px, s=16, color=BUILD_COL[b], alpha=.75, linewidth=0, label=b)
xs = np.linspace(v.ecc_px.min(), v.ecc_px.max(), 50)
ax.plot(xs, slope * xs + icpt, color=INK, lw=1.1, label=f"OLS fit (r = {r:.2f})")
ax.set_xlabel("Target distance from screen centre (px)"); ax.set_ylabel("Error (px)")
ax.set_title("Gaze error vs. target eccentricity (weak positive trend)", loc="left"); ax.legend(fontsize=7.5, loc="upper left")
save(fig, "fig4_error_vs_eccentricity")

# ---- Fig 5: regional mean error heat grid (valid runs, 3x4 cells) -------------
fig, ax = plt.subplots(figsize=(4.4, 3.0)); ax.grid(False)
cells = v.groupby(["row", "col"]).err_px.mean().unstack()
im = ax.imshow(cells.values, cmap="Blues", aspect="auto", vmin=0)
for (i, j), val in np.ndenumerate(cells.values):
    ax.text(j, i, f"{val:.0f}", ha="center", va="center", fontsize=9, color="white" if val > cells.values.max() * .6 else INK)
ax.set_xticks(range(4), ["left", "mid-left", "mid-right", "right"]); ax.set_yticks(range(3), ["top", "middle", "bottom"])
for s in ax.spines.values(): s.set_visible(False)
ax.set_title("Mean error (px) by screen region", loc="left")
cb = fig.colorbar(im, ax=ax, fraction=.04, pad=.03); cb.outline.set_visible(False); cb.set_label("px")
save(fig, "fig5_regional_error")

# ---- Dwell-click logs: injected vs observed cursor ---------------------------
dw = pd.concat([pd.read_csv(f) for f in glob.glob(os.path.expanduser("~/.local/share/com.rohanchunduri.eyeapp/logs/pixel_error.csv"))])
print(f"dwell log (Linux): n={len(dw)}, distance_px mean={dw.distance_px.mean():.2f}, max={dw.distance_px.max():.2f}")
