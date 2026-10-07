# 세이브타임 DB 설계 (ERD) 설명 v0.2

- DB: PostgreSQL 16 · 테이블 34개 · `schema.sql` 한 파일로 생성 (실제 PostgreSQL 16에서 생성·제약 동작 확인 완료)
- 기준: 요구사항분석서 v0.115 · 상태 전이표 v0.2
- 그림: Figma "06 DB 설계" 페이지

## 실행 방법

```bash
createdb savetime
psql -d savetime -f schema.sql
```

## 그룹별 테이블

| 그룹 | 테이블 | 한 줄 설명 | 관련 요구사항 |
|---|---|---|---|
| A 계정·인증 | agency | 소속기관(소방서) 코드, 초기 데이터 | SFR-017, COR-007 |
| | paramedic | 구급대원 계정 (상태: 승인 대기·승인·반려·정지·탈퇴) | SFR-017, 018, 022 |
| | signup_request | 공무원증 가입 신청. 승인·반려하면 사진 키를 바로 지움 | SFR-083, DAR-012 |
| | refresh_token | 서버가 폐기할 수 있는 로그인 토큰 | SER-016, SER-007 |
| | push_device | FCM 토큰 (iOS는 FCM → APNs) | SFR-130, COR-009 |
| B 팀 | team / team_member | 팀과 팀원. 운전은 팀에 1명, 대원은 동시에 팀 1개 | SFR-113, 159 |
| | team_invite | 목록 초대 (5분 만료) | SFR-159 |
| | paramedic_memo | 나만 보는 한 줄 메모 | SFR-143 |
| | team_draft | 팀이 같이 고치는 작성 중 환자 정보 (서버에 1개) | SFR-114 |
| C 병원 | hospital | 병원 기본 정보, 응급실 입구 좌표, 잠시 요청 중지 | SFR-145, 139 |
| | license_key / hospital_pc | 라이선스 키, 등록 PC (병원당 3대) | SFR-116, 123, 146, 147 |
| | hospital_shift | 근무 담당자 이름, 알림 켜기 | SFR-117 |
| | bed_current | 병상 캐시 (병원당 최신 1행, 3분마다 갱신) | QUR-008, SFR-007 |
| | capability_item / hospital_capability | 중증질환 진료가능 항목 (공공 데이터 표기 그대로) | SFR-007 |
| | symptom / symptom_capability | 증상 버튼 S01~S16과 진료가능 항목 연결 (필수 병상은 항목별 여러 개: `required_beds`) | 부록 B·C, SFR-108 |
| | bed_history | 병상 이력 30일 (2단계 분석용) | DAR-007 |
| D 이송 (핵심) | transport | 이송 건. ID는 처음 만든 폰이 정함 (오프라인 복구). 상태 6개(phone_check 포함), 종료 뒤 team_id NULL | SFR-104, 099, 086 |
| | transport_status_history | 상태가 바뀔 때마다 1행 (이전·다음 상태, 사건, 사유, 시각) | SFR-086 |
| | assessment | 병원에 보낸 환자 평가. '변경 사항 보내기'마다 1행 추가 | SFR-108, 121 |
| | request_round | 요청 회차 (2분 응답 제한, 5분 승인 유효) | SFR-109, 124, 127 |
| | hospital_request | 병원 요청: 회차 하나에서 병원 한 곳에 보낸 요청 | 부록 A-2 |
| | excluded_hospital | 이번 이송의 제외 병원 (규칙 하나로 계산) | SFR-086 |
| | phone_check | 예비 흐름 전화 확인 결과 | SFR-032~034 |
| | location_point | 이송 중 위치. 이송이 끝나면 바로 삭제 | SFR-037, SER-002 |
| | idempotency_key | 같은 확정을 여러 번 보내도 한 번만 처리 | SFR-111 |
| E 기록·통계 | request_view_log | 병원 열람 기록 | SFR-137 |
| | response_stat / transport_stat | 응답·거절·소요시간 통계 (대원 계정과 연결 안 함) | SFR-106, 126, DAR-004 |
| F 관리자 | admin | 관리자 계정 (OTP) | SFR-082, 152 |
| | admin_audit_log | 작업 이력. DB 규칙으로 수정·삭제 불가 | SFR-091 |
| | admin_notification | 관리자 알림 (30분 안 같은 종류는 횟수만 증가) | SFR-100 |
| G 실시간 | event_log | 보낸 실시간 이벤트 기록 (재연결 때 놓친 것 다시 보내기, 24시간 보관) | 1-4 실시간 통신 설계 |

