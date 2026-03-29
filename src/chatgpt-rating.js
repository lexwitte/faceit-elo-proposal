#!/usr/bin/env node

/**
 * cs2_rating_poc.js
 *
 * Proof-of-concept rating extractor for CS2 demos using @laihoe/demoparser2.
 *
 * What it does:
 * 1. Parses a demo
 * 2. Reconstructs round context
 * 3. Computes simple KAST
 * 4. Builds duel records from player_death + recent player_hurt
 * 5. Applies a rating-adjustment model inspired by the proposed design doc:
 *      - baseline +/-15 for win/loss
 *      - duel-adjusted performance factor in [-20, +20]
 *      - small support/objective modifier
 *      - zero-sum match-centering correction
 *
 * Inputs:
 *   node cs2_rating_poc.js <demoPath> <ratingsJsonPath> [outputJsonPath]
 *
 * ratings.json shape:
 * {
 *   "PlayerName1": 3120,
 *   "PlayerName2": 2875,
 *   ...
 * }
 *
 * Notes:
 * - This is intentionally a simple PoC, not a production validator.
 * - Field names in demos can vary slightly across parser/game versions.
 * - The script is defensive and falls back where possible.
 */

const fs = require("fs");
const path = require("path");
const process = require("process");
const { getDemoPath, getDataPath, extFactory } = require("./helpers");

let demoparser;
try {
  demoparser = require("@laihoe/demoparser2");
} catch (err) {
  console.error(
    "Failed to load @laihoe/demoparser2. Install it first with:\n" +
      "  npm i @laihoe/demoparser2"
  );
  process.exit(1);
}

const parseEvent =
  demoparser.parseEvent ||
  demoparser.default?.parseEvent;

const parseEvents =
  demoparser.parseEvents ||
  demoparser.default?.parseEvents;

const parseTicks =
  demoparser.parseTicks ||
  demoparser.default?.parseTicks;

if (!parseEvents || !parseTicks) {
  console.error(
    "Could not find parseEvents/parseTicks exports on @laihoe/demoparser2."
  );
  process.exit(1);
}

// ------------------------------
// Constants / tuning knobs
// ------------------------------

const BASELINE_WIN_LOSS = 15;
const DUEL_ADJUSTMENT_CAP = 20;

// Small teamplay contribution so rating doesn't become pure frag-chasing.
const SUPPORT_CAP = 5;

// Trade window. CS-style trade usually happens shortly after death.
// Demoparser events often carry tick. 128 ticks/s is common, 64 exists too.
// 5 seconds is intentionally forgiving for PoC.
const TRADE_WINDOW_TICKS = 5 * 128;

// Recent damage lookback for duel context.
const DAMAGE_LOOKBACK_TICKS = 10 * 128;

// Economy fairness tuning.
const ECON_RATIO_FLOOR = 0.55;
const ECON_RATIO_CEIL = 1.45;

// Objective/support weights.
const WEIGHT_KAST = 0.55;
const WEIGHT_OBJECTIVE = 0.20;
const WEIGHT_ASSIST_RATE = 0.25;

// Placeholder normalization anchors.
// In production these should come from large-scale telemetry percentiles.
const KAST_MEAN = 0.70;
const KAST_STD = 0.12;

const ASSIST_RATE_MEAN = 0.10;
const ASSIST_RATE_STD = 0.06;

const OBJECTIVE_MEAN = 0.20;
const OBJECTIVE_STD = 0.20;

// ------------------------------
// Utility functions
// ------------------------------

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function tanh(x) {
  if (Math.tanh) return Math.tanh(x);
  const e1 = Math.exp(x);
  const e2 = Math.exp(-x);
  return (e1 - e2) / (e1 + e2);
}

function zScore(value, mean, std) {
  if (!Number.isFinite(std) || std <= 0) return 0;
  return (value - mean) / std;
}

function normalizeName(name) {
  return String(name || "").trim();
}

function sortByTick(arr) {
  arr.sort((a, b) => safeNumber(a.tick) - safeNumber(b.tick));
}

