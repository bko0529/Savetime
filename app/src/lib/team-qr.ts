/**
 * 팀 QR (SFR-113 · 159). 팀을 만든 대원 화면의 QR 에는 `savetime:team:<qrToken>` 이 들어 있다.
 * 카메라 화면 한 장(ImageData)에서 QR 을 찾아, 우리 팀 QR 이면 토큰만 꺼낸다.
 */
import jsQR from "jsqr";

const PREFIX = "savetime:team:";

/** QR 글자에서 팀 토큰만 꺼낸다. 다른 QR(웹 주소 등)이면 null */
export function parseTeamQr(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith(PREFIX)) return null;
  const token = t.slice(PREFIX.length).trim();
  return token.length > 0 && token.length <= 200 ? token : null;
}

/** 카메라 화면 한 장에서 팀 QR 토큰을 찾는다. 못 찾으면 null */
export function findTeamQr(frame: ImageData): string | null {
  const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
  return code ? parseTeamQr(code.data) : null;
}
