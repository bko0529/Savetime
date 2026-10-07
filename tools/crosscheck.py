# 상태 전이(stateMachine.ts) · DB(schema.sql) · 실시간(events.ts, 실시간통신설계.md) · API(openapi.yaml) 자동 대조
import re, yaml, sys
import os
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sm = open(f"{R}/server/src/domain/stateMachine.ts").read()
ev = open(f"{R}/shared/events.ts").read()
rtmd = open(f"{R}/docs/design-v0.2/3_실시간통신설계.md").read()
db = open(f"{R}/server/db/schema.sql").read()
api = yaml.safe_load(open(f"{R}/docs/design-v0.2/openapi.yaml"))
S = api["components"]["schemas"]
fails, oks = [], []
def check(name, cond, detail=""):
    (oks if cond else fails).append(f"{'OK ' if cond else 'FAIL'} {name}" + (f" — {detail}" if detail and not cond else ""))

def ts_union(src, name):
    m = re.search(rf"export type {name}\s*=\s*([^;]+);", src, re.S)
    return set(re.findall(r"'([a-z_A-Z]+)'", m.group(1))) if m else None
def db_enum(name):
    m = re.search(rf"CREATE TYPE {name}\s+AS ENUM \(([^)]*)\)", db)
    return set(re.findall(r"'(\w+)'", m.group(1)))
def db_check(col):
    m = re.search(rf"\b{col}\b[^\n]*CHECK \({col} IN \(([^)]*)\)", db)
    return set(re.findall(r"'(\w+)'", m.group(1))) if m else None
def api_enum(*path):
    o = S
    for p in path: o = o[p] if p in o else o["properties"][p]
    return set(o["enum"])

# 1. 상태 이름
for name, apiset in [("TransportStatus", api_enum("Transport", "status")), ("HreqStatus", api_enum("AppHospitalRequest", "status"))]:
    smv, evv = ts_union(sm, name), ts_union(ev, name)
    dbv = db_enum("transport_status" if name == "TransportStatus" else "hreq_status")
    check(f"{name}: 상태전이=DB=실시간=API", smv == dbv == evv == apiset, f"sm={smv} db={dbv} ev={evv} api={apiset}")
# 2. 사유 목록
smc, evc, dbc, apic = ts_union(sm, "CloseReason"), ts_union(ev, "CloseReason"), db_check("closed_reason"), api_enum("AppHospitalRequest", "closeReason")
check("CloseReason: 상태전이=DB=실시간=API", smc == evc == dbc == apic, f"{smc} {evc} {dbc} {apic}")
smf, evf, apif = ts_union(sm, "FallbackReason"), ts_union(ev, "FallbackReason"), api_enum("Transport", "fallbackReason")
check("FallbackReason: 상태전이=실시간=API", smf == evf == apif, f"{smf ^ evf} {smf ^ apif}")
smx, dbx = ts_union(sm, "CancelReason"), db_check("cancel_reason")
check("CancelReason: 상태전이=DB", smx == dbx, f"{smx ^ dbx}")
check("CancelReason: 실시간 = 상태전이", ts_union(ev, "CancelReason") == smx)
sma, dba = ts_union(sm, "ArrivalMethod"), db_check("arrival_method")
evarr = set(re.findall(r"'(\w+)'", re.search(r"'transport.arrived'.*?method: ([^;]+);", ev).group(1)))
check("ArrivalMethod: 상태전이=DB=실시간", sma == dba == evarr, f"{sma} {dba} {evarr}")
apiarr = set(api["paths"]["/transports/{transportId}/arrive"]["post"]["requestBody"]["content"]["application/json"]["schema"]["properties"]["method"]["enum"])
check("ArrivalMethod: API 대원 도착 ⊂ 상태전이 (finish_previous는 POST /transports)", apiarr <= sma, f"{apiarr}")
check("DestChangeReason: 상태전이=DB=API", ts_union(sm, "DestChangeReason") == db_check("dest_change_reason") ==
      set(api["paths"]["/transports/{transportId}/destination"]["post"]["requestBody"]["content"]["application/json"]["schema"]["properties"]["reason"]["enum"]))
phone_api = set(api["paths"]["/transports/{transportId}/phone-checks"]["post"]["requestBody"]["content"]["application/json"]["schema"]["properties"]["result"]["enum"])
phone_sm = set(re.findall(r"'(\w+)'", re.search(r"export function phoneEvent\(result: ([^,]+),", sm).group(1)))
check("전화 결과: 상태전이=DB=API", phone_sm == db_enum("phone_result") == phone_api, f"{phone_sm} {db_enum('phone_result')} {phone_api}")
check("전화 진행 사유: 상태전이=API", ts_union(sm, "PhoneProceedReason") ==
      set(api["paths"]["/transports/{transportId}/phone-checks"]["post"]["requestBody"]["content"]["application/json"]["schema"]["properties"]["reason"]["enum"]))
