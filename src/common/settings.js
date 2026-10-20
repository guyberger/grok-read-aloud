import { ext } from "./browser.js";

export const DEFAULT_SETTINGS = {
  apiKey: "",
  voiceId: "eve",
  language: "en",
  // Playback rate applied to the audio element. Timestamps stay valid because
  // they are expressed in media time, which `currentTime` already reports.
  rate: 1,
  chunkChars: 1200,
  // Clicking a word in the text being read moves playback to it.
  clickToJump: true,
  autoScroll: true,
  highlightColor: "#ffd34d",
  sentenceTint: true,
};

/** Voice list shipped as a fallback; the live list is fetched from the API. */
export const FALLBACK_VOICES = [
  { voice_id: "eve", name: "Eve" },
  { voice_id: "ara", name: "Ara" },
  { voice_id: "rex", name: "Rex" },
  { voice_id: "carina", name: "Carina" },
  { voice_id: "orion", name: "Orion" },
  { voice_id: "luna", name: "Luna" },
  { voice_id: "iris", name: "Iris" },
  { voice_id: "altair", name: "Altair" },
  { voice_id: "zenith", name: "Zenith" },
  { voice_id: "perseus", name: "Perseus" },
  { voice_id: "helios", name: "Helios" },
  { voice_id: "celeste", name: "Celeste" },
  { voice_id: "sirius", name: "Sirius" },
];

export const LANGUAGES = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "ar-EG", label: "Arabic (Egypt)" },
  { code: "ar-SA", label: "Arabic (Saudi Arabia)" },
  { code: "ar-AE", label: "Arabic (UAE)" },
  { code: "bn", label: "Bengali" },
  { code: "zh", label: "Chinese (Simplified)" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "hi", label: "Hindi" },
  { code: "id", label: "Indonesian" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "pt-BR", label: "Portuguese (Brazil)" },
  { code: "pt-PT", label: "Portuguese (Portugal)" },
  { code: "ru", label: "Russian" },
  { code: "es-MX", label: "Spanish (Mexico)" },
  { code: "es-ES", label: "Spanish (Spain)" },
  { code: "tr", label: "Turkish" },
  { code: "vi", label: "Vietnamese" },
];

export async function getSettings() {
  const stored = await ext.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(patch) {
  await ext.storage.local.set(patch);
}

/** Everything except the key, for contexts that must never see it. */
export async function getPublicSettings() {
  const { apiKey, ...rest } = await getSettings();
  return { ...rest, hasApiKey: Boolean(apiKey) };
}
