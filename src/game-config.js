const OVERWATCH_HERO_ART = {
  Ana: 'ana.webp',
  Anran: 'anran.webp',
  Ashe: 'ashe.webp',
  Baptiste: 'baptiste.webp',
  Bastion: 'bastion.webp',
  Brigitte: 'brigitte.webp',
  Cassidy: 'cassidy.webp',
  'D.Mon': 'dmon.webp',
  'D.Va': 'dva.webp',
  Domina: 'domina.webp',
  Doomfist: 'doomfist.webp',
  Echo: 'echo.webp',
  Emre: 'emre.webp',
  Freja: 'freja.webp',
  Genji: 'genji.webp',
  Hanzo: 'hanzo.webp',
  Hazard: 'hazard.webp',
  Illari: 'illari.webp',
  'Jetpack Cat': 'jetpack-cat.webp',
  'Junker Queen': 'junker-queen.webp',
  Junkrat: 'junkrat.webp',
  Juno: 'juno.webp',
  Kiriko: 'kiriko.webp',
  Lifeweaver: 'lifeweaver.webp',
  'Lúcio': 'lucio.webp',
  Mauga: 'mauga.webp',
  Mei: 'mei.webp',
  Mercy: 'mercy.webp',
  Mizuki: 'mizuki.webp',
  Moira: 'moira.webp',
  Orisa: 'orisa.webp',
  Pharah: 'pharah.webp',
  Ramattra: 'ramattra.webp',
  Reaper: 'reaper.webp',
  Reinhardt: 'reinhardt.webp',
  Roadhog: 'roadhog.webp',
  Shion: 'shion.webp',
  Sigma: 'sigma.webp',
  Sierra: 'sierra.webp',
  Sojourn: 'sojourn.webp',
  'Soldier: 76': 'soldier-76.webp',
  Sombra: 'sombra.webp',
  Symmetra: 'symmetra.webp',
  'Torbjörn': 'torbjorn.webp',
  Tracer: 'tracer.webp',
  Venture: 'venture.webp',
  Vendetta: 'vendetta.webp',
  Widowmaker: 'widowmaker.webp',
  Winston: 'winston.webp',
  'Wrecking Ball': 'wrecking-ball.webp',
  Wuyang: 'wuyang.webp',
  Zarya: 'zarya.webp',
  Zenyatta: 'zenyatta.webp'
};

const OVERWATCH_MAPS = [
  'Aatlis',
  'Antarctic Peninsula',
  'Arena Victoriae',
  'Ayutthaya',
  'Black Forest',
  'Blizzard World',
  'Busan',
  'Busan Stadium',
  'Castillo',
  'Château Guillard',
  'Circuit Royal',
  'Colosseo',
  'Dorado',
  'Ecopoint: Antarctica',
  'Eichenwalde',
  'Esperança',
  'Estádio das Rãs',
  'Gogadoro',
  'Gothenburg',
  'Hanamura',
  'Hanaoka',
  'Havana',
  'Hollywood',
  'Horizon Lunar Colony',
  'Ilios',
  'Junkertown',
  'Kanezaka',
  'King\'s Row',
  'Lijiang Tower',
  'Malevento',
  'Midtown',
  'Necropolis',
  'Neon Junction',
  'Nepal',
  'New Junk City',
  'New Queen Street',
  'Numbani',
  'Oasis',
  'Paraíso',
  'Paris',
  'Petra',
  'Place Lacroix',
  'Powder Keg Mine',
  'Practice Range',
  'Redwood Dam',
  'Rialto',
  'Route 66',
  'Runasapi',
  'Samoa',
  'Serenza',
  'Shambali Monastery',
  'Suravasa',
  'Sydney Harbour Arena',
  'Talantis',
  'Temple of Anubis',
  'Thames District',
  'Throne of Anubis',
  'Toronto',
  'Volskaya Industries',
  'Watchpoint: Gibraltar',
  'Workshop Chamber',
  'Workshop Expanse',
  'Workshop Green Screen',
  'Workshop Island',
  'Wuxing University - Water College'
];