function expectedWinProbability(rA, rB) {
  // Elo-like logistic expectation for player-vs-player duel outcome.
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function ratingWeight(rSelf, rOpp) {
  // Slightly increases reward for beating stronger opponents, decreases for weaker.
  // Centered around 1.0 and clipped to stay stable.
  const delta = (safeNumber(rOpp) - safeNumber(rSelf)) / 800;
  return clamp(1 + delta, 0.75, 1.25);
}

function fairnessWeight(selfEquip, oppEquip) {
  const selfV = Math.max(1, safeNumber(selfEquip, 0));
  const oppV = Math.max(1, safeNumber(oppEquip, 0));
  const ratio = selfV / oppV;

  // If ratio is near 1, duel is fair. If far, impact is reduced.
  if (ratio >= ECON_RATIO_FLOOR && ratio <= ECON_RATIO_CEIL) {
    return 1.0;
  }

  // Symmetric penalty based on log distance from 1.
  const unfairness = Math.abs(Math.log(ratio));
  return clamp(Math.exp(-1.1 * unfairness), 0.35, 0.95);
}

function mapDuelScoreToAdjustment(duelScore) {
  // Non-linear map into [-20, +20], saturating for standout performance.
  // duelScore is roughly centered around 0.
  return DUEL_ADJUSTMENT_CAP * tanh(1.35 * duelScore);
}

function mapSupportScoreToAdjustment(supportScore) {
  return SUPPORT_CAP * tanh(0.9 * supportScore);
}

function roundInt(x) {
  return Math.round(x);
}

function ensurePlayer(players, name) {
  if (!players[name]) {
    players[name] = {
      name,
      roundsPlayed: 0,
      teamByRound: new Map(),
      kills: 0,
      deaths: 0,
      assists: 0,
      kastCount: 0,
      kastRounds: new Set(),
      survivedRounds: new Set(),
      wasTradedRounds: new Set(),
      gotTradeKillRounds: new Set(),
      objectivePoints: 0,
      duelEvents: [],
      duelNumerator: 0,
      duelDenominator: 0,
      preMatchRating: null,
      wonMatch: false,
      teamFinal: null
    };
  }
  return players[name];
}

function addKast(players, name, roundNum) {
  if (!name) return;
  const p = ensurePlayer(players, name);
  p.kastRounds.add(roundNum);
}

function setRoundTeam(players, name, roundNum, teamName) {
  if (!name) return;
  const p = ensurePlayer(players, name);
  p.teamByRound.set(roundNum, teamName || null);
}

function getTeamForRound(player, roundNum) {
  return player.teamByRound.get(roundNum) || null;
}

function inferWinnerFromRoundEnd(e) {
  // Common CS values: winner can be 2 (T) or 3 (CT)
  const winner = safeNumber(e.winner, -1);
  if (winner === 2) return "T";
  if (winner === 3) return "CT";

  // Some parser outputs may expose winner_name/team_name
  const s = String(e.winner_name || e.team_name || e.side || "").toUpperCase();
  if (s.includes("CT")) return "CT";
  if (s === "T" || s.includes("TERROR")) return "T";
  return null;
}

function extractObjectivePoints(eventName, e) {
  const n = eventName.toLowerCase();

  if (n.includes("bomb_planted")) return 1.0;
  if (n.includes("bomb_defused")) return 1.2;
  if (n.includes("hostage_rescued")) return 1.2;
  if (n.includes("hostage_follows")) return 0.5;
  if (n.includes("bomb_pickup")) return 0.1;
  return 0;
}

function playerNameFromFields(e, preferredKeys) {
  for (const key of preferredKeys) {
    const v = normalizeName(e[key]);
    if (v) return v;
  }
  return "";
}

// ------------------------------
// Core parser logic
// ------------------------------

async function loadDemoData(demoPath) {
  const eventRequests = [
    {
      eventName: "round_start",
      player: ["name", "team_name", "steamid"],
      other: []
    },
    {
      eventName: "round_end",
      player: ["name", "team_name", "steamid"],
      other: ["winner", "winner_name", "team_name", "reason", "tick"]
    },
    {
      eventName: "player_death",
      player: ["name", "team_name", "steamid"],
      other: [
        "attacker_name",
        "attacker_team_name",
        "assister_name",
        "assister_team_name",
        "weapon",
        "headshot",
        "penetrated",
        "noscope",
        "thrusmoke",
        "attackerblind",
        "is_warmup_period",
        "user_team_name",
        "tick"
      ]
    },
    {
      eventName: "player_hurt",
      player: ["name", "team_name", "steamid"],
      other: [
        "attacker_name",
        "attacker_team_name",
        "weapon",
        "dmg_health",
        "dmg_armor",
        "health",
        "armor",
        "hitgroup",
        "is_warmup_period",
        "user_team_name",
        "tick"
      ]
    },
    {
      eventName: "bomb_planted",
      player: ["name", "team_name", "steamid"],
      other: ["tick"]
    },
    {
      eventName: "bomb_defused",
      player: ["name", "team_name", "steamid"],
      other: ["tick"]
    },
    {
      eventName: "bomb_pickup",
      player: ["name", "team_name", "steamid"],
      other: ["tick"]
    },
    {
      eventName: "hostage_rescued",
      player: ["name", "team_name", "steamid"],
      other: ["tick"]
    },
    {
      eventName: "hostage_follows",
      player: ["name", "team_name", "steamid"],
      other: ["tick"]
    }
  ];

  const events = await parseEvents(demoPath, eventRequests);

  const roundEnds = Array.isArray(events.round_end) ? events.round_end : [];
  const roundStarts = Array.isArray(events.round_start) ? events.round_start : [];
  const deaths = Array.isArray(events.player_death) ? events.player_death : [];
  const hurts = Array.isArray(events.player_hurt) ? events.player_hurt : [];

  const objectiveEvents = [];
  for (const key of [
    "bomb_planted",
    "bomb_defused",
    "bomb_pickup",
    "hostage_rescued",
    "hostage_follows"
  ]) {
    if (Array.isArray(events[key])) {
      for (const e of events[key]) {
        objectiveEvents.push({ ...e, __eventName: key });
      }
    }
  }

  sortByTick(roundStarts);
  sortByTick(roundEnds);
  sortByTick(deaths);
  sortByTick(hurts);
  sortByTick(objectiveEvents);

  return {
    roundStarts,
    roundEnds,
    deaths,
    hurts,
    objectiveEvents
  };
}

function buildRounds(roundStarts, roundEnds) {
  const rounds = [];
  const startTicks = roundStarts.map((e) => safeNumber(e.tick, 0));

  for (let i = 0; i < roundEnds.length; i++) {
    const endEvent = roundEnds[i];
    const endTick = safeNumber(endEvent.tick, 0);
    const startTick =
      i < startTicks.length
        ? startTicks[i]
        : i === 0
        ? 0
        : safeNumber(roundEnds[i - 1].tick, 0) + 1;

    rounds.push({
      roundNum: i + 1,
      startTick,
      endTick,
      winner: inferWinnerFromRoundEnd(endEvent),
      reason: endEvent.reason ?? null
    });
  }

  return rounds;
}

function findRoundForTick(rounds, tick) {
  for (const r of rounds) {
    if (tick >= r.startTick && tick <= r.endTick) return r;
  }
  return null;
}

function buildPlayerState(players, rounds, deaths, objectiveEvents, ratings) {
  for (const [name, rating] of Object.entries(ratings)) {
    const p = ensurePlayer(players, normalizeName(name));
    p.preMatchRating = safeNumber(rating, 2000);
  }

  // Count rounds played later when team membership is seen.
  // Populate kills, deaths, assists from death events.
  for (const d of deaths) {
    if (d.is_warmup_period) continue;

    const tick = safeNumber(d.tick, 0);
    const round = findRoundForTick(rounds, tick);
    if (!round) continue;

    const roundNum = round.roundNum;

    const victim = playerNameFromFields(d, ["name", "user_name", "player_name"]);
    const attacker = playerNameFromFields(d, ["attacker_name"]);
    const assister = playerNameFromFields(d, ["assister_name"]);

    const victimTeam = normalizeName(d.team_name || d.user_team_name);
    const attackerTeam = normalizeName(d.attacker_team_name);
    const assisterTeam = normalizeName(d.assister_team_name);

    if (victim) {
      ensurePlayer(players, victim).deaths += 1;
      setRoundTeam(players, victim, roundNum, victimTeam);
      addKast(players, victim, roundNum); // "K" part doesn't apply to victim, but set later with survival/trade
    }

    if (attacker && attacker !== victim) {
      ensurePlayer(players, attacker).kills += 1;
      setRoundTeam(players, attacker, roundNum, attackerTeam);
      addKast(players, attacker, roundNum); // K in KAST
    }

    if (assister && assister !== attacker && assister !== victim) {
      ensurePlayer(players, assister).assists += 1;
      setRoundTeam(players, assister, roundNum, assisterTeam);
      addKast(players, assister, roundNum); // A in KAST
    }
  }

  for (const e of objectiveEvents) {
    const tick = safeNumber(e.tick, 0);
    const round = findRoundForTick(rounds, tick);
    if (!round) continue;

    const actor = playerNameFromFields(e, ["name", "player_name", "user_name"]);
    if (!actor) continue;

    const p = ensurePlayer(players, actor);
    p.objectivePoints += extractObjectivePoints(e.__eventName, e);
    setRoundTeam(players, actor, round.roundNum, normalizeName(e.team_name));
  }
}

function markSurvivorsAndRounds(players, rounds, deaths) {
  const deathsByRound = new Map();

  for (const d of deaths) {
    if (d.is_warmup_period) continue;
    const tick = safeNumber(d.tick, 0);
    const round = findRoundForTick(rounds, tick);
    if (!round) continue;

    const victim = playerNameFromFields(d, ["name", "user_name", "player_name"]);
    if (!victim) continue;

    if (!deathsByRound.has(round.roundNum)) deathsByRound.set(round.roundNum, new Set());
    deathsByRound.get(round.roundNum).add(victim);
  }

  for (const player of Object.values(players)) {
    for (const [roundNum] of player.teamByRound.entries()) {
      player.roundsPlayed += 1;
      const deadThisRound = deathsByRound.get(roundNum)?.has(player.name) || false;
      if (!deadThisRound) {
        player.survivedRounds.add(roundNum);
        player.kastRounds.add(roundNum); // S in KAST
      }
    }
  }
}

function markTrades(players, rounds, deaths) {
  // If teammate kills your killer shortly after your death, victim gets KAST via trade,
  // and teammate gets trade-kill marker.
  for (let i = 0; i < deaths.length; i++) {
    const d1 = deaths[i];
    if (d1.is_warmup_period) continue;

    const tick1 = safeNumber(d1.tick, 0);
    const round1 = findRoundForTick(rounds, tick1);
    if (!round1) continue;

    const victim = playerNameFromFields(d1, ["name", "user_name", "player_name"]);
    const killer = playerNameFromFields(d1, ["attacker_name"]);
    const victimTeam = normalizeName(d1.team_name || d1.user_team_name);

    if (!victim || !killer || victim === killer) continue;

    for (let j = i + 1; j < deaths.length; j++) {
      const d2 = deaths[j];
      if (d2.is_warmup_period) continue;

      const tick2 = safeNumber(d2.tick, 0);
      if (tick2 - tick1 > TRADE_WINDOW_TICKS) break;

      const round2 = findRoundForTick(rounds, tick2);
      if (!round2 || round2.roundNum !== round1.roundNum) continue;

      const victim2 = playerNameFromFields(d2, ["name", "user_name", "player_name"]);
      const killer2 = playerNameFromFields(d2, ["attacker_name"]);
      const killer2Team = normalizeName(d2.attacker_team_name);

      if (victim2 === killer && killer2Team === victimTeam && killer2 !== victim) {
        ensurePlayer(players, victim).wasTradedRounds.add(round1.roundNum);
        ensurePlayer(players, victim).kastRounds.add(round1.roundNum); // T in KAST
        ensurePlayer(players, killer2).gotTradeKillRounds.add(round1.roundNum);
        break;
      }
    }
  }
}

function assignMatchWinner(players, rounds) {
  let tWins = 0;
  let ctWins = 0;
  for (const r of rounds) {
    if (r.winner === "T") tWins += 1;
    if (r.winner === "CT") ctWins += 1;
  }

  const winningSide = tWins > ctWins ? "T" : ctWins > tWins ? "CT" : null;

  for (const player of Object.values(players)) {
    // Use last known team as final side.
    const sortedRounds = [...player.teamByRound.keys()].sort((a, b) => a - b);
    const finalRound = sortedRounds[sortedRounds.length - 1];
    const finalTeam = finalRound ? getTeamForRound(player, finalRound) : null;
    player.teamFinal = finalTeam;
    if (winningSide && finalTeam) {
      player.wonMatch = finalTeam.toUpperCase().includes(winningSide);
    } else {
      player.wonMatch = false;
    }
  }
}

async function enrichEconomyOnTicks(demoPath, ticks, namesNeeded) {
  const uniqueTicks = [...new Set(ticks.filter((t) => Number.isFinite(t)))];
  if (uniqueTicks.length === 0) return new Map();

  const columns = [
    "name",
    "team_name",
    "current_equip_value",
    "health",
    "armor",
    "is_alive"
  ];

  const rows = await parseTicks(demoPath, uniqueTicks, columns);

  const byTickName = new Map();
  for (const row of rows || []) {
    const tick = safeNumber(row.tick, 0);
    const name = normalizeName(row.name);
    if (!name || (namesNeeded && !namesNeeded.has(name))) continue;

    const key = `${tick}::${name}`;
    byTickName.set(key, row);
  }

  return byTickName;
}

function buildDamageIndex(hurts, rounds) {
  // Store recent damage A->B with tick and dmg.
  const byPair = new Map();

  for (const h of hurts) {
    if (h.is_warmup_period) continue;

    const tick = safeNumber(h.tick, 0);
    const round = findRoundForTick(rounds, tick);
    if (!round) continue;

    const victim = playerNameFromFields(h, ["name", "user_name", "player_name"]);
    const attacker = playerNameFromFields(h, ["attacker_name"]);
    if (!victim || !attacker || victim === attacker) continue;

    const dmg = safeNumber(h.dmg_health, 0);
    const key = `${round.roundNum}::${attacker}::${victim}`;

    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push({ tick, dmg });
  }

  for (const arr of byPair.values()) {
    arr.sort((a, b) => a.tick - b.tick);
  }

  return byPair;
}

function recentDamageSum(arr, tick, lookback) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  let sum = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const x = arr[i];
    if (tick - x.tick > lookback) break;
    if (x.tick <= tick) sum += safeNumber(x.dmg, 0);
  }
  return sum;
}

