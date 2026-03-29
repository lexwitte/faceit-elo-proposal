import fs from 'fs';
import path from 'path';

export const getDemoPath = (matchId) => {
  return path.resolve(process.cwd(), `demos/${matchId}-1-1.dem`);
}

export const getDataPath = (matchId) => {
  return path.resolve(process.cwd(), `data/${matchId}.json`);
}

export const extFactory = (matchId) => {
  const externalData = JSON.parse(fs.readFileSync(getDataPath(matchId), { encoding: 'utf-8' }));

  const externalF = externalData.payload.results[0].factions;
  const externalWinner = externalF.faction1.score > externalF.faction2.score ? 'faction1' : 'faction2';
  const externalPlayers = Object.entries(externalData.payload.teams)
    .flatMap(([f, t]) => t.roster.map(p => ({...p, faction: f})));

  return {
    externalWinner,
    getExternal: (steamId) => {
      return externalPlayers.find(p => p.gameId == steamId);
    }
  }
}
