# Chart palette — derivation and validation

Chart color in SENTRY is **computed, not hand-picked**. Every scale below was run
through a palette validator that checks five things numerically:

1. **Lightness band** — OKLCH L within 0.43–0.77 (light) / 0.48–0.67 (dark).
2. **Chroma floor** — OKLCH C ≥ 0.10, so no slot reads as gray and stops doing identity work.
3. **CVD separation** — pairwise ΔE (OKLab ×100) under protanopia and deuteranopia,
   simulated with Machado–Oliveira–Fernandes 2009 at severity 1.0. Target ≥ 8.
4. **Normal-vision floor** — the same pairs under unsimulated vision, ΔE ≥ 15.
5. **Contrast vs the chart surface** — ≥ 3:1.

The brand constraint was tight: Calvis is a monochrome system with exactly one
accent (`#EA5112`). The first instinct — *gray for the baseline arm, orange for the
learned arm* — **failed** the chroma floor (gray has C = 0, so it cannot carry
series identity). That failure is what drove the two structural decisions below.

---

## 1. The three eval arms are **ordinal**, not categorical

`static` → `cold` → `learned` is an ordered progression in capability. Swapping the
order would change the meaning, which makes it ordinal data — so it takes a
**single-hue ramp with monotone lightness**, not three arbitrary hues. The reader
sees the progression *in the color itself*, and it stays on-brand because the hue
is the Calvis orange.

| Token | Light | Dark |
|---|---|---|
| `--arm-1` (static)  | `#E39A73` | `#8A4519` |
| `--arm-2` (cold)    | `#DC6B33` | `#C4742F` |
| `--arm-3` (learned) | `#9C3409` | `#F0B27A` |

```
ORD arms light → ALL CHECKS PASS   (monotone L; ΔL gaps ≥ 0.06; light end 2.24:1)
ORD arms dark  → ALL CHECKS PASS   (monotone L; ΔL gaps ≥ 0.06; light end 2.59:1)
```

An earlier candidate with a lighter opening step (`#F7C0A3`) **failed** light-end
contrast at 1.57:1 and was re-stepped.

## 2. Categorical is capped at **three** slots

The learning-curve chart carries at most three series. That is not a stylistic
choice — under the all-pairs test (where any two marks can sit side by side) three
slots is what clears the floors. A fourth series is not permitted; the views facet
instead.

| Slot | Hue | Light | Dark |
|---|---|---|---|
| `--series-1` | blue | `#2F5E9E` | `#5E97CE` |
| `--series-2` | orange (brand accent) | `#EA5112` | `#E0691F` |
| `--series-3` | teal | `#0E8A6B` | `#12A87C` |

```
CAT light --pairs all → ALL CHECKS PASS
    CVD worst pair  #0E8A6B ↔ #EA5112   ΔE 9.8 (protan)
    normal-vision   #0E8A6B ↔ #2F5E9E   ΔE 17.6
CAT dark  --pairs all → ALL CHECKS PASS
    CVD worst pair  #12A87C ↔ #E0691F   ΔE 11.1 (deutan)
    normal-vision   #12A87C ↔ #5E97CE   ΔE 15.7
```

Getting here took three iterations. A slate/green pair failed the normal-vision
floor at ΔE 13.9; shifting the green toward **teal** cleared both gates without
leaving the Calvis palette (calvis.com already uses a green, `#00BB7F`).

## 3. Sequential ramp for the calibration heatmap

P(event is real) is a magnitude, so it takes **one hue, light → dark**, five steps.
The dark theme re-anchors the ramp rather than inverting it.

| Token | Light | Dark |
|---|---|---|
| `--seq-1` | `#E39A73` | `#8A4519` |
| `--seq-2` | `#D87F4E` | `#A85A24` |
| `--seq-3` | `#C9612C` | `#C4742F` |
| `--seq-4` | `#AB4715` | `#DC9150` |
| `--seq-5` | `#7A2A07` | `#F0B27A` |

```
SEQ light → ALL CHECKS PASS   (light end 2.24:1)
SEQ dark  → ALL CHECKS PASS   (light end 2.59:1)
```

`--seq-empty` is a neutral used for cells with **zero observations** — "unknown" is
a different state from "low probability", and the heatmap must not conflate them.

---

## Rules the views must hold to

- Categorical hues are assigned in **fixed order and never cycled**. A filter that
  changes the series count must not repaint the survivors.
- **Single y-axis only.** Two measures of different scale become two charts.
- Priority (P0–P3) is ordinal and is *always* accompanied by the literal `P0`…`P3`
  text — priority is never communicated by color alone.
- Status colors (good / warn / serious / critical) are **reserved** and never reused
  as a series color; they always ship with a dot **and** a word.
- Text never wears a series color — values and labels stay in `--text-primary` /
  `--text-secondary` / `--text-muted`, and a colored mark beside them carries identity.
- Every chart ships a hover tooltip, and a legend whenever there are ≥ 2 series.

## Reproducing the validation

```bash
node scripts/validate_palette.js "#2F5E9E,#EA5112,#0E8A6B" --mode light --pairs all
node scripts/validate_palette.js "#5E97CE,#E0691F,#12A87C" --mode dark --surface "#141413" --pairs all
node scripts/validate_palette.js "#E39A73,#DC6B33,#9C3409" --ordinal --mode light
node scripts/validate_palette.js "#E39A73,#D87F4E,#C9612C,#AB4715,#7A2A07" --ordinal --mode light
```
