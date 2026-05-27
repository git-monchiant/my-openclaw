/**
 * Temporal Decay — เหมือน OpenClaw
 *
 * ข้อมูลเก่าได้ score ต่ำลง ข้อมูลใหม่ได้ score สูงกว่า
 * ใช้ exponential decay: multiplier = exp(-λ * age_days)
 * λ = ln(2) / halfLifeDays
 *
 * ตัวอย่าง (halfLife = 30 days):
 * - 0 วัน: 1.0x
 * - 30 วัน: 0.5x
 * - 60 วัน: 0.25x
 * - 90 วัน: 0.125x
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * คำนวณ decay multiplier (เหมือน OpenClaw)
 *
 * @param createdAt - timestamp (ms) ที่สร้าง chunk
 * @param halfLifeDays - จำนวนวันที่ score ลดลงครึ่งนึง
 * @returns multiplier 0-1 (1 = ใหม่, 0 = เก่ามาก)
 */
export function computeDecay(
  createdAt: number,
  halfLifeDays: number,
): number {
  if (halfLifeDays <= 0) return 1;

  const now = Date.now();
  const ageDays = Math.max(0, (now - createdAt) / MS_PER_DAY);
  const lambda = Math.LN2 / halfLifeDays;

  return Math.exp(-lambda * ageDays);
}

/**
 * Apply temporal decay to scores
 */
export function applyTemporalDecay<T extends { score: number; createdAt: number }>(
  items: T[],
  halfLifeDays: number,
): T[] {
  return items.map((item) => ({
    ...item,
    score: item.score * computeDecay(item.createdAt, halfLifeDays),
  }));
}
