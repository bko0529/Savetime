/**
 * 팀 작성 중 환자 정보 (SFR-114). 같은 팀 대원들이 환자 정보 화면을 같이 채운다.
 * - 내가 칸을 고치면 잠깐 기다렸다가(타자 치는 중에는 안 보냄) 바뀐 칸만 PATCH /teams/current/draft
 * - 다른 팀원이 고치면 서버가 draft.updated 로 "어느 칸이 바뀌었는지"만 알려 준다(값은 이벤트에 없음, 규칙 5).
 *   그 칸 값만 GET 으로 받아 내 화면에 넣는다
 * - 이 폰에만 있는 칸(병원 등급)은 보내지 않는다. 환자 이름 같은 칸은 애초에 없다 (SER-012)
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { onEvent, type Envelope } from "./realtime";
import { currentAccount, getAuth } from "./auth-store";
import { toAssessment } from "./engine";
import { UNKNOWN, type Patient } from "./transport-store";

/** 서버 Assessment 의 칸 (값은 서버 형식) */
export type DraftAssessment = Partial<Record<AssessmentKey, unknown>> & { unknownFields?: string[] };

type PatientKey = Exclude<keyof Patient, "grade">;
type AssessmentKey =
  | "chiefComplaint" | "sex" | "ageBand" | "consciousness" | "bp" | "pulse" | "resp" | "spo2"
  | "painSite" | "painScore" | "onset" | "trauma" | "history" | "temp" | "glucose" | "ktas";

/** 앱 칸 → 서버 칸 */
const TO_SERVER: Record<PatientKey, AssessmentKey> = {
  complaint: "chiefComplaint", sex: "sex", age: "ageBand", consciousness: "consciousness", bp: "bp",
  pulse: "pulse", resp: "resp", spo2: "spo2", painSite: "painSite", painScore: "painScore", onset: "onset",
  trauma: "trauma", history: "history", temp: "temp", glucose: "glucose", ktas: "ktas",
};
const TO_APP = Object.fromEntries(Object.entries(TO_SERVER).map(([a, s]) => [s, a])) as Record<AssessmentKey, PatientKey>;
const PATIENT_KEYS = Object.keys(TO_SERVER) as PatientKey[];

const CONSC_APP: Record<string, string> = { alert: "명료", verbal: "말에 반응", pain: "통증에 반응", unresponsive: "무반응", unknown: UNKNOWN };

/** 서버 값 하나 → 앱 칸 글자 */
function toAppValue(key: AssessmentKey, v: unknown, unknownFields: string[]): string {
  if (unknownFields.includes(key)) return UNKNOWN;
  if (v === null || v === undefined) return "";
  switch (key) {
    case "sex":
      return v === "M" ? "남" : v === "F" ? "여" : v === "U" ? UNKNOWN : "";
    case "consciousness":
      return CONSC_APP[String(v)] ?? "";
    case "trauma":
      return v === "no" ? "없음" : v === "yes" ? "있음" : v === "unknown" ? UNKNOWN : "";
    default:
      return String(v);
  }
}

/**
 * 내 칸 값이 바뀐 것만 서버 형식으로. 바뀐 게 없으면 null.
 * 빈칸으로 지웠으면 null(서버에서 그 칸 지우기). '확인 불가'로 바꾸면 unknownFields 도 같이 보낸다
 */
export function draftChanges(prev: Patient, next: Patient): DraftAssessment | null {
  const full = toAssessment(next) as Record<string, unknown> & { unknownFields: string[] };
  const out: DraftAssessment = {};
  let unknownChanged = false;
  for (const k of PATIENT_KEYS) {
    if (prev[k] === next[k]) continue;
    const s = TO_SERVER[k];
    out[s] = next[k].trim() === "" ? null : full[s] ?? null;
    if (prev[k] === UNKNOWN || next[k] === UNKNOWN) unknownChanged = true;
  }
  if (Object.keys(out).length === 0) return null;
  if (unknownChanged) out.unknownFields = full.unknownFields;
  return out;
}

/** 서버 작성 중 정보 → 앱 칸 (서버에 없는 칸은 빈칸) */
export function draftAsPatient(a: DraftAssessment, base: Patient): Patient {
  const unknown = a.unknownFields ?? [];
  const out = { ...base };
  for (const k of PATIENT_KEYS) out[k] = toAppValue(TO_SERVER[k], a[TO_SERVER[k]], unknown);
  return out;
}

/**
 * 서버 값을 내 화면에 넣는다.
 * - fields 를 주면(팀원이 고친 칸) 그 칸만 서버 값으로 바꾼다
 * - fields 가 없으면(화면을 처음 열 때) 내 빈칸만 서버 값으로 채운다. 내가 이미 쓴 값은 그대로
 */