## DB가 직접 막아주는 규칙 (테스트 완료)

| 규칙 | 방법 |
|---|---|
| 팀당 진행 중 이송은 1건 | `one_active_transport_per_team` 부분 유일 인덱스 |
| 팀당 운전 역할은 1명 | `one_driver_per_team` 부분 유일 인덱스 |
| 대원은 동시에 팀 하나만 | `one_active_team_per_user` |
| 같은 회차에서 같은 병원에 두 번 요청 안 함 | `hospital_request (round_id, hospital_id)` UNIQUE |
| 작업 이력 수정·삭제 불가 | `admin_audit_log`에 UPDATE·DELETE 무시 규칙 |
| 반경은 10·20·30·40km만 | CHECK 제약 |

| 반경은 회차에도 10·20·30·40km만 | `request_round.radius_km` CHECK |
| 사유 값은 정해진 것만 | cancel_reason·arrival_method·closed_reason·reason·dest_change_reason 등 CHECK (상태 전이 코드의 값과 같음) |
| 열람 기록 수정·삭제 불가 | `request_view_log` UPDATE·DELETE 무시 규칙 (DAR-011) |

## v0.1 → v0.2 바뀐 점
| 바뀐 점 | 이유 |
|---|---|
| `transport_status`에 `phone_check` 추가, `phone_result`에 `dismissed` 추가 | 상태 전이 v0.2 (부록 A13~A18) |
| `transport_status_history` 신규 | 상태마다 변경 시각·사유 저장 (SFR-086) |
| transport: `team_id` NULL 허용, `departed_at`·`last_activity_at`·`phone_target_hospital_id`·`fallback_reason`·`offline_created`·`address`·목적지 변경 칸 추가, 사유 칸 CHECK | 종료 뒤 팀 연결 끊기, 처음 출발 시각 유지, 2시간 자동 종료 |
| assessment: 의식 상태 `unresponsive` 들어가게 길이 12, 성별 `U`(확인 불가), 외상 yes/no/unknown, 보낸 대원 칸 삭제 | 앱 입력값과 일치, 계정과 연결 안 함 (DAR-013) |
| hospital_request: `extra_memo`(추가 메모 1번), `prev_approved_recheck`, `reason_text`, `arrived_at`, 사유 CHECK | SFR-140·156·119, 열람 1시간·수용 불가 10분 |
| request_round: `kind`(first·expand·re_request·dest_change) | 반경 넓히기와 다시 요청 구분 |
| 필수 병상 `required_beds` 배열 | 항목 하나에 병상 여러 개 (부록 C) |
| response_stat 결과에 `approval_cancelled`·`unacceptable` | 통계 (SFR-106) |
| phone_check: 기록 대원 칸 삭제, `client_record_id`로 중복 전송 방지 | DAR-004, 오프라인 재전송 |
| team_member `joined_seq`·`left_reason`, event_log `entity_type/id/version` | 실시간 다시 받기 필터, 오래된 이벤트 무시 |
| bed_history 신규 | DAR-007 |

## 서버 코드가 맡을 규칙 (DB만으로는 안 되는 것)

- 2분 만료, 5분 승인 해제: `request_round`의 시각과 서버 타이머로 처리
- 두 PC 동시 응답, 동시 확정: `version` 값을 비교해서 먼저 온 것만 반영
- 원본 위치 삭제: 도착·취소 때 `location_point` 삭제, `transport.origin_*`은 NULL로
- 환자 평가 보관 기간이 지나면 `assessment` 항목 삭제 (통계 행은 남김)