left_ev = set(re.findall(r"'(\w+)'", re.search(r"'team.member_left'.*?reason: ([^}]+)\}", ev).group(1)))
check("팀에서 빠진 이유: DB=실시간", db_check("left_reason") == left_ev, f"{db_check('left_reason')} {left_ev}")
check("가입 반려 사유: API ⊂ DB", set(api["paths"]["/admin/signups/{id}/reject"]["post"]["requestBody"]["content"]["application/json"]["schema"]["properties"]["reason"]["enum"]) <= db_check("reject_reason"))

# 3. 상태 전이 사건 ↔ API
tev, hev = ts_union(sm, "TransportEvent"), ts_union(sm, "HreqEvent")
used = {x for p in api["paths"].values() for op in p.values() for x in op.get("x-state-events", [])}
check("API x-state-events가 모두 상태 전이표에 있음", used <= (tev | hev), f"{used - (tev | hev)}")
user_ev = set(re.findall(r"T\([^,]+,\s*'(\w+)',\s*'\w+',\s*true", sm)) | set(re.findall(r"H\([^,]+,\s*'(\w+)',\s*'\w+',\s*true", sm))
check("사용자 행동 사건이 모두 API에 연결됨", user_ev <= used, f"API 없음: {user_ev - used}")
# 4. 오류 코드
smerr = ts_union(sm, "ErrorCode")
apierr = {c for p in api["paths"].values() for op in p.values() for c in op.get("x-error-codes", [])}
apimd = open(f"{R}/docs/design-v0.2/4_API명세.md").read()
check("상태 전이 오류 코드가 모두 API 오류 코드표에 있음", all(f"`{c}`" in apimd for c in smerr), f"{[c for c in smerr if f'`{c}`' not in apimd]}")
check("상태 전이 오류 코드가 실제 API 응답에 쓰임", smerr <= apierr, f"{smerr - apierr}")
check("API가 없는 'ALREADY_CONFIRMED'·428을 쓰지 않음", "ALREADY_CONFIRMED" not in apierr and "| 428 |" not in apimd)
# 5. Assessment 필드 ↔ DB 칸
dbass = re.search(r"CREATE TABLE assessment \((.*?)\n\);", db, re.S).group(1)
snake = lambda s: re.sub(r"([A-Z])", r"_\1", s).lower()
alias = {"symptom_code": "symptom_code", "age_band": "age_band", "unknown_fields": "unknown_fields"}
miss = [f for f in S["Assessment"]["properties"] if not re.search(rf"\b{snake(f)}\b", dbass)]
check("API Assessment 필드가 DB assessment 칸에 있음", not miss, f"DB 없음: {miss}")
for f, col in [("sex", "sex"), ("consciousness", "consciousness"), ("trauma", "trauma")]:
    check(f"Assessment.{f}: API=DB", set(S["Assessment"]["properties"][f]["enum"]) == db_check(col), f"{S['Assessment']['properties'][f]['enum']} {db_check(col)}")
tc = S["Assessment"]["properties"]["traumaCause"]["enum"]
check("Assessment.traumaCause: API=DB", set(tc) == db_check("trauma_cause"))
# 6. 실시간 이벤트 이름: events.ts ↔ 설계 md 표
ts_events = set(re.findall(r"^\s+'([a-z_]+\.[a-z_]+)'\s*:", ev, re.M))
md_events = set(re.findall(r"^\| `([a-z_]+\.[a-z_]+)`", rtmd, re.M)) | set(re.findall(r"^\| `team\.member_joined` / `(left)`", rtmd, re.M) and ["team.member_left", "team.role_changed"])
check("실시간: events.ts 이벤트가 모두 설계 문서 표에 있음", ts_events <= md_events, f"문서 없음: {ts_events - md_events}")
check("실시간: 설계 문서 표 이벤트가 모두 events.ts에 있음", md_events <= ts_events, f"코드 없음: {md_events - ts_events}")
# 7. 이벤트가 말하는 API가 존재
for ref in ["/teams/current/draft", "/transports/current", "/hw/requests", "/hw/incoming"]:
    check(f"실시간 문서가 부르는 API {ref} 존재", ref in api["paths"])
# 8. 환자 정보가 이벤트에 없음
pat = ["chiefComplaint", "assessment:", "bp", "spo2", "pulse", "ageBand", "symptomCode", "summary"]
leak = [p for p in pat if re.search(rf"\b{p}\b", re.sub(r"//.*", "", ev))]
check("실시간 이벤트 payload에 환자 정보 필드 없음 (SER-014)", not leak, f"{leak}")
# 9. 이벤트 enum ↔ DB
check("pc.revoked 사유에 key_expired 포함", "key_expired" in ev)
check("DB event_log에 entity_version 칸", "entity_version" in db)
check("DB team_member.joined_seq (다시 받기 필터)", "joined_seq" in db)
check("DB transport_status_history 테이블", "CREATE TABLE transport_status_history" in db)

print("\n".join(oks + fails))
print(f"\n통과 {len(oks)} / 실패 {len(fails)}")
sys.exit(1 if fails else 0)
