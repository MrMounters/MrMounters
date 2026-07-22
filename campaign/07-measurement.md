# Measurement, KPIs & Testing

## North-star
1. **Cost per booked strategy call** (leading)
2. **CAC — cost per closed client** (lagging, the one that matters)

## Funnel KPIs (track weekly)
| Metric | Target (starting) |
|---|---|
| CTR (Meta) | > 1.5% (Reels often 2%+) |
| Cost per lead (audit/booking) | $20–$60 |
| Cost per booked call | $80–$200 |
| Show rate | ≥ 60% |
| Close rate | 25–35% |
| CAC | $800–$2,000 (ceiling $3–6k) |
| Payback | < 1 month (at 80% margin) |
| ROAS (booked revenue ÷ spend) | grows as retention compounds |

## Testing framework
- **Test hooks first** — 80% of performance is the first 3s / first line. 3–5 hooks per concept.
- **Creative cadence:** 3–4 creatives per angle live at once; 3–5 day read; kill under target; 2× winners.
- **One variable at a time** for offers/landing; many variables OK for creative (let the algo sort).
- **Don't scale** a creative past ~$100/day until it clears the booked-call target 3–5 days straight.
- **Refresh** creative every 2–3 weeks (fatigue) — keep a backlog of hooks.

## Attribution — the in-app Acquisition panel (plan §12b)
UTMs (`source/medium/campaign/content`) flow from ad → landing → Cal.com booking → CRM, so the **admin "Acquisition" page** shows, per campaign AND per creative: leads → booked → won → revenue → CPL / CAC / ROAS / close rate — a **winning-creative leaderboard**. Plus avg **speed-to-first-touch per campaign** (dogfood proof). This replaces guessing from Meta/Google dashboards with real ad→revenue truth.

## UTM naming convention (use consistently)
```
utm_source   = meta | google | linkedin
utm_medium   = paid_social | search | paid_display
utm_campaign = medspa_scottsdale_missedmoney   (niche_geo_angle)
utm_content  = fb_reel_johnhook_v3             (creative id — the leaderboard key)
```
Consistent `utm_content` per creative is what makes the winning-creative leaderboard work.

## Weekly review ritual (30 min)
1. Cost per booked call by campaign — cut > target.
2. Winning-creative leaderboard — 2× the top, kill the bottom.
3. Show + close rate — if calls are cheap but not closing, fix the offer/qualification, not the ads.
4. Retention/ROI reports sent to clients — protect the LTV that funds the CAC.
