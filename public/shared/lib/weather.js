// Open-Meteo WMO weather codes, in words, plus the one derived number the rink
// actually cares about.
//
// Carried from round one, which held this table inline in the heatmap closure.
// It is a lookup and a subtraction — exactly the kind of thing that belongs in
// a tested module rather than in a template string.

const WMO = {
  0: "clear",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

/** @returns {string|null} null for an unknown or missing code — never "unknown". */
export function conditions(code) {
  if (code == null) return null;
  return WMO[Number(code)] ?? null;
}

/**
 * How hard the building worked that day: mean outdoor air minus the ice
 * surface. Positive means the air was warmer than the ice, which is the normal
 * direction and the load the plant has to pull against.
 *
 * @returns {number|null} °F, or null when either side is missing
 */
export function thermalLoad(airMeanF, iceTempF) {
  if (airMeanF == null || iceTempF == null) return null;
  if (!Number.isFinite(airMeanF) || !Number.isFinite(iceTempF)) return null;
  return Math.round((airMeanF - iceTempF) * 10) / 10;
}

/**
 * A one-line summary of a weather row, skipping whatever is missing rather than
 * printing "—" six times. Returns null when the row says nothing at all, so the
 * caller can omit the block entirely instead of rendering an empty heading.
 */
export function summarise(w) {
  if (!w) return null;
  const bits = [];
  if (w.temp_low_f != null && w.temp_high_f != null) {
    bits.push(`${Math.round(w.temp_low_f)}–${Math.round(w.temp_high_f)}°F`);
  } else if (w.temp_mean_f != null) {
    bits.push(`${Math.round(w.temp_mean_f)}°F`);
  }
  const cond = conditions(w.weather_code);
  if (cond) bits.push(cond);
  if (w.precip_in) bits.push(`${w.precip_in.toFixed(2)}" rain`);
  if (w.snow_in) bits.push(`${w.snow_in.toFixed(1)}" snow`);
  if (w.wind_mph_max != null) bits.push(`wind ${Math.round(w.wind_mph_max)} mph`);
  return bits.length ? bits.join(" · ") : null;
}
