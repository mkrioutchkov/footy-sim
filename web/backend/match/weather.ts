// §weather: a deterministic per-match condition (the engine reads spec.weather — "rain"/"wet" skids the
// ball on a wet pitch, "wind" drifts airborne balls; see engine main.cpp:177). A PURE function of the
// match seed, so a re-sim or replay of the same fixture gets the SAME weather; 'clear' is OMITTED from
// the spec → byte-identical with pre-weather/AI-vs-AI specs (and the golden, which loads a static
// weather-free fixture-1.json). Mostly clear, with some rain/wind for variety (the average goal effect
// is ≈0 — rain −0.56, wind +0.6 — so league balance holds while individual matches vary).
export type Weather = 'clear' | 'rain' | 'wind';
export function weatherForSeed(seed: number): Weather {
  let h = seed | 0;                                       // a well-mixing 32-bit integer hash of the seed
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  const b = ((h ^ (h >>> 16)) >>> 0) % 100;
  if (b < 18) return 'rain';                              // ~18%
  if (b < 30) return 'wind';                              // ~12%
  return 'clear';                                         // ~70%
}
