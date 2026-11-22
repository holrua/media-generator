/**
 * اختبار ربط حي لمسار المهمة العالقة عبر refreshTask (بلا سيرفر):
 * 1) مفتاح وهمي + مهمة عالقة (التقدم مجمد 11 دقيقة) → refreshTask يجب أن يحاول الإعادة
 *    (createTask على المفتاح الوهمي سيرفض 401 → محاولة مسجلة → المهمة تبقى processing)
 * 2) استعلام ثانٍ فوري → تهدئة 45 ثانية تمنع محاولة جديدة (لا محاولات إضافية)
 * يُشغَّل: bun scripts/test-stall-wiring.ts (بيئة معزولة file:)
 */
process.env.TURSO_DATABASE_URL = "file:/tmp/stall-wiring.db";
process.env.TURSO_AUTH_TOKEN = "local-test";
process.env.KIE_API_BASE = process.env.KIE_API_BASE || "https://api.kie.ai";

import { unlinkSync } from "node:fs";
import { addKey, deleteKey, listKeys } from "../src/lib/keys";
import { insertTask, updateTask, getTask } from "../src/lib/tasks";
import { refreshTask, STALL_AFTER_MS } from "../src/lib/generator";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}

async function main() {
  try { unlinkSync("/tmp/stall-wiring.db"); } catch { /* لا ملف سابق */ }

  // 1) تجهيز: مفتاح kie وهمي + مهمة عالقة منذ 11 دقيقة
  const fake = await addKey("kie", "fake-key-for-stall-wiring-test", "STALLWIRING");
  const stalledAt = new Date(Date.now() - (STALL_AFTER_MS + 60_000)).toISOString();
  const task = await insertTask({
    provider: "kie",
    providerTaskId: "fake-stalled-provider-task",
    keyId: fake.id,
    model: "grok-imagine-video-1-5-preview",
    type: "video",
    prompt: "اختبار ربط التعليق",
    params: {},
    status: "processing",
    progress: 5,
  });
  await updateTask(task.id, { progressUpdatedAt: stalledAt });

  console.log("1) refreshTask على مهمة عالقة (مفتاح وهمي سيرفض الطلب):");
  const after1 = (await refreshTask(task.id))!;
  check("المهمة بقيت processing (لم تفشل)", after1.status === "processing", after1.status);
  check("سُجّلت محاولة مرفوضة في attempts", after1.attempts.some((a) => !a.ok && (a.error ?? "").length > 0), JSON.stringify(after1.attempts.slice(-1)));
  const note = after1.attempts.find((a) => a.errorClass === "stalled");
  check("محاولة الإعادة موثقة بتصنيف stalled أو مرفوضة من المزود", Boolean(note) || after1.attempts.length > 0);
  console.log("   رسالة الخطأ:", after1.errorMessage?.slice(0, 90));

  console.log("2) استعلام ثانٍ فوري → التهدئة تمنع محاولة جديدة:");
  const attemptCount1 = after1.attempts.length;
  const after2 = (await refreshTask(task.id))!;
  check("لا محاولات إضافية خلال التهدئة", after2.attempts.length === attemptCount1, `${after2.attempts.length} vs ${attemptCount1}`);
  check("المهمة ما زالت processing", after2.status === "processing");

  console.log("3) مهمة غير عالقة (تقدم حديث) لا تُعاد أبدًا:");
  const fresh = await insertTask({
    provider: "kie", providerTaskId: "fresh-provider-task", keyId: fake.id,
    model: "grok-imagine-video-1-5-preview", type: "video",
    prompt: "p", params: {}, status: "processing", progress: 15,
  });
  const freshAfter = (await refreshTask(fresh.id))!;
  // استعلام الحالة لدى المزود بالمفتاح الوهمي سيرفض — لكن مسار التعليق نفسه لن يُفعَّل
  check("لا محاولة إعادة توليد لمهمة حديثة", !freshAfter.attempts.some((a) => (a.error ?? "").includes("إعادة توليد تلقائية")));

  console.log("4) التحقق من عدّاد إعادة التوليد عند تجاوز الحد (منطق السقف عبر MAX_AUTO_RESTARTS=3):");
  // نضع المهمة عند restarts=3 (الحد) + عالقة → يجب أن تفشل نهائيًا برسالة واضحة
  await updateTask(task.id, { restarts: 3, progressUpdatedAt: new Date(Date.now() - (STALL_AFTER_MS + 120_000)).toISOString() });
  // نتجاوز التهدئة بإلحاق محاولة قديمة زمنيًا
  await getTursoRawUpdate(task.id);
  const afterCap = (await refreshTask(task.id))!;
  check("بعد استنفاد 3 إعادات → فشل نهائي", afterCap.status === "failed", afterCap.status);
  check("رسالة الفشل توضح استنفاد المحاولات", (afterCap.errorMessage ?? "").includes("أُعيد التوليد تلقائيًا"), afterCap.errorMessage ?? "");

  console.log("5) التنظيف:");
  await deleteKey(fake.id);
  const keys = await listKeys();
  check("حُذف المفتاح الوهمي", !keys.some((k) => k.id === fake.id));

  console.log(`\nالنتيجة: ${passed} نجح / ${failed} فشل`);
  if (failed > 0) process.exit(1);
  console.log("STALL WIRING TESTS PASSED ✓");
}

/** تحديث زمن آخر محاولة داخل attempts_json إلى ما قبل التهدئة (لتجاوزها في اختبار السقف) */
async function getTursoRawUpdate(taskId: string) {
  const { getTurso } = await import("../src/lib/turso");
  const row = await getTurso().execute({ sql: "SELECT attempts_json FROM tasks WHERE id = ?", args: [taskId] });
  const attempts = JSON.parse(String(row.rows[0].attempts_json ?? "[]")) as Array<{ at: string }>;
  const old = new Date(Date.now() - 120_000).toISOString();
  for (const a of attempts) a.at = old;
  await getTurso().execute({ sql: "UPDATE tasks SET attempts_json = ? WHERE id = ?", args: [JSON.stringify(attempts), taskId] });
}

main().catch((e) => {
  console.error("STALL WIRING TEST FAILED:", e);
  process.exit(1);
});
