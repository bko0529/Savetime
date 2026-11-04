// 병원 PC 인증 (COR-012, SER-009). 병원 웹에는 아이디·비밀번호가 없고, 등록한 PC 의 쿠키로만 들어온다.
import { createHash, randomBytes } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { AppError } from '../../http/errors.js';
import type { Realtime } from '../realtime/server.js';

export interface HospitalWebContext {
  pool: pg.Pool;
  redis: Redis;
  // 병원 웹 주소(예: https://savetime.example). 비어 있으면 Origin 검사를 하지 않는다
  allowedOrigins: string[];
  // 실시간 서버. 알림 켜기·근무 종료가 탭을 요청 대상 방에 넣고 뺀다. 없으면(일부 테스트) 알림 켜기를 못 한다
  realtime?: Pick<Realtime, 'alarmOn' | 'alarmOff'>;
}

export const PC_COOKIE = 'st_pc';
// 키 유효기간과 같은 1년. 실제로 쓸 수 있는지는 요청마다 DB 로 확인한다
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
// 90일 동안 안 쓴 PC 는 등록을 풀어 자리를 비운다 (SFR-147)
export const UNUSED_DAYS = 90;

export function newPcToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashPcToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// httpOnly: 화면의 스크립트가 못 읽음 · Secure: https 로만 · SameSite=Strict: 다른 사이트에서 부른 요청에는 안 붙음.
// Path=/ 는 /api 와 /socket.io 둘 다에 쿠키가 가야 해서다 (실시간 연결도 이 쿠키로 PC 를 알아본다)
export function setPcCookie(res: Response, token: string): void {
  res.cookie(PC_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

// 쿠키 읽기 라이브러리 없이 필요한 쿠키 하나만 꺼낸다
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// 다른 사이트가 병원 PC 브라우저를 시켜 요청을 보내는 것을 막는다 (SER-008). Origin 이 없는 요청(curl 등)은 쿠키도 없다
export function checkOrigin(allowed: string[]): RequestHandler {
  return (req, _res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.length > 0 && !allowed.includes(origin)) {
      throw new AppError(403, 'ORIGIN_NOT_ALLOWED', '허용되지 않은 주소에서 온 요청이에요');
    }
    next();
  };
}

export interface HospitalPc {
  pcId: number;
  pcName: string;
  hospitalId: number;
  hospitalName: string;
  licenseDaysLeft: number;
}

export function hospitalPc(res: Response): HospitalPc {
  return res.locals.pc as HospitalPc;
}

interface PcRow {
  pc_id: string;
  pc_name: string;
  hospital_id: string;
  hospital_name: string;
  released: boolean;
  account_active: boolean;
  unused_too_long: boolean;
  license_days_left: number | null;
}

export const hospitalSuspended = () =>
  new AppError(403, 'ACCOUNT_SUSPENDED', '병원 계정이 정지됐어요. 관리자에게 문의하세요');

const notRegistered = () =>
  new AppError(401, 'PC_NOT_REGISTERED', '등록되지 않은 PC예요. 라이선스 키를 입력해 주세요');

// 병원 PC API 입구. 쿠키 → 등록 PC → 병원의 유효한 키 순서로 확인하고, 마지막 사용 시각을 남긴다.
// 시간 판정(90일·키 만료)은 모두 DB 시각 기준 (규칙 6)
export function requireHospitalPc(ctx: HospitalWebContext): RequestHandler {
  return async (req: Request, res, next) => {
    const token = readCookie(req.headers.cookie, PC_COOKIE);
    if (!token) throw notRegistered();

    const { rows } = await ctx.pool.query<PcRow>(
      `SELECT pc.id AS pc_id, pc.name AS pc_name, h.id AS hospital_id, h.name AS hospital_name,
              pc.released_at IS NOT NULL AS released, h.account_active,
              pc.last_used_at < now() - make_interval(days => $2) AS unused_too_long,
              (SELECT ceil(extract(epoch FROM max(lk.expires_at) - now()) / 86400)::int
                 FROM license_key lk
                WHERE lk.hospital_id = h.id AND lk.revoked_at IS NULL AND lk.expires_at > now()
              ) AS license_days_left
         FROM hospital_pc pc
         JOIN hospital h ON h.id = pc.hospital_id
        WHERE pc.token_hash = $1`,
      [hashPcToken(token), UNUSED_DAYS],
    );
    const row = rows[0];
    if (!row || row.released) throw notRegistered();
    if (row.unused_too_long) {
      await ctx.pool.query('UPDATE hospital_pc SET released_at = now() WHERE id = $1', [row.pc_id]);
      throw notRegistered();
    }
    // 관리자가 병원 계정을 정지하면 그 병원의 모든 PC 가 다음 요청부터 바로 막힌다 (SFR-123)
    if (!row.account_active) throw hospitalSuspended();
    // 병원의 키가 모두 만료·폐기됐으면 PC 등록은 남아 있어도 쓸 수 없다 (SFR-146)
    if (row.license_days_left === null) {
      throw new AppError(403, 'LICENSE_EXPIRED', '라이선스 키 기간이 끝났어요');
    }

    await ctx.pool.query('UPDATE hospital_pc SET last_used_at = now() WHERE id = $1', [row.pc_id]);
    const pc: HospitalPc = {
      pcId: Number(row.pc_id),
      pcName: row.pc_name,
      hospitalId: Number(row.hospital_id),
      hospitalName: row.hospital_name,
      licenseDaysLeft: row.license_days_left,
    };
    res.locals.pc = pc;
    next();
  };
}