async function buildDuels(demoPath, players, rounds, deaths, hurts, ratings) {
  const tickSet = new Set();
  const namesSet = new Set();

  for (const d of deaths) {
    if (d.is_warmup_period) continue;
    const tick = safeNumber(d.tick, 0);
    tickSet.add(tick);

    const victim = playerNameFromFields(d, ["name", "user_name", "player_name"]);
    const attacker = playerNameFromFields(d, ["attacker_name"]);
    if (victim) namesSet.add(victim);
    if (attacker) namesSet.add(attacker);
  }

  const stateByTickName = await enrichEconomyOnTicks(
    demoPath,
    [...tickSet],
    namesSet
  );

  const damageIndex = buildDamageIndex(hurts, rounds);

  for (const d of deaths) {
    if (d.is_warmup_period) continue;

    const tick = safeNumber(d.tick, 0);
    const round = findRoundForTick(rounds, tick);
    if (!round) continue;

    const loser = playerNameFromFields(d, ["name", "user_name", "player_name"]);
    const winner = playerNameFromFields(d, ["attacker_name"]);
    if (!winner || !loser || winner === loser) continue;

    const pWinner = ensurePlayer(players, winner);
    const pLoser = ensurePlayer(players, loser);

    const winnerRating = safeNumber(
      pWinner.preMatchRating ?? ratings[winner],
      2500
    );
    const loserRating = safeNumber(
      pLoser.preMatchRating ?? ratings[loser],
      2500
    );

    const winnerState = stateByTickName.get(`${tick}::${winner}`) || {};
    const loserState = stateByTickName.get(`${tick}::${loser}`) || {};

    const winnerEquip = safeNumber(winnerState.current_equip_value, 0);
    const loserEquip = safeNumber(loserState.current_equip_value, 0);

    const fairWeightWL = fairnessWeight(winnerEquip, loserEquip);
    const fairWeightLW = fairnessWeight(loserEquip, winnerEquip);

    const damageWinnerToLoser = recentDamageSum(
      damageIndex.get(`${round.roundNum}::${winner}::${loser}`),
      tick,
      DAMAGE_LOOKBACK_TICKS
    );

    const damageLoserToWinner = recentDamageSum(
      damageIndex.get(`${round.roundNum}::${loser}::${winner}`),
      tick,
      DAMAGE_LOOKBACK_TICKS
    );

    // Damage participation score:
    // for winner, lethal duel win with how much of the damage they personally did.
    // for loser, credit partial damage before dying.
    const winnerDamageFrac = clamp(damageWinnerToLoser / 100, 0.2, 1.0);
    const loserDamageFrac = clamp(damageLoserToWinner / 100, 0.0, 1.0);

    const expectedWinner = expectedWinProbability(winnerRating, loserRating);
    const expectedLoser = 1 - expectedWinner;

    const winnerValue =
      fairWeightWL *
      ratingWeight(winnerRating, loserRating) *
      (1 - expectedWinner) *
      winnerDamageFrac;

    const loserValue =
      fairWeightLW *
      ratingWeight(loserRating, winnerRating) *
      (0 - expectedLoser + 0.55 * loserDamageFrac);

    pWinner.duelEvents.push({
      round: round.roundNum,
      opponent: loser,
      outcome: 1,
      fairWeight: fairWeightWL,
      ratingWeight: ratingWeight(winnerRating, loserRating),
      expected: expectedWinner,
      ownDamage: damageWinnerToLoser,
      oppDamage: damageLoserToWinner,
      value: winnerValue
    });

    pLoser.duelEvents.push({
      round: round.roundNum,
      opponent: winner,
      outcome: 0,
      fairWeight: fairWeightLW,
      ratingWeight: ratingWeight(loserRating, winnerRating),
      expected: expectedLoser,
      ownDamage: damageLoserToWinner,
      oppDamage: damageWinnerToLoser,
      value: loserValue
    });
  }

  // Role-neutral normalization:
  // Average duel event value rather than raw sum so entry fraggers/supports
  // are not rewarded just for raw duel count.
  for (const p of Object.values(players)) {
    const values = p.duelEvents.map((x) => safeNumber(x.value, 0));
    if (values.length === 0) {
      p.duelNumerator = 0;
      p.duelDenominator = 1;
      continue;
    }

    const meanValue =
      values.reduce((acc, x) => acc + x, 0) / Math.max(1, values.length);

    // Reliability shrinkage so very low sample sizes don't spike.
    const n = values.length;
    const reliability = n / (n + 6);

    p.duelNumerator = meanValue * reliability;
    p.duelDenominator = 1;
  }
}

