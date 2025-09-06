// src/utils/regions.ts

/** Códigos reales de plataforma (LoL) que vamos a soportar */
export type Platform =
  // AMERICAS
  | "la1" | "la2" | "na1" | "br1" | "oc1"
  // EUROPE
  | "euw1" | "eun1" | "tr1" | "ru"
  // ASIA
  | "jp1" | "kr"
  // SEA (opcional, por si luego los usas)
  | "ph2" | "sg2" | "th2" | "tw2" | "vn2";

/** Conjuntos útiles para probes */
export const PROBE_AMERICAS: Platform[] = ["la1","la2","na1","br1","oc1"];
export const PROBE_DEFAULT: Platform[] = [
  ...PROBE_AMERICAS,
  "euw1","eun1","tr1","ru","jp1","kr",
];

/** Regionales para Account-V1 */
export type Regional = "americas" | "europe" | "asia";

/** Mapear alias humanos → código de plataforma real */
export function normalizePlatform(p?: string): Platform | null {
  const x = (p || "").trim().toLowerCase();

  const map: Record<string, Platform> = {
    // AMERICAS
    lan: "la1", la1: "la1",
    las: "la2", la2: "la2",
    na: "na1",  na1: "na1",
    br: "br1",  br1: "br1",
    oce: "oc1", oc: "oc1", oc1: "oc1",

    // EUROPE
    euw: "euw1", euw1: "euw1",
    eune: "eun1", eun: "eun1", eun1: "eun1",
    tr: "tr1", tr1: "tr1",
    ru: "ru",

    // ASIA
    jp: "jp1", jp1: "jp1",
    kr: "kr",  korea: "kr",

    // SEA (opcionales)
    ph: "ph2", ph2: "ph2",
    sg: "sg2", sg2: "sg2",
    th: "th2", th2: "th2",
    tw: "tw2", tw2: "tw2",
    vn: "vn2", vn2: "vn2",
  };

  return map[x] ?? null;
}

/** Plataforma → host regional (para account-v1) */
export function platformToRegional(p?: string): Regional {
  const k = normalizePlatform(p || "") as Platform | null;
  if (!k) return "americas"; // por defecto
  if (["la1","la2","na1","br1","oc1"].includes(k)) return "americas";
  if (["euw1","eun1","tr1","ru"].includes(k))     return "europe";
  // jp1/kr/SEA
  return "asia";
}

/** Divide "Nombre#Tag" en [gameName, tagLine] */
export function splitRiotId(riotId: string): [string, string] {
  const [gn, tl] = String(riotId).split("#");
  return [gn?.trim() || "", tl?.trim() || ""];
}
