export const GAME_CONFIGS = {
  overwatch: {
    name: 'Overwatch 2', shortName: 'OW2', accent: '#f06414', maxScore: 3,
    scoreLabel: 'Map score', rosterSize: 5,
    characterLabel: 'Hero',
    modes: ['Control', 'Hybrid', 'Flashpoint', 'Escort', 'Push'],
    maps: ['Busan', 'Ilios', 'Lijiang Tower', 'Midtown', 'King’s Row', 'Suravasa', 'New Junk City', 'Circuit Royal', 'Rialto', 'Esperança', 'Runasapi'],
    roles: ['Tank', 'Damage', 'Support', 'Coach'],
    characters: [
      'Ana', 'Anran', 'Ashe', 'Baptiste', 'Bastion', 'Brigitte', 'Cassidy', 'D.Mon', 'D.Va', 'Domina',
      'Doomfist', 'Echo', 'Emre', 'Freja', 'Genji', 'Hanzo', 'Hazard', 'Illari', 'Jetpack Cat', 'Junker Queen',
      'Junkrat', 'Juno', 'Kiriko', 'Lifeweaver', 'Lúcio', 'Mauga', 'Mei', 'Mercy', 'Mizuki', 'Moira', 'Orisa',
      'Pharah', 'Ramattra', 'Reaper', 'Reinhardt', 'Roadhog', 'Shion', 'Sigma', 'Sierra', 'Sojourn', 'Soldier: 76',
      'Sombra', 'Symmetra', 'Torbjörn', 'Tracer', 'Venture', 'Vendetta', 'Widowmaker', 'Winston', 'Wrecking Ball',
      'Wuyang', 'Zarya', 'Zenyatta'
    ],
    format: 'First to 3 maps'
  },
  valorant: {
    name: 'VALORANT', shortName: 'VAL', accent: '#ff4655', maxScore: 2,
    scoreLabel: 'Series score', rosterSize: 5,
    characterLabel: 'Agent',
    modes: ['Map 1', 'Map 2', 'Map 3', 'Map 4', 'Map 5'],
    maps: ['Abyss', 'Ascent', 'Bind', 'Breeze', 'Corrode', 'Haven', 'Icebox', 'Lotus', 'Pearl', 'Split', 'Sunset'],
    roles: ['Duelist', 'Initiator', 'Controller', 'Sentinel', 'Flex', 'Coach'],
    characters: [
      'Astra', 'Breach', 'Brimstone', 'Chamber', 'Clove', 'Cypher', 'Deadlock', 'Fade', 'Gekko', 'Harbor',
      'Iso', 'Jett', 'KAY/O', 'Killjoy', 'Miks', 'Neon', 'Omen', 'Phoenix', 'Raze', 'Reyna', 'Sage', 'Skye',
      'Sova', 'Tejo', 'Veto', 'Viper', 'Vyse', 'Waylay', 'Yoru'
    ],
    format: 'Best of 3'
  },
  rocketleague: {
    name: 'Rocket League', shortName: 'RL', accent: '#2d8cff', maxScore: 4,
    scoreLabel: 'Series score', rosterSize: 3,
    characterLabel: 'Car / preset',
    modes: ['Game 1', 'Game 2', 'Game 3', 'Game 4', 'Game 5', 'Game 6', 'Game 7'],
    maps: ['DFH Stadium', 'Mannfield', 'Champions Field', 'Utopia Coliseum', 'Beckwith Park', 'Forbidden Temple'],
    roles: ['Starter', 'Substitute', 'Coach'],
    characters: [
      'Octane', 'Fennec', 'Dominus', 'Breakout', 'Batmobile (2016)', 'Merc', 'Scarab', 'Takumi', 'Endo',
      'Jäger 619', 'Mantis', 'Twinzer', 'Dingo', 'Maestro', 'Nissan Skyline', 'McLaren 570S', 'BMW M240i'
    ],
    format: 'Best of 7'
  },
  smash: {
    name: 'Smash Bros. Ultimate', shortName: 'SSBU', accent: '#e03b32', maxScore: 3,
    scoreLabel: 'Set score', rosterSize: 1,
    characterLabel: 'Fighter',
    modes: ['Game 1', 'Game 2', 'Game 3', 'Game 4', 'Game 5'],
    maps: ['Battlefield', 'Small Battlefield', 'Final Destination', 'Pokémon Stadium 2', 'Hollow Bastion', 'Town and City', 'Smashville', 'Kalos Pokémon League'],
    roles: ['Player', 'Captain', 'Coach'],
    characters: [
      'Mario', 'Donkey Kong', 'Link', 'Samus', 'Dark Samus', 'Yoshi', 'Kirby', 'Fox', 'Pikachu', 'Luigi',
      'Ness', 'Captain Falcon', 'Jigglypuff', 'Peach', 'Daisy', 'Bowser', 'Ice Climbers', 'Sheik', 'Zelda',
      'Dr. Mario', 'Pichu', 'Falco', 'Marth', 'Lucina', 'Young Link', 'Ganondorf', 'Mewtwo', 'Roy', 'Chrom',
      'Mr. Game & Watch', 'Meta Knight', 'Pit', 'Dark Pit', 'Zero Suit Samus', 'Wario', 'Snake', 'Ike',
      'Pokémon Trainer', 'Diddy Kong', 'Lucas', 'Sonic', 'King Dedede', 'Olimar', 'Lucario', 'R.O.B.', 'Toon Link',
      'Wolf', 'Villager', 'Mega Man', 'Wii Fit Trainer', 'Rosalina & Luma', 'Little Mac', 'Greninja', 'Mii Brawler',
      'Mii Swordfighter', 'Mii Gunner', 'Palutena', 'Pac-Man', 'Robin', 'Shulk', 'Bowser Jr.', 'Duck Hunt', 'Ryu',
      'Ken', 'Cloud', 'Corrin', 'Bayonetta', 'Inkling', 'Ridley', 'Simon', 'Richter', 'King K. Rool', 'Isabelle',
      'Incineroar', 'Piranha Plant', 'Joker', 'Hero', 'Banjo & Kazooie', 'Terry', 'Byleth', 'Min Min', 'Steve',
      'Sephiroth', 'Pyra / Mythra', 'Kazuya', 'Sora'
    ],
    format: 'Best of 5'
  },
  callofduty: {
    name: 'Call of Duty', shortName: 'COD', accent: '#8dd936', maxScore: 3,
    scoreLabel: 'Map score', rosterSize: 4,
    characterLabel: 'Operator / loadout',
    modes: ['Hardpoint', 'Search & Destroy', 'Control', 'Hardpoint', 'Search & Destroy'],
    maps: ['Protocol', 'Red Card', 'Rewind', 'Skyline', 'Vault', 'Hacienda'],
    roles: ['AR', 'SMG', 'Flex', 'Substitute', 'Coach'],
    characters: [
      'Adler', 'Park', 'Woods', 'Nazir', 'Westpoint', 'Bayan', 'Alvarez', 'Payne', 'Marshall', 'Weaver', 'Maya',
      'Brutus', 'Klaus', 'Rossi', 'Caine', 'Niran', 'Toro', 'Bailey', 'Stone', 'Carver', 'Grey'
    ],
    format: 'Best of 5'
  }
};