const OVERWATCH_MAP_ART = {
  'Aatlis': { url: '/assets/overwatch/maps/aatlis.webp', name: 'aatlis.webp' },
  'Antarctic Peninsula': { url: '/assets/overwatch/maps/antarctic-peninsula.webp', name: 'antarctic-peninsula.webp' },
  'Arena Victoriae': { url: '/assets/overwatch/maps/arena-victoriae.webp', name: 'arena-victoriae.webp' },
  'Ayutthaya': { url: '/assets/overwatch/maps/ayutthaya.webp', name: 'ayutthaya.webp' },
  'Black Forest': { url: '/assets/overwatch/maps/black-forest.webp', name: 'black-forest.webp' },
  'Blizzard World': { url: '/assets/overwatch/maps/blizzard-world.webp', name: 'blizzard-world.webp' },
  'Busan': { url: '/assets/overwatch/maps/busan.webp', name: 'busan.webp' },
  'Busan Stadium': { url: '/assets/overwatch/maps/busan-stadium.webp', name: 'busan-stadium.webp' },
  'Castillo': { url: '/assets/overwatch/maps/castillo.webp', name: 'castillo.webp' },
  'Château Guillard': { url: '/assets/overwatch/maps/chateau-guillard.webp', name: 'chateau-guillard.webp' },
  'Circuit Royal': { url: '/assets/overwatch/maps/circuit-royal.webp', name: 'circuit-royal.webp' },
  'Colosseo': { url: '/assets/overwatch/maps/colosseo.webp', name: 'colosseo.webp' },
  'Dorado': { url: '/assets/overwatch/maps/dorado.webp', name: 'dorado.webp' },
  'Ecopoint: Antarctica': { url: '/assets/overwatch/maps/ecopoint-antarctica.webp', name: 'ecopoint-antarctica.webp' },
  'Eichenwalde': { url: '/assets/overwatch/maps/eichenwalde.webp', name: 'eichenwalde.webp' },
  'Esperança': { url: '/assets/overwatch/maps/esperanca.webp', name: 'esperanca.webp' },
  'Estádio das Rãs': { url: '/assets/overwatch/maps/estadio-das-ras.webp', name: 'estadio-das-ras.webp' },
  'Gogadoro': { url: '/assets/overwatch/maps/gogadoro.webp', name: 'gogadoro.webp' },
  'Gothenburg': { url: '/assets/overwatch/maps/gothenburg.webp', name: 'gothenburg.webp' },
  'Hanamura': { url: '/assets/overwatch/maps/hanamura.webp', name: 'hanamura.webp' },
  'Hanaoka': { url: '/assets/overwatch/maps/hanaoka.webp', name: 'hanaoka.webp' },
  'Havana': { url: '/assets/overwatch/maps/havana.webp', name: 'havana.webp' },
  'Hollywood': { url: '/assets/overwatch/maps/hollywood.webp', name: 'hollywood.webp' },
  'Horizon Lunar Colony': { url: '/assets/overwatch/maps/horizon-lunar-colony.webp', name: 'horizon-lunar-colony.webp' },
  'Ilios': { url: '/assets/overwatch/maps/ilios.webp', name: 'ilios.webp' },
  'Junkertown': { url: '/assets/overwatch/maps/junkertown.webp', name: 'junkertown.webp' },
  'Kanezaka': { url: '/assets/overwatch/maps/kanezaka.webp', name: 'kanezaka.webp' },
  'King\'s Row': { url: '/assets/overwatch/maps/king-s-row.webp', name: 'king-s-row.webp' },
  'Lijiang Tower': { url: '/assets/overwatch/maps/lijiang-tower.webp', name: 'lijiang-tower.webp' },
  'Malevento': { url: '/assets/overwatch/maps/malevento.webp', name: 'malevento.webp' },
  'Midtown': { url: '/assets/overwatch/maps/midtown.webp', name: 'midtown.webp' },
  'Necropolis': { url: '/assets/overwatch/maps/necropolis.webp', name: 'necropolis.webp' },
  'Neon Junction': { url: '/assets/overwatch/maps/neon-junction.webp', name: 'neon-junction.webp' },
  'Nepal': { url: '/assets/overwatch/maps/nepal.webp', name: 'nepal.webp' },
  'New Junk City': { url: '/assets/overwatch/maps/new-junk-city.webp', name: 'new-junk-city.webp' },
  'New Queen Street': { url: '/assets/overwatch/maps/new-queen-street.webp', name: 'new-queen-street.webp' },
  'Numbani': { url: '/assets/overwatch/maps/numbani.webp', name: 'numbani.webp' },
  'Oasis': { url: '/assets/overwatch/maps/oasis.webp', name: 'oasis.webp' },
  'Paraíso': { url: '/assets/overwatch/maps/paraiso.webp', name: 'paraiso.webp' },
  'Paris': { url: '/assets/overwatch/maps/paris.webp', name: 'paris.webp' },
  'Petra': { url: '/assets/overwatch/maps/petra.webp', name: 'petra.webp' },
  'Place Lacroix': { url: '/assets/overwatch/maps/place-lacroix.webp', name: 'place-lacroix.webp' },
  'Powder Keg Mine': { url: '/assets/overwatch/maps/powder-keg-mine.webp', name: 'powder-keg-mine.webp' },
  'Practice Range': { url: '/assets/overwatch/maps/practice-range.webp', name: 'practice-range.webp' },
  'Redwood Dam': { url: '/assets/overwatch/maps/redwood-dam.webp', name: 'redwood-dam.webp' },
  'Rialto': { url: '/assets/overwatch/maps/rialto.webp', name: 'rialto.webp' },
  'Route 66': { url: '/assets/overwatch/maps/route-66.webp', name: 'route-66.webp' },
  'Runasapi': { url: '/assets/overwatch/maps/runasapi.webp', name: 'runasapi.webp' },
  'Samoa': { url: '/assets/overwatch/maps/samoa.webp', name: 'samoa.webp' },
  'Serenza': { url: '/assets/overwatch/maps/serenza.webp', name: 'serenza.webp' },
  'Shambali Monastery': { url: '/assets/overwatch/maps/shambali-monastery.webp', name: 'shambali-monastery.webp' },
  'Suravasa': { url: '/assets/overwatch/maps/suravasa.webp', name: 'suravasa.webp' },
  'Sydney Harbour Arena': { url: '/assets/overwatch/maps/sydney-harbour-arena.webp', name: 'sydney-harbour-arena.webp' },
  'Talantis': { url: '/assets/overwatch/maps/talantis.webp', name: 'talantis.webp' },
  'Temple of Anubis': { url: '/assets/overwatch/maps/temple-of-anubis.webp', name: 'temple-of-anubis.webp' },
  'Thames District': { url: '/assets/overwatch/maps/thames-district.webp', name: 'thames-district.webp' },
  'Throne of Anubis': { url: '/assets/overwatch/maps/throne-of-anubis.webp', name: 'throne-of-anubis.webp' },
  'Toronto': { url: '/assets/overwatch/maps/toronto.webp', name: 'toronto.webp' },
  'Volskaya Industries': { url: '/assets/overwatch/maps/volskaya-industries.webp', name: 'volskaya-industries.webp' },
  'Watchpoint: Gibraltar': { url: '/assets/overwatch/maps/watchpoint-gibraltar.webp', name: 'watchpoint-gibraltar.webp' },
  'Workshop Chamber': { url: '/assets/overwatch/maps/workshop-chamber.webp', name: 'workshop-chamber.webp' },
  'Workshop Expanse': { url: '/assets/overwatch/maps/workshop-expanse.webp', name: 'workshop-expanse.webp' },
  'Workshop Green Screen': { url: '/assets/overwatch/maps/workshop-green-screen.webp', name: 'workshop-green-screen.webp' },
  'Workshop Island': { url: '/assets/overwatch/maps/workshop-island.webp', name: 'workshop-island.webp' },
  'Wuxing University - Water College': { url: '/assets/overwatch/maps/wuxing-university-water-college.webp', name: 'wuxing-university-water-college.webp' }
};

