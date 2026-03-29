## Motivation
Current FACEIT elo means nothing, high elo lobbies are random. So I asked LLM to design rating system that actually takes personal
performance into account. This is fully vibecoded PoC, take it with a grain of salt.

Vibedesigned rating systems documents:
1) [By Claude](claude-rating-design.pdf)
2) [By ChatGPT](chatgpt-rating-design.pdf)

ChatGPT failed to implement demo parsing script, so only Claude version is available.
Demo parsing takes about 2-3s on any decent hardware, thanks to [this great Rust implementation](https://github.com/LaihoE/demoparser).
It makes implementation of such system basically free in terms of hardware cost.
FACEIT already does demo parsing after each match as far as I'm concerned.

### TL;DR
- +-25 as base elo for win/lose
- +-15 elo for personal performance deviation
- Expected performance is to win 50% duels against players of your elo
- Eco duels have less impact
- Amount of duels doesn't matter, so we don't punish anchor roles
- Expected KAST is 70%, deviation should have impact on elo gain as well

## How to run PoC
- Download JSON data of match from `https://www.faceit.com/api/match/v2/match/:matchId`
- Put it inside `./data/:matchId.json`
- Download same match demo
- Put it inside `demos` folder unarchived
- Install deps `pnpm i`
- Run `node src/claude-rating.js :matchId`

## Output example

```bash
$ node src/claude-rating.js 1-f01e9e71-42a7-44db-aecb-f14d0cc57079

📂 Parsing demo: 1-f01e9e71-42a7-44db-aecb-f14d0cc57079-1-1.dem
────────────────────────────────────────────────────────────
   Map: de_ancient
   Kill events: 174
   Damage events: 614
   Rounds: 23
   Winning team: CT (12 rounds)
   Players found: 10
────────────────────────────────────────────────────────────

╔══════════════════════════════════════════════════════════════════════════════════════════╗
║                         PERFORMANCE-ADJUSTED RATING RESULTS                              ║
╚══════════════════════════════════════════════════════════════════════════════════════════╝

  ┌───────────────────────────────── WINNING TEAM ─────────────────────────────────────────┐
  │  Player            Duels  KAST%  P       D_dev   M_kast  D_adj   Delta   Rating        
  │  ──────────────────────────────────────────────────────────────────────────────────────
  │  As__k             27     87%    +0.356  +8.5    1.05    +8.9    +33.9   3060 → 3094
  │  nxrdo             30     91%    +0.180  +4.7    1.06    +5.0    +30.0   3160 → 3190
  │  AlexAJ            26     87%    +0.066  +1.8    1.05    +1.9    +26.9   3450 → 3477
  │  em0k1d67          36     83%    -0.068  -1.8    0.96    -1.8    +23.2   3822 → 3845
  │  Agixi             44     87%    -0.307  -7.5    0.95    -7.2    +17.8   4937 → 4955

  ┌─────────────────────────────────── LOSING TEAM ─────────────────────────────────────────┐
  │  Player            Duels  KAST%  P       D_dev   M_kast  D_adj   Delta   Rating        
  │  ──────────────────────────────────────────────────────────────────────────────────────
  │  dynam1sk          39     61%    +0.081  +2.2    0.97    +2.1    -22.9   3485 → 3462
  │  Donk_SfatheR      38     74%    +0.073  +1.9    1.01    +2.0    -23.0   3789 → 3766
  │  -ToreQ            32     57%    -0.061  -1.6    1.04    -1.7    -26.7   3602 → 3575
  │  sora666-          28     83%    -0.102  -2.7    0.96    -2.6    -27.6   3599 → 3571
  │  AI_ROBOT          26     57%    -0.116  -3.1    1.04    -3.2    -28.2   3340 → 3312

  ┌──────────────────── SYSTEM INTEGRITY CHECK ────────────────┐
  │  Sum of all adjustments: +3.37
  │  Winners total:          +131.85
  │  Losers total:           -128.48
  │  B component sum:        0 (must be 0)
  │  D_dev_adj sum:          +3.37 (≈0 in expectation)
  └───────────────────────────────────────────────────────────┘

📄 JSON output saved to: .output/1-f01e9e71-42a7-44db-aecb-f14d0cc57079.json
```