function computeSupportScore(player) {
  const rounds = Math.max(1, player.roundsPlayed);
  const kast = player.kastRounds.size / rounds;
  const assistRate = player.assists / rounds;
  const objectivePerRound = player.objectivePoints / rounds;

  const kastZ = zScore(kast, KAST_MEAN, KAST_STD);
  const assistZ = zScore(assistRate, ASSIST_RATE_MEAN, ASSIST_RATE_STD);
  const objectiveZ = zScore(objectivePerRound, OBJECTIVE_MEAN, OBJECTIVE_STD);

  return (
    WEIGHT_KAST * clamp(kastZ, -2, 2) +
    WEIGHT_ASSIST_RATE * clamp(assistZ, -2, 2) +
    WEIGHT_OBJECTIVE * clamp(objectiveZ, -2, 2)
  );
}

function finalizeRatingAdjustments(players) {
  const results = [];

  for (const p of Object.values(players)) {
    const baseline = p.wonMatch ? BASELINE_WIN_LOSS : -BASELINE_WIN_LOSS;

    const duelScore = p.duelNumerator / Math.max(1, p.duelDenominator);
    const duelAdj = mapDuelScoreToAdjustment(duelScore);

    const supportScore = computeSupportScore(p);
    const supportAdj = mapSupportScoreToAdjustment(supportScore);

    // Team-preserving guardrail:
    // support cannot fully override the match result, only modulate it.
    // Losses by excellent performers can become much less negative,
    // but not flip positive here before centering.
    let rawDelta = baseline + duelAdj + supportAdj;

    if (!p.wonMatch) {
      rawDelta = Math.min(rawDelta, +8);
    } else {
      rawDelta = Math.max(rawDelta, -8);
    }

    results.push({
      name: p.name,
      preMatchRating: p.preMatchRating,
      wonMatch: p.wonMatch,
      team: p.teamFinal,
      roundsPlayed: p.roundsPlayed,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      kast: p.roundsPlayed > 0 ? p.kastRounds.size / p.roundsPlayed : 0,
      objectivePoints: p.objectivePoints,
      duelCount: p.duelEvents.length,
      duelScore,
      duelAdjustment: duelAdj,
      supportScore,
      supportAdjustment: supportAdj,
      baselineAdjustment: baseline,
      rawAdjustment: rawDelta
    });
  }

  // Match-centering correction:
  // Keeps total rating drift near zero per lobby.
  const totalRaw = results.reduce((acc, r) => acc + r.rawAdjustment, 0);
  const correction = totalRaw / Math.max(1, results.length);

  for (const r of results) {
    r.centeringCorrection = -correction;
    r.finalAdjustment = roundInt(r.rawAdjustment - correction);
    r.postMatchRating = roundInt(
      safeNumber(r.preMatchRating, 2000) + r.finalAdjustment
    );
  }

  // Optional extra pass: ensure integer adjustments sum to ~0 exactly.
  let sumInt = results.reduce((acc, r) => acc + r.finalAdjustment, 0);
  if (sumInt !== 0) {
    const ordered = [...results].sort(
      (a, b) =>
        Math.abs(b.rawAdjustment - correction - b.finalAdjustment) -
        Math.abs(a.rawAdjustment - correction - a.finalAdjustment)
    );

    let idx = 0;
    while (sumInt !== 0 && idx < ordered.length * 3) {
      const target = ordered[idx % ordered.length];
      if (sumInt > 0) {
        target.finalAdjustment -= 1;
        target.postMatchRating -= 1;
        sumInt -= 1;
      } else {
        target.finalAdjustment += 1;
        target.postMatchRating += 1;
        sumInt += 1;
      }
      idx += 1;
    }
  }

  return results.sort((a, b) => b.finalAdjustment - a.finalAdjustment);
}

