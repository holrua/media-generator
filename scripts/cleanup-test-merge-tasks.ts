/** حذف مهام الدمج التجريبية الفاشلة (الناتجة عن اختبارات هذه الجلسة) من Turso */
import { getTurso, ensureSchema } from "../src/lib/turso";

async function main() {
  await ensureSchema();
  const res = await getTurso().execute({
    sql: `DELETE FROM tasks WHERE type = 'merge' AND status = 'failed' AND error_message LIKE '%فشل إنشاء مهمة الدمج%' RETURNING id`,
  });
  console.log(`deleted ${res.rows.length} test merge task(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