export function applyDraft(p: Patient, a: DraftAssessment, fields?: string[]): Patient {
  const server = draftAsPatient(a, p);
  const out = { ...p };
  if (fields) {
    for (const f of fields) {
      const k = TO_APP[f as AssessmentKey];
      if (k) out[k] = server[k];
    }
    // '확인 불가' 표시만 바뀐 경우 (unknownFields 칸)
    if (fields.includes("unknownFields")) {
      for (const k of PATIENT_KEYS) if (server[k] === UNKNOWN || out[k] === UNKNOWN) out[k] = server[k];
    }
    return out;
  }
  for (const k of PATIENT_KEYS) if (!out[k].trim()) out[k] = server[k];
  return out;
}

type DraftResponse = { version: number; assessment: DraftAssessment | null };
type DraftUpdated = { version: number; fields: string[]; byName: string | null };

const SEND_DELAY_MS = 700;

/**
 * 환자 정보 화면에서 팀 작성 중 정보와 맞춘다. 팀이 없으면 아무것도 안 한다.
 * 돌려주는 값: 다른 팀원이 방금 고친 칸 안내 문구(잠깐 보여 줌), 저장 오류 코드
 */
export function useTeamDraftSync(
  patient: Patient,
  setPatient: (p: Patient) => void,
  opts: { extraBody?: () => Record<string, unknown>; onError?: (e: ApiError) => void } = {},
) {
  const inTeam = !!getAuth().duty;
  const latest = useRef(patient);
  latest.current = patient;
  // 서버에 있다고 알고 있는 값. 이것과 지금 화면을 비교해 바뀐 칸만 보낸다
  const synced = useRef<Patient | null>(null);
  const version = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);
  // 처음 받아 오기가 끝났는지. 끝나야 '내 화면에만 있는 값'을 보낼 수 있다
  const [loaded, setLoaded] = useState(false);
  const opt = useRef(opts);
  opt.current = opts;

  // 화면을 열면 팀원이 이미 쓴 값을 받아 내 빈칸을 채운다
  useEffect(() => {
    if (!inTeam) return;
    let alive = true;
    void api<DraftResponse>("GET", "/teams/current/draft")
      .then((d) => {
        if (!alive) return;
        const a = d.assessment ?? {};
        version.current = d.version;
        synced.current = draftAsPatient(a, latest.current);
        const merged = applyDraft(latest.current, a);
        if (PATIENT_KEYS.some((k) => merged[k] !== latest.current[k])) setPatient(merged);
        setLoaded(true);
      })
      .catch(() => {
        // 못 받아도 혼자 입력은 계속된다. 다음에 고칠 때 바뀐 칸만 보낸다
        synced.current = { ...latest.current };
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [inTeam]); // eslint-disable-line react-hooks/exhaustive-deps

  // 다른 팀원이 고치면 그 칸 값만 받아 넣는다
  useEffect(() => {
    if (!inTeam) return;
    const myName = currentAccount()?.name ?? null;
    return onEvent("draft.updated", (env: Envelope) => {
      const e = env.data as unknown as DraftUpdated;
      if (e.byName && e.byName === myName) return; // 내가 보낸 것
      void api<DraftResponse>("GET", "/teams/current/draft").then((d) => {
        const a = d.assessment ?? {};
        version.current = d.version;
        // 서버가 비웠으면(직전 환자 정보 지우기·10분 지남) 모든 칸을 서버 값(빈칸)으로
        const fields = e.version === 0 ? [...Object.keys(TO_APP), "unknownFields"] : e.fields;
        const next = applyDraft(latest.current, a, fields);
        if (synced.current) synced.current = applyDraft(synced.current, a, fields);
        setPatient(next);
        if (e.byName && e.fields.length) setNotice(`${e.byName} 대원이 환자 정보를 고쳤어요`);
      });
    });
  }, [inTeam]); // eslint-disable-line react-hooks/exhaustive-deps

  // 내가 고친 칸을 잠깐 기다렸다가 보낸다
  useEffect(() => {
    if (!inTeam || !loaded || !synced.current) return;
    const changes = draftChanges(synced.current, patient);
    if (!changes) return;
    const t = setTimeout(() => {
      const sending = latest.current;
      const now = synced.current ? draftChanges(synced.current, sending) : null;
      if (!now) return;
      void api<{ version: number }>("PATCH", "/teams/current/draft", {
        body: { baseVersion: version.current, changes: now, ...(opt.current.extraBody?.() ?? {}) },
      })
        .then((r) => {
          version.current = r.version;
          synced.current = { ...sending };
        })
        .catch((err) => {
          if (err instanceof ApiError) opt.current.onError?.(err);
        });
    }, SEND_DELAY_MS);
    return () => clearTimeout(t);
  }, [inTeam, loaded, patient]);

  // 안내 문구는 4초 뒤 사라진다
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  return { notice };
}