// ------------------------------
// Main
// ------------------------------

async function main() {
  const matchId = process.argv[2];

  if (!matchId) {
    console.error(
      "Usage:\n" +
        "  node cs2_rating_poc.js <matchId>"
    );
    process.exit(1);
  }

  const resolvedDemo = getDemoPath(matchId);
  const resolvedData = getDataPath(matchId);

  if (!fs.existsSync(resolvedDemo)) {
    console.error(`Demo file not found: ${resolvedDemo}`);
    process.exit(1);
  }

  if (!fs.existsSync(resolvedData)) {
    console.error(`Data file not found: ${resolvedData}`);
    process.exit(1);
  }

  const { toRatings } = extFactory(matchId);

  const ratings = toRatings();

  const demoData = await loadDemoData(resolvedDemo);
  const rounds = buildRounds(demoData.roundStarts, demoData.roundEnds);

  if (rounds.length === 0) {
    console.error("No rounds found in demo. Cannot compute match rating.");
    process.exit(1);
  }

  const players = {};

  buildPlayerState(
    players,
    rounds,
    demoData.deaths,
    demoData.objectiveEvents,
    ratings
  );

  markSurvivorsAndRounds(players, rounds, demoData.deaths);
  markTrades(players, rounds, demoData.deaths);
  assignMatchWinner(players, rounds);

  await buildDuels(
    resolvedDemo,
    players,
    rounds,
    demoData.deaths,
    demoData.hurts,
    ratings
  );

  // Ensure any player seen only in ratings file still has rounds info fallback.
  for (const [name, rating] of Object.entries(ratings)) {
    const p = ensurePlayer(players, normalizeName(name));
    if (p.preMatchRating == null) p.preMatchRating = safeNumber(rating, 2000);
  }

  const results = finalizeRatingAdjustments(players);

  const payload = {
    meta: {
      demoPath: resolvedDemo,
      rounds: rounds.length,
      baselineWinLoss: BASELINE_WIN_LOSS,
      duelAdjustmentCap: DUEL_ADJUSTMENT_CAP,
      supportCap: SUPPORT_CAP,
      notes: [
        "PoC implementation of match rating adjustment.",
        "Current player ratings are loaded from external JSON.",
        "Duel events are derived from lethal engagements and recent damage context.",
        "Fairness uses current_equip_value ratio as an economy proxy.",
        "KAST/objective support is included as a small non-frag modifier.",
        "Final adjustments are match-centered to keep pool drift near zero."
      ]
    },
    rounds,
    players: results
  };

  const json = JSON.stringify(payload, null, 2);

  if (outputPath) {
    fs.writeFileSync(path.resolve(outputPath), json, "utf8");
    console.log(`Wrote results to ${path.resolve(outputPath)}`);
  } else {
    console.log(json);
  }
}

main().catch((err) => {
  console.error("Fatal error while processing demo:");
  console.error(err);
  process.exit(1);
});
