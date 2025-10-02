// scripts/fix-sortorder-safe.mjs
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const INT_MAX = 2147483647;

async function clampByRawSQL() {
  // ยิงหลายคำสั่ง เผื่อแตกต่างกันระหว่าง SQLite/MySQL/Postgres
  const stmts = [
    `UPDATE "PortfolioImage" SET "sortOrder" = 0 WHERE "sortOrder" > ${INT_MAX} OR "sortOrder" < 0 OR "sortOrder" IS NULL;`,
    'UPDATE `PortfolioImage` SET `sortOrder` = 0 WHERE `sortOrder` > ' + INT_MAX + ' OR `sortOrder` < 0 OR `sortOrder` IS NULL;',
    `UPDATE PortfolioImage SET sortOrder = 0 WHERE sortOrder > ${INT_MAX} OR sortOrder < 0 OR sortOrder IS NULL;`,
  ];

  let ok = false, lastErr = null;
  for (const sql of stmts) {
    try {
      const n = await prisma.$executeRawUnsafe(sql);
      console.log(`[RAW SQL] OK -> affected rows: ${n}`);
      ok = true;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!ok) {
    console.error('ไม่สามารถรัน UPDATE แบบ RAW ได้', lastErr);
    throw lastErr;
  }
}

async function resequence() {
  // ไม่มี createdAt ก็อ่านเฉพาะคอลัมน์ที่มี
  const imgs = await prisma.portfolioImage.findMany({
    select: { id: true, portfolioId: true, sortOrder: true },
    orderBy: [{ portfolioId: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
  });

  const byPortfolio = new Map();
  for (const im of imgs) {
    if (!byPortfolio.has(im.portfolioId)) byPortfolio.set(im.portfolioId, []);
    byPortfolio.get(im.portfolioId).push(im);
  }

  let updates = 0;
  for (const [pid, arr] of byPortfolio) {
    // เรียงซ้ำอีกที กันกรณีค่าชนกันหลายรูป
    arr.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);

    let seq = 1;
    for (const im of arr) {
      if (im.sortOrder !== seq) {
        await prisma.portfolioImage.update({
          where: { id: im.id },
          data: { sortOrder: seq },
        });
        updates++;
      }
      seq++;
    }
    console.log(`resequenced portfolioId=${pid} -> ${arr.length} ภาพ`);
  }
  console.log(`อัปเดต sortOrder ทั้งหมด: ${updates} แถว`);
}

async function main() {
  console.log('Step 1: Clamp ค่าที่ผิดช่วงด้วย RAW SQL...');
  await clampByRawSQL();

  console.log('Step 2: Resequence sortOrder ต่อภาพในแต่ละผลงาน...');
  await resequence();

  console.log('Done ✅');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
