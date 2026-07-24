// Offline word prediction for the on-screen keyboard. A compact, frequency-
// ordered dictionary of common English words, embedded so prediction works
// fully offline and nothing ever leaves the device (spec §Privacy). Suggestions
// are prefix completions of the word currently being typed THROUGH our keyboard
// (we cannot — and should not — read other apps' text fields).

// Frequency-ordered (most common first). Order = rank; suggest() preserves it.
const WORDS = (
  "the of and to in is you that it he was for on are as with his they be at " +
  "one have this from or had by but not what all were when we there can an your " +
  "which their said if will each about how up out them then she many some so " +
  "these would other into has more her two like him see time could no make than " +
  "first been its who now people my made over did down only way find use may " +
  "water long little very after words called just where most know get through " +
  "back much before good new write our used me man too any day same right look " +
  "think also around another came come work three word must because does part " +
  "even place well such here take why things help put years different away " +
  "again off went old number great tell men say small every found still between " +
  "name should home big give air line set own under read last never us left end " +
  "along while might next sound below saw something thought both few those " +
  "always looked show large often together asked house world going want school " +
  "important until form food keep children feet land side without boy once " +
  "animals life enough took sometimes four head above kind began almost live " +
  "page got earth need far hand high year mother light parts country father " +
  "let night following picture being study second eyes soon times story boys " +
  "since white days ever paper hard near sentence better best across during " +
  "today others however sure means knew it's try told young miles sun ways " +
  "thing whole hear example heard several change answer room against top " +
  "turned learn point city play toward five using himself usually money seen " +
  "didn't car morning I'm body upon family later turn move face door cut done " +
  "group true half red fish plants living black eat short united run book gave " +
  "order open ground cold really table remember tree course front American " +
  "space inside ago sad early I'll learned brought close nothing though idea " +
  "before lived became add become grow draw yet less wind behind cannot letter " +
  "among able dog shown mean English rest perhaps certain six feel fire ready " +
  "green yes built special ran full town complete oh person hot anything hold " +
  "state list stood hundred ten fast felt kept notice can't strong voice " +
  "probably area horse matter stand box start that's class piece surface river " +
  "common stop am talk whether fine round dark past ball girl road blue " +
  "instead either held already warm gone finally summer understand moon " +
  "animal mind outside power problem longer winter deep heavy carefully " +
  "follow beautiful everyone leave everything game system bring watch shall " +
  "dry within floor ice ship themselves begin fact third quite carry " +
  "distance although sat possible heart real simple snow rain suddenly easy " +
  "leaves lay size wild weather miss pattern sky walked main someone center " +
  "field stay itself boat question wide least tiny hour happened foot care " +
  "low else gold build glass rock tall alone bottom check reading fall poor " +
  "map friend language job music buy window mark heat grew listen ask single " +
  "clear energy week explain lost spring travel wrote farm circle whose " +
  "received garden please strange caught fell team God certainly guess " +
  "period forest happy legs early reach vowel signal computer phone email " +
  "message thanks thank hello please tomorrow yesterday today morning evening " +
  "afternoon minute moment please meeting call text send love nice great okay " +
  "sorry maybe definitely absolutely probably actually really information " +
  "question answer number address street little different important interesting " +
  "beautiful wonderful amazing awesome perfect exactly available appointment " +
  "schedule doctor coffee lunch dinner breakfast weekend birthday family friends"
).split(/\s+/);

// Deduplicate while preserving first (highest-frequency) occurrence.
const SEEN = new Set<string>();
const DICT: string[] = [];
for (const w of WORDS) {
  const lw = w.toLowerCase();
  if (!SEEN.has(lw)) { SEEN.add(lw); DICT.push(lw); }
}

/** Top `n` completions for the (case-insensitive) prefix, frequency-ordered.
 * Excludes 1–2 letter results and the bare prefix itself unless it's a real
 * word that would just add the trailing space. */
export function suggest(prefix: string, n = 3): string[] {
  const p = prefix.toLowerCase();
  if (p.length < 1) return [];
  const out: string[] = [];
  for (const w of DICT) {
    if (!w.startsWith(p)) continue;
    if (w.length < 3 && w !== p) continue;
    out.push(w);
    if (out.length >= n) break;
  }
  return out;
}
