/**
 * ═══════════════════════════════════════════════════════════════════════
 *  Performance-Adjusted Rating Calculator — PoC
 *  Extracts duel, economy, damage, and KAST data from a CS2 .dem file
 *  and computes rating adjustments per the v2.0 specification.
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  Usage:
 *    node rating.js <path_to_demo.dem>            — parse a real demo
 *    node rating.js --simulate                    — run with synthetic data
 *
 *  Dependencies:
 *    npm i @laihoe/demoparser2
 */

const fs = require("fs");
const path = require("path");
const { getDemoPath, getDataPath, extFactory } = require("./helpers");

// ─── Rating system constants (from spec v2.0) ──────────────────────
const RATING = {
  MIN: 2000,
  MAX: 5000,
  BASE: 25,           // B: fixed win/loss base
  DEV_MAX: 15,        // D_dev max absolute value
  KAPPA: 1.8,         // tanh steepness
  ALPHA: 0.70,        // effective outcome: 70% binary, 30% damage
  LAMBDA_FLOOR: 0.25, // minimum fairness weight
  K_REF: 0.70,        // KAST reference (70%)
  BETA: 0.30,         // KAST sensitivity
  ELO_DIVISOR: 1000,   // standard Elo scale factor
  MIN_DUELS: 3,       // minimum duels for performance to count
};

// ─── Core math ──────────────────────────────────────────────────────

/** Elo expected outcome: probability player beats opponent */
function expectedOutcome(playerRating, opponentRating) {
  return 1 / (1 + Math.pow(10, (opponentRating - playerRating) / RATING.ELO_DIVISOR));
}

/** Economy fairness weight */
function fairnessWeight(playerEcon, opponentEcon) {
  const maxE = Math.max(playerEcon, opponentEcon);
  if (maxE === 0) return RATING.LAMBDA_FLOOR; // both zero econ
  const rEco = Math.min(playerEcon, opponentEcon) / maxE;
  return RATING.LAMBDA_FLOOR + (1 - RATING.LAMBDA_FLOOR) * rEco;
}

/** Damage ratio: proportion of total damage dealt by this player */
function damageRatio(dmgDealt, dmgReceived) {
  const total = dmgDealt + dmgReceived;
  if (total === 0) return 0.5; // no damage exchanged
  return dmgDealt / total;
}

/** Effective duel outcome blending binary result with damage */
function effectiveOutcome(won, dmgDealt, dmgReceived) {
  const binary = won ? 1 : 0;
  const dRatio = damageRatio(dmgDealt, dmgReceived);
  return RATING.ALPHA * binary + (1 - RATING.ALPHA) * dRatio;
}

/** Aggregate weighted performance score P */
function aggregatePerformance(duels) {
  if (duels.length < RATING.MIN_DUELS) return 0; // insufficient sample

  let weightedSum = 0;
  let weightSum = 0;

  for (const d of duels) {
    const E = expectedOutcome(d.playerRating, d.opponentRating);
    const Oeff = effectiveOutcome(d.won, d.dmgDealt, d.dmgReceived);
    const wFair = fairnessWeight(d.playerEcon, d.opponentEcon);
    const residual = Oeff - E;

    weightedSum += wFair * residual;
    weightSum += wFair;
  }

  return weightSum === 0 ? 0 : weightedSum / weightSum;
}

/** Non-linear mapping: P -> D_dev via tanh */
function performanceDeviation(P) {
  return RATING.DEV_MAX * Math.tanh(RATING.KAPPA * P);
}

/** KAST multiplier */
function kastMultiplier(Ddev, kastPct) {
  const raw = 1 + RATING.BETA * (kastPct - RATING.K_REF);

  return Ddev > 0 ? raw : 1 / raw;
}

/** Clamp a value to [min, max] */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Compute the full rating adjustment for one player in one match.
 *
 * @param {boolean} won          - did the player's team win?
 * @param {object[]} duels       - array of duel records
 * @param {number} kastPct       - KAST percentage [0, 1]
 * @param {number} currentRating - player's pre-match rating
 * @returns {object} breakdown of the rating adjustment
 */
