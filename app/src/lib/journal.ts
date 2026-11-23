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

