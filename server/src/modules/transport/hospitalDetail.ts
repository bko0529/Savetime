// GET /hospitals/{hospitalId}: 대원 앱 병원 상세 (SFR-007)
import { Router } from 'express';
import type pg from 'pg';
import { AppError } from '../../http/errors.js';

interface HospitalDetailRow {
  id: string;
  name: string;
  lat: string;
  lng: string;
  address: string | null;
  departments: string[];
  er_phone: string | null;
  main_phone: string | null;
  grade: number;
  er_avail: number | null;
  er_total: number | null;
  icu_avail: number | null;
  icu_total: number | null;
  or_avail: number | null;
  or_total: number | null;
  source_time: Date | null;
  capabilities: { name: string; available: boolean }[];
}

// 병상이 없는 병원도 상세는 보여야 해서 LEFT JOIN을 쓴다. 비어 있는 값은 null로 내려가 앱이 '정보 없음'으로 표시한다.
const DETAIL_SQL = `
  SELECT h.id, h.name, h.lat, h.lng, h.address, h.departments, h.er_phone, h.main_phone, h.grade,
         c.er_avail, c.er_total, c.icu_avail, c.icu_total, c.or_avail, c.or_total, c.source_time,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object('name', i.name, 'available', hc.available)
                            ORDER BY length(i.code), i.code)
             FROM hospital_capability hc
             JOIN capability_item i ON i.code = hc.item_code
            WHERE hc.hospital_id = h.id
         ), '[]'::jsonb) AS capabilities
    FROM hospital h
    LEFT JOIN bed_current c ON c.hospital_id = h.id
   WHERE h.id = $1`;

// 숫자가 아니거나 너무 긴 값을 그대로 DB에 보내면 쿼리 오류(500)가 나서 먼저 걸러낸다.
const VALID_ID = /^[1-9]\d{0,15}$/;

function notFound(): AppError {
  return new AppError(404, 'NOT_FOUND', '병원을 찾을 수 없어요');
}

export function hospitalDetailRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get('/hospitals/:hospitalId', async (req, res) => {
    const { hospitalId } = req.params;
    if (!VALID_ID.test(hospitalId)) throw notFound();

    const { rows } = await pool.query<HospitalDetailRow>(DETAIL_SQL, [hospitalId]);
    const row = rows[0];
    if (!row) throw notFound();

    res.json({
      id: Number(row.id),
      name: row.name,
      lat: Number(row.lat),
      lng: Number(row.lng),
      address: row.address,
      departments: row.departments,
      erPhone: row.er_phone,
      mainPhone: row.main_phone,
      beds: {
        er: { avail: row.er_avail, total: row.er_total },
        icu: { avail: row.icu_avail, total: row.icu_total },
        or: { avail: row.or_avail, total: row.or_total },
      },
      bedsSourceTime: row.source_time,
      capabilities: row.capabilities,
      grade: row.grade,
    });
  });

  return router;
}