function computeRatingAdjustment(won, duels, kastPct, currentRating) {
  const s = won ? 1 : -1;
  const B = s * RATING.BASE;

  const P = aggregatePerformance(duels);
  const Ddev = performanceDeviation(P);
  const Mkast = kastMultiplier(Ddev, kastPct);
  const DdevAdj = clamp(Ddev * Mkast, -RATING.DEV_MAX, RATING.DEV_MAX);

  const deltaTotal = B + DdevAdj;
  const newRating = clamp(currentRating + deltaTotal, RATING.MIN, RATING.MAX);

  return {
    B,
    P: +P.toFixed(4),
    Ddev: +Ddev.toFixed(2),
    Mkast: +Mkast.toFixed(3),
    DdevAdj: +DdevAdj.toFixed(2),
    deltaTotal: +deltaTotal.toFixed(2),
    previousRating: currentRating,
    newRating: Math.round(newRating),
    duelCount: duels.length,
    kastPct: +(kastPct * 100).toFixed(1),
  };
}


// ═══════════════════════════════════════════════════════════════════════
//  DEMO PARSING — extract duel & KAST data from a .dem file
// ═══════════════════════════════════════════════════════════════════════
function parseDemoFile(matchId) {
  const { parseEvent, parseHeader, parseTicks, listGameEvents } = require("@laihoe/demoparser2");

  const demoPath = getDemoPath(matchId);

  console.log(`\n📂 Parsing demo: ${path.basename(demoPath)}`);
  console.log("─".repeat(60));

  const { getExternal, externalWinner } = extFactory(matchId);

  // ── 1. Header ─────────────────────────────────────────────
  const header = parseHeader(demoPath);
  console.log(`   Map: ${header.map_name || "unknown"}`);

  // ── 2. Kill events — these define the duels ───────────────
  // player_death fields: attacker_steamid, user_steamid, assister_steamid,
  //   assistedflash, dmg_health, dmg_armor, hitgroup, weapon, etc.
  // We also request player props: total_rounds_played, team_num, and
  //   equipment value via the `player` and `other` arrays.
  const deaths = parseEvent(
    demoPath,
    "player_death",
    [
      "current_equip_value",
      "team_num",
      "health",
    ],
    ["total_rounds_played"]
  );

  console.log(`   Kill events: ${deaths.length}`);

  // ── 3. Damage events — to compute per-duel damage totals ──
  const damages = parseEvent(
    demoPath,
    "player_hurt",
    ["current_equip_value", "team_num"],
    ["total_rounds_played"]
  );

  console.log(`   Damage events: ${damages.length}`);

  // ── 4. Round results ──────────────────────────────────────
  const roundEnds = parseEvent(demoPath, "round_end", [], ["total_rounds_played"]);
  console.log(`   Rounds: ${roundEnds.length}`);

  // ── 5. Identify all players and their teams ───────────────
  const playerMap = new Map(); // steamid -> { name, team, ... }

  for (const d of deaths) {
    // victim
    if (d.user_steamid && !playerMap.has(d.user_steamid)) {
      playerMap.set(d.user_steamid, {
        name: d.user_name || d.user_steamid,
        steamid: d.user_steamid,
        team: d.team_num,
      });
    }
    // attacker
    if (d.attacker_steamid && !playerMap.has(d.attacker_steamid)) {
      playerMap.set(d.attacker_steamid, {
        name: d.attacker_name || d.attacker_steamid,
        steamid: d.attacker_steamid,
        team: d.attacker_team_num || d.team_num, // fallback
      });
    }
  }

  // Refine team assignments — use the most common team_num per player
  // from damage events (more data points)
  const teamVotes = new Map();
  for (const d of damages) {
    if (d.user_steamid) {
      if (!teamVotes.has(d.user_steamid)) teamVotes.set(d.user_steamid, []);
      if (d.team_num) teamVotes.get(d.user_steamid).push(d.team_num);
    }
    if (d.attacker_steamid) {
      if (!teamVotes.has(d.attacker_steamid)) teamVotes.set(d.attacker_steamid, []);
      // attacker team isn't directly in player_hurt; we infer from non-team-damage
    }
  }

  // ── 6. Build per-round damage map ─────────────────────────
  // Key: `${round}:${attacker_steamid}:${victim_steamid}`
  // Value: total damage dealt
  const dmgMap = new Map();

  for (const d of damages) {
    if (!d.attacker_steamid || !d.user_steamid) continue;
    if (d.attacker_steamid === d.user_steamid) continue; // self-damage

    const round = d.total_rounds_played ?? 0;
    const key = `${round}:${d.attacker_steamid}:${d.user_steamid}`;
    dmgMap.set(key, (dmgMap.get(key) || 0) + (d.dmg_health || 0));
  }

  // ── 7. Build duel records from kills ──────────────────────
  // Each kill = one concluded duel between attacker and victim.
  const playerDuels = new Map(); // steamid -> duel[]

  for (const kill of deaths) {
    if (!kill.attacker_steamid || !kill.user_steamid) continue;
    if (kill.attacker_steamid === kill.user_steamid) continue; // suicide

    const round = kill.total_rounds_played ?? 0;
    const attackerSteamid = kill.attacker_steamid;
    const victimSteamid = kill.user_steamid;

    // Damage dealt: attacker -> victim (from dmgMap, or 100 as kill default)
    const atkToVicKey = `${round}:${attackerSteamid}:${victimSteamid}`;
    const vicToAtkKey = `${round}:${victimSteamid}:${attackerSteamid}`;

    const atkDmgDealt = dmgMap.get(atkToVicKey) || 100;
    const vicDmgDealt = dmgMap.get(vicToAtkKey) || 0;

    // Economy values
    const attackerEcon = kill.attacker_current_equip_value || kill.current_equip_value || 1000;
    const victimEcon = kill.user_current_equip_value || kill.current_equip_value || 1000;

    // Attacker's duel (won)
    if (!playerDuels.has(attackerSteamid)) playerDuels.set(attackerSteamid, []);
    playerDuels.get(attackerSteamid).push({
      playerRating: getExternal(attackerSteamid).elo,
      opponentRating: getExternal(victimSteamid).elo,
      won: true,
      dmgDealt: atkDmgDealt,
      dmgReceived: vicDmgDealt,
      playerEcon: attackerEcon,
      opponentEcon: victimEcon,
      round,
    });

    // Victim's duel (lost)
    if (!playerDuels.has(victimSteamid)) playerDuels.set(victimSteamid, []);
    playerDuels.get(victimSteamid).push({
      playerRating: getExternal(victimSteamid).elo,
      opponentRating: getExternal(attackerSteamid).elo,
      won: false,
      dmgDealt: vicDmgDealt,
      dmgReceived: atkDmgDealt,
      playerEcon: victimEcon,
      opponentEcon: attackerEcon,
      round,
    });
  }

  // ── 8. Compute KAST per player ────────────────────────────
  // K: got a kill in the round
  // A: got an assist in the round
  // S: survived the round
  // T: died but was traded (teammate killed the killer within ~5s)
  //    — we approximate trade detection by "teammate killed same
  //      opponent within 3 ticks/rows in the kill feed"

  const totalRounds = roundEnds.length || 1;
  const playerKAST = new Map(); // steamid -> { kastRounds, totalRounds }

  // Per-round tracking
  const roundKills = new Map();    // round -> [{ attacker, victim, tick }]
  const roundDeaths = new Map();   // round -> Set<victim_steamid>
  const roundAssists = new Map();  // round -> Set<assister_steamid>

  for (const kill of deaths) {
    const round = kill.total_rounds_played ?? 0;
    if (!roundKills.has(round)) roundKills.set(round, []);
    roundKills.get(round).push({
      attacker: kill.attacker_steamid,
      victim: kill.user_steamid,
      tick: kill.tick || 0,
    });
    if (kill.user_steamid) {
      if (!roundDeaths.has(round)) roundDeaths.set(round, new Set());
      roundDeaths.get(round).add(kill.user_steamid);
    }
    if (kill.assister_steamid) {
      if (!roundAssists.has(round)) roundAssists.set(round, new Set());
      roundAssists.get(round).add(kill.assister_steamid);
    }
  }

  // Determine team membership from kills (attacker of enemy = opposite team)
  const playerTeams = new Map();
  for (const kill of deaths) {
    if (kill.attacker_steamid && kill.user_steamid &&
        kill.attacker_steamid !== kill.user_steamid) {
      // Attacker and victim are on different teams.
      // Use team_num if available
      const atkTeam = kill.attacker_team_num || null;
      const vicTeam = kill.team_num || null;
      if (atkTeam) playerTeams.set(kill.attacker_steamid, atkTeam);
      if (vicTeam) playerTeams.set(kill.user_steamid, vicTeam);
    }
  }

  // Now compute KAST per player per round
  for (const [steamid] of playerMap) {
    let kastCount = 0;
    const team = playerTeams.get(steamid);

    for (let r = 0; r < totalRounds; r++) {
      const kills = roundKills.get(r) || [];
      const died = roundDeaths.get(r) || new Set();
      const assists = roundAssists.get(r) || new Set();

      // K: player got a kill this round
      const gotKill = kills.some(k => k.attacker === steamid);

      // A: player assisted a kill this round
      const gotAssist = assists.has(steamid);

      // S: player survived the round (was not in death set)
      const survived = !died.has(steamid);

      // T: player died but was traded — killer was killed by a teammate
      //    within a short window after
      let traded = false;
      if (died.has(steamid)) {
        // find who killed this player
        const myDeath = kills.find(k => k.victim === steamid);
        if (myDeath) {
          const killer = myDeath.attacker;
          const deathTick = myDeath.tick;
          // check if a teammate killed the killer within ~5s (~320 ticks at 64tick)
          traded = kills.some(k =>
            k.victim === killer &&
            k.attacker !== steamid &&
            playerTeams.get(k.attacker) === team &&
            k.tick >= deathTick &&
            k.tick <= deathTick + 320
          );
        }
      }

      if (gotKill || gotAssist || survived || traded) {
        kastCount++;
      }
    }

    playerKAST.set(steamid, { kastRounds: kastCount, totalRounds });
  }

  // ── 9. Determine match winner ─────────────────────────────
  // Count round wins per team from round_end events
  const teamRoundWins = new Map();
  for (const re of roundEnds) {
    const winner = re.winner;
    if (winner) {
      teamRoundWins.set(winner, (teamRoundWins.get(winner) || 0) + 1);
    }
  }

  let winningTeam = null;
  let maxWins = 0;
  for (const [team, wins] of teamRoundWins) {
    if (wins > maxWins) {
      maxWins = wins;
      winningTeam = team;
    }
  }

  console.log(`   Winning team: ${winningTeam} (${maxWins} rounds)`);
  console.log(`   Players found: ${playerMap.size}`);
  console.log("─".repeat(60));

  // ── 10. Compute rating for each player ────────────────────
  const results = [];

  for (const [steamid, info] of playerMap) {
    const duels = playerDuels.get(steamid) || [];
    const kast = playerKAST.get(steamid) || { kastRounds: 0, totalRounds: 1 };
    const kastPct = kast.totalRounds > 0 ? kast.kastRounds / kast.totalRounds : 0.70;
    const team = playerTeams.get(steamid) || info.team;
    const won = getExternal(steamid).faction === externalWinner;

    const currentRating = getExternal(steamid).elo;

    const adjustment = computeRatingAdjustment(won, duels, kastPct, currentRating);

    results.push({
      name: info.name,
      steamid,
      team: team,
      won,
      ...adjustment,
    });
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  OUTPUT FORMATTING
// ═══════════════════════════════════════════════════════════════════════

function printResults(results) {
  console.log("\n╔══════════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                         PERFORMANCE-ADJUSTED RATING RESULTS                            ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════════════════╝\n");

  // Sort: winners first, then by delta descending
  results.sort((a, b) => {
    if (a.won !== b.won) return a.won ? -1 : 1;
    return b.deltaTotal - a.deltaTotal;
  });

  // Print team headers
  const winners = results.filter(r => r.won);
  const losers = results.filter(r => !r.won);

  console.log("  ┌─────────────────────── WINNING TEAM ───────────────────────┐");
  printPlayerTable(winners);

  console.log("\n  ┌─────────────────────── LOSING TEAM ────────────────────────┐");
  printPlayerTable(losers);

  // Summary
  console.log("\n  ┌──────────────────── SYSTEM INTEGRITY CHECK ────────────────┐");
  const totalDelta = results.reduce((sum, r) => sum + r.deltaTotal, 0);
  const winnersDelta = winners.reduce((sum, r) => sum + r.deltaTotal, 0);
  const losersDelta = losers.reduce((sum, r) => sum + r.deltaTotal, 0);

  console.log(`  │  Sum of all adjustments: ${totalDelta >= 0 ? "+" : ""}${totalDelta.toFixed(2)}`);
  console.log(`  │  Winners total:          ${winnersDelta >= 0 ? "+" : ""}${winnersDelta.toFixed(2)}`);
  console.log(`  │  Losers total:           ${losersDelta >= 0 ? "+" : ""}${losersDelta.toFixed(2)}`);
  console.log(`  │  B component sum:        ${results.reduce((s, r) => s + r.B, 0)} (must be 0)`);
  const devSum = results.reduce((s, r) => s + r.DdevAdj, 0);
  console.log(`  │  D_dev_adj sum:          ${devSum >= 0 ? "+" : ""}${devSum.toFixed(2)} (≈0 in expectation)`);
  console.log("  └───────────────────────────────────────────────────────────┘");
}

function printPlayerTable(players) {
  const header = "  │  " +
    pad("Player", 18) +
    pad("Duels", 7) +
    pad("KAST%", 7) +
    pad("P", 8) +
    pad("D_dev", 8) +
    pad("M_kast", 8) +
    pad("D_adj", 8) +
    pad("Delta", 8) +
    pad("Rating", 14);
  console.log(header);
  console.log("  │  " + "─".repeat(86));

  for (const r of players) {
    const deltaColor = r.deltaTotal >= 0 ? "\x1b[32m" : "\x1b[31m"; // green/red
    const reset = "\x1b[0m";
    const deltaStr = `${deltaColor}${r.deltaTotal >= 0 ? "+" : ""}${r.deltaTotal.toFixed(1)}${reset}`;
    const ratingStr = `${r.previousRating} → ${r.newRating}`;

    const line = "  │  " +
      pad(r.name, 18) +
      pad(String(r.duelCount), 7) +
      pad(r.kastPct.toFixed(0) + "%", 7) +
      pad((r.P >= 0 ? "+" : "") + r.P.toFixed(3), 8) +
      pad((r.Ddev >= 0 ? "+" : "") + r.Ddev.toFixed(1), 8) +
      pad(r.Mkast.toFixed(2), 8) +
      pad((r.DdevAdj >= 0 ? "+" : "") + r.DdevAdj.toFixed(1), 8) +
      padRight(deltaStr, 8 + deltaColor.length + reset.length) +
      ratingStr;

    console.log(line);
  }
}

function pad(str, len) {
  return String(str).padEnd(len);
}

function padRight(str, len) {
  // account for ANSI escape codes
  return str + " ".repeat(Math.max(0, len - str.length));
}


// ═══════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════

function main() {
  const args = process.argv.slice(2);

  const matchId = args[0];
  const demoPath = getDemoPath(matchId);
  const dataPath = getDataPath(matchId);

  if (!fs.existsSync(demoPath) || !fs.existsSync(dataPath)) {
    console.error(`\n❌ File not found: ${demoPath}`);
    console.error("   Usage: node rating.js <demo.dem>  or  node rating.js --simulate\n");
    process.exit(1);
  }

  const results = parseDemoFile(matchId);

  printResults(results);

  // Also output as JSON for programmatic consumption
  const jsonPath = path.join(process.cwd(), `.output/${matchId}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\n📄 JSON output saved to: ${jsonPath}\n`);
}

main();
