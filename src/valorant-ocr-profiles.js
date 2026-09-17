import profiles from '../electron/valorant-ocr-profiles.json';

export const DEFAULT_VALORANT_OCR_PROFILE_ID = '1920x1080-en-5v5';
export const VALORANT_OCR_FIELD_IDS = Object.freeze(['homeScore', 'timer', 'awayScore']);
export const VALORANT_OCR_PROFILES = Object.freeze(profiles);
export const VALORANT_OCR_PROFILE_CHOICES = Object.freeze(Object.entries(VALORANT_OCR_PROFILES).map(([id, profile]) => ({ id, label: profile.label })));

export function getValorantOcrProfile(profileId = DEFAULT_VALORANT_OCR_PROFILE_ID) {
  return VALORANT_OCR_PROFILES[profileId] || VALORANT_OCR_PROFILES[DEFAULT_VALORANT_OCR_PROFILE_ID];
}

export function valorantOcrProfileChoices() {
  return VALORANT_OCR_PROFILE_CHOICES.map((profile) => ({ ...profile }));
}
