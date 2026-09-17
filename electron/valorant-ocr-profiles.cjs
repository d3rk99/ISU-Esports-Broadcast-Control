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

function getValorantOcrProfile(profileId = DEFAULT_PROFILE_ID, overrides = {}) {
  const id = profiles[profileId] ? profileId : DEFAULT_PROFILE_ID;
  const source = profiles[id];
  const profile = JSON.parse(JSON.stringify(source));
  profile.id = id;
  for (const fieldId of FIELD_IDS) {
    profile.fields[fieldId].roi = normalizedRoi(overrides[fieldId], source.fields[fieldId].roi, source.frame);
  }
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
  normalizedRoi
};
