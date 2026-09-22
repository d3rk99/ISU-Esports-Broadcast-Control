const profiles = require('./valorant-ocr-profiles.json');

const DEFAULT_PROFILE_ID = '1920x1080-en-5v5';
const FIELD_IDS = Object.freeze(['homeScore', 'timer', 'awayScore']);

function finiteInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizedRoi(roi = {}, fallback, frame) {
  const x = finiteInteger(roi.x, fallback.x, 0, frame.width - 1);
  const y = finiteInteger(roi.y, fallback.y, 0, frame.height - 1);
  const w = finiteInteger(roi.w, fallback.w, 1, frame.width - x);
  const h = finiteInteger(roi.h, fallback.h, 1, frame.height - y);
  return { x, y, w, h };
}

function normalizeScoreboardTableOverrides(table, overrides = {}, frame) {
  if (!table || !overrides || typeof overrides !== 'object') return table;
  const next = JSON.parse(JSON.stringify(table));
  if (overrides.teams && typeof overrides.teams === 'object') {
    next.teams = next.teams.map((team) => {
      const override = overrides.teams[team.id] || {};
      return {
        ...team,
        origin: {
          x: finiteInteger(override.origin?.x, team.origin.x, 0, frame.width - 1),
          y: finiteInteger(override.origin?.y, team.origin.y, 0, frame.height - 1)
        },
        rowHeight: finiteInteger(override.rowHeight, team.rowHeight, 12, frame.height)
      };
    });
  }
  if (overrides.columns && typeof overrides.columns === 'object') {
    next.columns = Object.fromEntries(Object.entries(next.columns).map(([columnId, column]) => {
      const override = overrides.columns[columnId] || {};
      return [columnId, {
        ...column,
        x: finiteInteger(override.x, column.x, 0, frame.width - 1),
        w: finiteInteger(override.w, column.w, 1, frame.width)
      }];
    }));
  }
  if (overrides.cells && typeof overrides.cells === 'object') {
    next.cells = JSON.parse(JSON.stringify(overrides.cells));
  }
  if (overrides.roundTimeline && typeof overrides.roundTimeline === 'object') {
    next.roundTimeline = { ...(next.roundTimeline || {}) };
    const sourceTimeline = table.roundTimeline || {};
    const timeline = overrides.roundTimeline;
    if (timeline.defenseLabel) {
      next.roundTimeline.defenseLabel = normalizedRoi(timeline.defenseLabel, sourceTimeline.defenseLabel || timeline.defenseLabel, frame);
    }
    if (timeline.attackLabel) {
      next.roundTimeline.attackLabel = normalizedRoi(timeline.attackLabel, sourceTimeline.attackLabel || timeline.attackLabel, frame);
    }
    if (timeline.rounds && typeof timeline.rounds === 'object') {
      next.roundTimeline.rounds = { ...(next.roundTimeline.rounds || {}) };
      for (const [round, roi] of Object.entries(timeline.rounds)) {
        const fallback = sourceTimeline.rounds?.[round] || next.roundTimeline.rounds[round] || roi;
        next.roundTimeline.rounds[round] = normalizedRoi(roi, fallback, frame);
      }
    }
  }
  return next;
}

function getValorantOcrProfile(profileId = DEFAULT_PROFILE_ID, overrides = {}) {
  const id = profiles[profileId] ? profileId : DEFAULT_PROFILE_ID;
  const source = profiles[id];
  const profile = JSON.parse(JSON.stringify(source));
  profile.id = id;
  for (const fieldId of FIELD_IDS) {
    profile.fields[fieldId].roi = normalizedRoi(overrides[fieldId], source.fields[fieldId].roi, source.frame);
  }
  profile.scoreboardTable = normalizeScoreboardTableOverrides(source.scoreboardTable, overrides.scoreboardTable, source.frame);
  return profile;
}

function listValorantOcrProfiles() {
  return Object.entries(profiles).map(([id, profile]) => ({ id, label: profile.label, frame: { ...profile.frame } }));
}

module.exports = {
  DEFAULT_PROFILE_ID,
  FIELD_IDS,
  getValorantOcrProfile,
  listValorantOcrProfiles,
  normalizeScoreboardTableOverrides,
  normalizedRoi
};
