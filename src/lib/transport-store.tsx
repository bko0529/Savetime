import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Grade = "대학병원급" | "종합병원급" | "일반 병원" | null;

export type Patient = {
  grade: Grade;
  complaint: string;
  sex: string;
  age: string;
  consciousness: string;
  bp: string;
  pulse: string;
  resp: string;
  spo2: string;
  painSite: string;
  painScore: string;
  onset: string;
  trauma: string;
  history: string;
  temp: string;
  glucose: string;
  ktas: string;
};

/** 새 이송을 시작하면 모든 항목이 비어 있어요 (시연 예시 자동 입력 없음). */
export const emptyPatient: Patient = {
  grade: null,
  complaint: "",
  sex: "",
  age: "",
  consciousness: "",
  bp: "",
  pulse: "",
  resp: "",
  spo2: "",
  painSite: "",
  painScore: "",
  onset: "",
  trauma: "",
  history: "",
  temp: "",
  glucose: "",
  ktas: "",
};

/** 필수 12개 항목 (요구사항 CR-007) */
export const REQUIRED_FIELDS: (keyof Patient)[] = [
  "complaint", "sex", "age",
  "consciousness", "bp", "pulse", "resp", "spo2",
  "painSite", "painScore", "onset", "trauma",
];

export const UNKNOWN = "확인 불가";

export function filledCount(p: Patient) {
  return REQUIRED_FIELDS.filter((k) => String(p[k] ?? "").trim() !== "").length;
}

export type Timeline = {
  callAt?: Date;
  dispatchAt?: Date;
  sceneAt?: Date;
  contactAt?: Date;
  departAt?: Date;
  arriveAt?: Date;
};

export type ConfirmedHospital = { id: string; name: string; km: number; min: number; note?: string };

type Store = {
  patient: Patient;
  setPatient: (p: Patient) => void;
  timeline: Timeline;
  setTimeline: (t: Timeline) => void;
  confirmed: ConfirmedHospital | null;
  setConfirmed: (h: ConfirmedHospital | null) => void;
  rejectedNames: string[];
  setRejectedNames: (n: string[]) => void;
  reset: () => void;
  ready: boolean;
};



const Ctx = createContext<Store | null>(null);

const TKEY = "savetime-transport-v2";

export function TransportProvider({ children }: { children: ReactNode }) {
  const [patient, setPatient] = useState<Patient>(emptyPatient);
  const [timeline, setTimeline] = useState<Timeline>({});
  const [confirmed, setConfirmed] = useState<ConfirmedHospital | null>(null);
  const [rejectedNames, setRejectedNames] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  // 새로고침해도 이송 기록이 일지까지 이어지도록 기기에 임시 보관 (환자 식별정보는 애초에 없음)
  useEffect(() => {
    try {
      const d = JSON.parse(localStorage.getItem(TKEY) ?? "null");
      if (d) {
        const saved = d.patient as Partial<Patient> | undefined;
        const hasSavedPatient = !!saved && Object.values(saved).some((v) => String(v ?? "").trim() !== "");
        // 입력한 적이 없는 기기는 모든 항목이 빈 상태로 시작해요.
        setPatient(hasSavedPatient ? { ...emptyPatient, ...saved } : emptyPatient);
        setTimeline(d.timeline ?? {});
        setConfirmed(d.confirmed ?? null);
        setRejectedNames(d.rejectedNames ?? []);
      }
    } catch { /* ignore */ }
    setReady(true);
  }, []);
  useEffect(() => {
    if (ready) localStorage.setItem(TKEY, JSON.stringify({ patient, timeline, confirmed, rejectedNames }));
  }, [ready, patient, timeline, confirmed, rejectedNames]);
  const reset = () => {
    setPatient(emptyPatient);
    setTimeline({});
    setConfirmed(null);
    setRejectedNames([]);
  };
  return (
    <Ctx.Provider value={{ patient, setPatient, timeline, setTimeline, confirmed, setConfirmed, rejectedNames, setRejectedNames, reset, ready }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTransport() {
  const c = useContext(Ctx);
  if (!c) throw new Error("TransportProvider missing");
  return c;
}

export function fmtTime(d?: Date) {
  if (!d) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
