[![make.fun](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Skynzy27/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Skynzy27/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

# gta6-twitch-ccu-forecast-01

A log-scale launch-curve forecaster for the [GTA VI Twitch-viewers bounty on make.fun](https://make.fun/bounty/gta6-twitch-ccu-forecast-01). One hour into GTA VI's release day it forecasts, for each of hours 2–24 (UTC), five quantiles (5/25/50/75/95%) of the concurrent Twitch viewers in the Grand Theft Auto VI category.

## Model

A launch day's Twitch curve is mostly decided by *when* the game unlocks relative to UTC midnight, and by how much of its audience was already watching in hour 1. Hour 1's print anchors the level; the shape — log viewers at hour *h* minus log viewers at hour 1 — is borrowed from the past big launches in the case's own `comparables`, blended from three views per hour:

1. **Family-aware regression** of the log-ratio on log(hour-1 viewers), with unlock-family indicators (rolling-midnight / simultaneous / early-access) so each family's shape sits on its own level while the size slope is shared — v1 pooled every family, which averaged a rolling ramp up with a simultaneous decay and left the median ~0.2 log units too flat late in the day for a rolling target. Fitted on comparables whose hour 1 was at least 5,000 (tiny-hour-1 launches, whose unlock falls late in the day and whose ratios explode 100–2000×, would otherwise drag the fit).
2. **kNN median**: the median log-ratio of the 12 comparables nearest in log hour-1 size.
3. **Rolling-midnight median**: the median log-ratio of the rolling-midnight-unlock comparables — GTA VI unlocks at local midnight, rolling, so this is its own family.

Weights 0.7 / 0.15 / 0.15, then a light 3-point smooth across hours. The spread is honest, not fitted to look confident: for each launch in the target's own unlock family the program re-predicts its curve leaving it out of the pool and keeps the residual; the 5/25/75/95 quantiles are the empirical quantiles of those leave-one-out residuals per hour, re-centred on the residual median and widened 1.6×, and the median is calibrated by the per-hour residual median shrunk halfway toward the global offset — the bias is hour-dependent (early hours run high, late hours run low), so a single global offset leaves a systematic error in both directions. v3 changed the spread from v2's (12 nearest comparables across all families, 1.3×): the scored cases are all rolling-midnight launches, whose shape variance dwarfs the pooled one, so the spread now comes from the reference class itself. A target as big as GTA VI gets the tight spread of other big launches, not the wild spread of tiny ones.

Everything the program knows comes from the case file it is given. No network, no clock, no randomness: two runs on the same case write the same bytes. The target's own history, streams and `categories_hourly` are deliberately unused — streams and categories are null in the practice cases, and history (pre-release level/trend, pre-release diurnal profile) was tested in leave-one-out and did not predict the launch-day shape, so it stays unused.

## Validation

The practice scorer is sealed server-side (graded at submit), so the practice loss is not measurable locally. Instead the entry was validated by leave-one-launch-out over the 37 usable comparables in the kit — each launch forecast from the other 36, scored with the contest's exact pinball loss on the log scale. (An earlier version of this table quoted LOO numbers on a different scale; the numbers below are the contest's log scale, verified against the program's own output byte-for-byte.)

| | v1 | v2 | **v3** |
|---|---|---|---|
| LOO, all 37 launches (mean / median) | 0.206 / 0.130 | 0.188 / 0.101 | 0.245 / 0.194 |
| LOO, big hour-1 (≥ 20k, the GTA VI regime) | 0.131 / 0.094 | 0.119 / 0.085 | 0.172 / 0.162 |
| LOO, rolling-midnight big launches | 0.168 / 0.082 | 0.150 / 0.085 | **0.150 / 0.109** |
| LOO, single-player rolling-big (the practice class) | 0.208 | 0.201 | **0.188** |
| Rolling-big 90% interval coverage | 0.81 | 0.79 | **0.85** |
| Practice loss (server, 4 launches) | 0.221 (rank #3077) | 0.184 (rank #1575) | ~0.17–0.19 est. |

v3's all-launches and big-launch LOO rows are worse than v2's on purpose: the spread is now specialised by unlock family, so non-rolling targets get their own family's (wider) residuals. The scored cases are all rolling-midnight launches, so the rolling rows are the ones that matter. v3 improves on v2 only on the single-player rolling-big row (0.201 → 0.188), driven almost entirely by the Resident Evil Requiem tail (0.521 → 0.412); it loses on 6 of the 8 normal rolling-big launches. The house entries' practice loss is ≈ 0.387; v2 beat it by ~2× on practice.

v2 improved on v1 (practice 0.221) by fitting each unlock family on its own level instead of pooling them, and by calibrating the median per hour instead of with one global offset. v3 tried 36 further LOO variants (extra features, a factor model, direct quantile regression, family-specific slopes, recency weighting, robust fits, blend sweeps) and none beat v2's median — the remaining error is the launch-day shape variance itself: the 8 rolling-big curves span five distinct shapes and no pre-launch observable predicts which one a launch takes. Estimated practice ~0.17–0.19 is below the top-400 bar (0.141), so v3 was built and verified but **not submitted** on this evidence.

The final is a single unseen day, so the practice/LOO numbers are a guide, not a promise — the design is built for generalisation (leave-one-out residuals, no per-launch tuning) rather than for the practice score.

## Run

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Requires Node 22+. Reads every `*.in` in the input directory, writes one `<id>.out` per case. Runs in ~70 ms per case (cap is 8 s), deterministic.

## Layout

- `main.ts` — the forecaster (Node 22, standard library only)
- `.makefun/owner.json` — claim file for the submitting account

---

Optional: earn referral rewards, a second way to make money — [join make.fun with my referral link](https://make.fun/r/jfeejy4f).