function createOverwatchMapArt() {
  return { ...OVERWATCH_MAP_ART };
}

function createOverwatchCharacterArt() {
  return Object.fromEntries(Object.entries(OVERWATCH_HERO_ART).map(([hero, filename]) => [
    hero,
    { url: `/assets/overwatch/heroes/${filename}`, name: filename }
  ]));
}

export const GAME_CONFIGS = {
  overwatch: {
    name: 'Overwatch 2', shortName: 'OW2', accent: '#f06414', maxScore: 3,
    scoreLabel: 'Map score', rosterSize: 5,
    characterLabel: 'Hero',
    modes: ['Control', 'Hybrid', 'Flashpoint', 'Escort', 'Push'],
    maps: OVERWATCH_MAPS,
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
    name: 'VALORANT', shortName: 'VAL', accent: '#ff4655', maxScore: 4,
    scoreLabel: 'Series score', rosterSize: 5,
    characterLabel: 'Agent',
    formatOptions: [1, 3, 5, 7],
    defaultSeriesLength: 3,
    modes: ['Pick 1', 'Pick 2', 'Pick 3'],
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
    formatOptions: [1, 3, 5, 7],
    defaultSeriesLength: 7,
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
    name: 'Smash Bros. Ultimate', shortName: 'SSBU', accent: '#e03b32', maxScore: 2,
    scoreLabel: 'Set score', rosterSize: 1,
    characterLabel: 'Fighter',
    formatOptions: [1, 3],
    defaultSeriesLength: 3,
    modes: ['Game 1', 'Game 2', 'Game 3'],
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
      { name: 'IDAHO STATE', shortName: 'ISU', color: '#f47920', secondaryColor: '#101012', secondaryColorEnabled: true, score: 0, detailScore: gameKey === 'smash' ? 12 : 0 },
      { name: 'OPPONENT', shortName: 'OPP', color: '#5e6673', secondaryColor: '#d9dce2', secondaryColorEnabled: false, score: 0, detailScore: gameKey === 'smash' ? 12 : 0 }
    ],
    seriesLength: config.defaultSeriesLength || config.modes.length,
    match: { event: 'COLLEGIATE ESPORTS', round: 'REGULAR SEASON', format: config.defaultSeriesLength ? `Best of ${config.defaultSeriesLength}` : config.format, live: false },
    activeMap: 0,
    mapRows: config.modes.map((mode, index) => ({
      mode: gameKey === 'overwatch' ? '' : mode,
      map: gameKey === 'overwatch' ? '' : gameKey === 'valorant' ? ['Ascent', 'Bind', 'Haven'][index] || '' : config.maps[index % config.maps.length],
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
    characterArt: gameKey === 'overwatch' ? createOverwatchCharacterArt() : {},
    mapArt: gameKey === 'overwatch' ? createOverwatchMapArt() : {},
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
