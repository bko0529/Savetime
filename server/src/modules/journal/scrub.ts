// AI 로 보내기 전에 환자 식별정보를 지운다 (SER-017, 기술정의서 T-12).
// 서버는 환자 이름·주소를 원래 갖고 있지 않다(절대 규칙 2). 그래서 대원 메모에 섞여 들어온 것만 여기서 걸러 낸다:
// - 앱이 같이 보낸 이름 칸 값(환자·보호자 이름, 단말에만 있음)
// - 주민등록번호·전화번호 모양
// - 주소 모양 (시·도 / 시·군·구 / 읍·면·동 / ~로·~길 + 번지)
// 지운 자리에는 [삭제] 를 넣어 AI 가 문장 흐름을 잃지 않게 한다. 지운 내용은 어디에도 남기지 않고 개수만 센다

const MASK = '[삭제]';
// 숫자 바로 뒤에 오면 주소 번지가 아니라 수치로 본다 (분·회·리터·mg 등, 앞에 띄어쓰기가 있어도)
const UNIT = String.raw`\s?(?:분|초|시간|회|번(?!지|길)|개|알|정|L|l|리터|mL|ml|cc|mg|g|kg|%|도|mmHg|세|살|cm|m)`;

// 순서가 중요하다: 주민번호(13자리)를 전화번호보다 먼저 지워야 앞 6자리가 전화번호로 잘못 잡히지 않는다
const PATTERNS: RegExp[] = [
  // 주민등록번호·외국인등록번호: 900101-1234567, 9001011234567
  /\b\d{6}\s*-?\s*[1-8]\d{6}\b/g,
  // 휴대전화: 010-1234-5678, 010 1234 5678, 01012345678
  /\b01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}\b/g,
  // 지역번호 전화: 02-123-4567, 041-123-4567
  /\b0\d{1,2}[\s.-]\d{3,4}[\s.-]\d{4}\b/g,
  // 도로명 주소: '번영로 123', '성정2길 45-6'.
  // '마스크로 10L'·'병원으로 5분'처럼 조사 '로' 뒤 숫자+단위는 주소가 아니라서 뺀다 (UNIT)
  new RegExp(`[가-힣0-9]+(?:로|길)\\s?\\d+(?:-\\d+)?(?:번길\\s?\\d+)?(?!\\d|-|${UNIT})`, 'g'),
  // 지번 주소: '신부동 123-4', '성거읍 55번지'. '운동 3회' 같은 숫자+단위는 뺀다
  new RegExp(`[가-힣]+(?:동|리|읍|면)\\s?\\d+(?:-\\d+)?(?:번지)?(?!\\d|-|${UNIT})`, 'g'),
  // 시·군·구 이름 + 행정구역 (주소 앞부분): '천안시 동남구', '충청남도 아산시'
  /[가-힣]+(?:특별시|광역시|특별자치시|특별자치도|도)\s?[가-힣]+(?:시|군|구)/g,
  // 시·군 + 구·읍·면: '천안시 동남구', '예산군 삽교읍'
  /[가-힣]{1,4}(?:시|군)\s?[가-힣]{1,4}(?:구|읍|면)(?![가-힣])/g,
];

export interface Scrubbed {
  text: string;
  removed: number;
}

export function scrubIdentifiers(text: string, names: string[] = []): Scrubbed {
  let out = text;
  let removed = 0;
  const replace = (pattern: RegExp) => {
    out = out.replace(pattern, () => {
      removed += 1;
      return MASK;
    });
  };
  // 이름: 앱이 보낸 칸 값 그대로. 긴 이름부터 지워야 '홍길동'보다 '홍길'이 먼저 지워지는 일이 없다
  const cleanNames = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );
  for (const name of cleanNames) {
    replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
  }
  for (const pattern of PATTERNS) replace(pattern);
  return { text: out, removed };
}