export const GAME_ORDER = ['overwatch', 'valorant', 'rocketleague', 'smash', 'callofduty'];

export function createPlayer(config, index = 0, includeSample = false) {
  return {
    handle: includeSample ? 'BengalOne' : '',
    name: '',
    role: config.roles[index % Math.min(config.roles.length, 3)],
    character: '',
    playerImage: '',
    playerImageName: '',
    characterImage: '',
    characterImageName: ''
  };
}

export function createGameState(gameKey) {
  const config = GAME_CONFIGS[gameKey];
  return {
    teams: [
      { name: 'IDAHO STATE', shortName: 'ISU', color: '#f47920', secondaryColor: '#101012', secondaryColorEnabled: true, score: 0, detailScore: 0 },
      { name: 'OPPONENT', shortName: 'OPP', color: '#5e6673', secondaryColor: '#d9dce2', secondaryColorEnabled: false, score: 0, detailScore: 0 }
    ],
    match: { event: 'COLLEGIATE ESPORTS', round: 'REGULAR SEASON', format: config.format, live: false },
    activeMap: 0,
    mapRows: config.modes.map((mode, index) => ({
      mode,
      map: gameKey === 'rocketleague' ? '' : config.maps[index % config.maps.length],
      arenaId: '',
      arenaImage: '',
      status: index === 0 ? 'ready' : 'upcoming',
      winner: null,
      score: ['', '']
    })),
    veto: {
      bans: ['Breeze', 'Icebox', 'Pearl', 'Sunset'],
      picks: [
        { map: 'Ascent', attackers: 0, score: ['', ''], winner: null },
        { map: 'Bind', attackers: 1, score: ['', ''], winner: null },
        { map: 'Haven', attackers: 0, score: ['', ''], winner: null }
      ]
    },
    rosters: {
      varsity: Array.from({ length: config.rosterSize }, (_, index) => createPlayer(config, index, index === 0)),
      jv: Array.from({ length: config.rosterSize }, (_, index) => createPlayer(config, index, false))
    },
    awayRosters: {
      varsity: Array.from({ length: config.rosterSize }, (_, index) => createPlayer(config, index, false)),
      jv: Array.from({ length: config.rosterSize }, (_, index) => createPlayer(config, index, false))
    },
    showAwayRoster: false,
    characterArt: {},
    rocketLeague: gameKey === 'rocketleague' ? {
      enabled: false,
      source: 'local',
      transport: 'auto',
      host: '127.0.0.1',
      tcpPort: 49123,
      webPort: 49124,
      bridgePort: 3175,
      bridgeToken: '',
      updateIntervalMs: 33,
      blueTeam: 0,
      syncGoals: true,
      syncClock: true,
      syncPlayers: true,
      autoSeriesScore: true,
      autoAdvance: true,
      processedMatches: [],
      live: {
        status: 'disabled',
        message: 'Live data is off',
        transport: null,
        lastPacketAt: null,
        packets: 0,
        packetRate: 0,
        dataAgeMs: null,
        bridgeClients: 0,
        matchGuid: '',
        timeSeconds: 300,
        overtime: false,
        arena: '',
        spectatedPlayer: '',
        players: []
      }
    } : null
  };
}

export function createInitialState() {
  return {
    version: 4,
    selectedGame: 'overwatch',
    activeView: 'control',
    activeRoster: 'varsity',
    activeRosterSide: 'home',
    updatedAt: null,
    games: Object.fromEntries(GAME_ORDER.map((key) => [key, createGameState(key)]))
  };
}
