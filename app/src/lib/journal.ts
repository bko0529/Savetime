/** 서버 구급활동일지 초안(SFR-164)으로 이 폰의 빈 환자 정보 칸을 채운다 */
import type { JournalDraft } from "./engine";
import type { Patient } from "./transport-store";

const AVPU_NAME: Record<string, string> = { A: "명료", V: "말에 반응", P: "통증에 반응", U: "무반응" };
const str = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

/** 이 폰에 비어 있는 칸만 서버 초안으로 채운다. 대원이 이 폰에서 입력한 값은 그대로 둔다 */
export function mergePatient(p: Patient, d: JournalDraft): Patient {
  const keep = (mine: string, server: string) => (mine.trim() ? mine : server);
  const bp = d.vitals.sbp && d.vitals.dbp ? `${d.vitals.sbp}/${d.vitals.dbp}` : "";
  return {
    ...p,
    complaint: keep(p.complaint, d.chiefComplaint ?? ""),
    sex: keep(p.sex, d.sex === "M" ? "남" : d.sex === "F" ? "여" : ""),
    age: keep(p.age, d.ageBand ?? ""),
    consciousness: keep(p.consciousness, d.consciousness ? AVPU_NAME[d.consciousness] ?? "" : ""),
    bp: keep(p.bp, bp),
    pulse: keep(p.pulse, str(d.vitals.pulse)),
    resp: keep(p.resp, str(d.vitals.resp)),
    spo2: keep(p.spo2, str(d.vitals.spo2)),
    temp: keep(p.temp, str(d.vitals.temp)),
    glucose: keep(p.glucose, str(d.vitals.glucose)),
    onset: keep(p.onset, d.onsetAt ?? ""),
    history: keep(p.history, d.history ?? ""),
    ktas: keep(p.ktas, str(d.ktas)),
  };
}


// ---------------- AI 일지 정리 (SFR-167) ----------------

/** 서버가 돌려주는 AI 제안. 항목이 없으면 null */
export type AiSuggestions = {
  chiefComplaint: string | null;
  history: string | null;
  treatment: string | null;
  medicalDirection: string | null;
  other: string | null;
};

/** 일지에서 AI 제안을 넣을 칸 */
export type AiTarget = { complaint: string; historyEtc: string; opinion: string };

/**
 * '적용'을 눌렀을 때만 제안을 일지 칸에 넣는다 (서버 명세: 앱은 제안만 보여 주고 적용은 대원이 고른다).
 * - 주 호소·기타 병력: 제안이 있으면 그 값으로
 * - 평가소견: 원래 소견 뒤에 처치·의료지도·그 밖의 내용을 붙인다 (대원이 쓴 소견은 지우지 않는다)
 */
export function applyAiSuggestions<T extends AiTarget>(f: T, s: AiSuggestions): T {
  const extra = [
    s.treatment && `처치: ${s.treatment}`,
    s.medicalDirection && `의료지도: ${s.medicalDirection}`,
    s.other,
  ].filter(Boolean);
  return {
    ...f,
    complaint: s.chiefComplaint?.trim() || f.complaint,
    historyEtc: s.history?.trim() || f.historyEtc,
    opinion: [f.opinion, ...extra].filter(Boolean).join(" · "),
  };
}
