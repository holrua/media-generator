/**
 * اختبار وحدة: كشف المهمة العالقة + عدّاد «التقدم المتحرك» + ترحيل الأعمدة
 * يُشغَّل: bun scripts/test-stall-restart.ts
 * يعمل على قاعدة libSQL محلية (file:) — لا يحتاج Turso أو مفاتيح خارجية،
 * ويؤكد أيضًا أن ترحيل ALTER يعمل على قاعدة قديمة ولا يكسر قاعدة جديدة.
 */
process.env.TURSO_DATABASE_URL = "file:/tmp/stall-test.db";
process.env.TURSO_AUTH_TOKEN = "local-test";

import { unlinkSync } from "node:fs";
import { getTurso } from "../src/lib/turso";
import { insertTask, getTask, updateTask } from "../src/lib/tasks";
import { isStalled, STALL_AFTER_MS, MAX_AUTO_RESTARTS } from "../src/lib/generator";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

function ageSeconds(iso: string | null): number {
  if (!iso) return -1;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 1000 : -1;
}

async function main() {
  // قاعدة نظيفة لكل تشغيل
  try { unlinkSync("/tmp/stall-test.db"); } catch { /* لا ملف سابق */ }

  console.log("0) الثوابت:");
  check("STALL_AFTER_MS = 10 دقائق", STALL_AFTER_MS === 10 * 60_000);
  check("MAX_AUTO_RESTARTS = 3", MAX_AUTO_RESTARTS === 3);

  console.log("1) إنشاء مهمة فيديو معالجة (قاعدة جديدة + الترحيل لا يكسر شيئًا):");
  const task = await insertTask({
    provider: "kie",
    providerTaskId: "kie-task-1",
    keyId: "k1",
    model: "grok-imagine-video-1-5-preview",
    type: "video",
    prompt: "اختبار التعليق",
    params: {},
    status: "processing",
    progress: 5,
  });
  check("progressUpdatedAt يسجل عند الإنشاء", ageSeconds(task.progressUpdatedAt) >= 0 && ageSeconds(task.progressUpdatedAt) < 5);
  check("restarts = 0", task.restarts === 0);
  check("isStalled فورًا → false", isStalled(task) === false);

  console.log("2) استعلام بنفس النسبة لا يعيد ضبط العدّاد (ساعة التعليق تعمل):");
  const t0 = task.progressUpdatedAt!;
  await new Promise((r) => setTimeout(r, 1100));
  const same = await updateTask(task.id, { status: "processing", progress: 5, errorMessage: null });
  check("progressUpdatedAt لم يتغير", same?.progressUpdatedAt === t0, `got ${same?.progressUpdatedAt} want ${t0}`);
  check("isStalled ما زال false", isStalled(same!) === false);

  console.log("3) ارتفاع فعلي في التقدم يعيد ضبط العدّاد:");
  const advanced = await updateTask(task.id, { status: "processing", progress: 40 });
  check("progressUpdatedAt تقدم", ageSeconds(advanced?.progressUpdatedAt ?? null) < 5, `got ${advanced?.progressUpdatedAt}`);

  console.log("4) مهمة مزود جديدة (إعادة توليد) تعيد الضبط حتى مع تراجع النسبة إلى 5:");
  await new Promise((r) => setTimeout(r, 1100));
  const renewed = await updateTask(task.id, { providerTaskId: "kie-task-2", progress: 5 });
  check("providerTaskId الجديد يعيد ضبط العدّاد", ageSeconds(renewed?.progressUpdatedAt ?? null) < 5, `got ${renewed?.progressUpdatedAt}`);

  console.log("5) كشف التعليق حسب المدّة:");
  const elevenMinAgo = new Date(Date.now() - (STALL_AFTER_MS + 60_000)).toISOString();
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const stalled = await updateTask(task.id, { progressUpdatedAt: elevenMinAgo });
  check("تجاوزت الحد بـ دقيقة → stalled true", isStalled(stalled!) === true);
  const notYet = await updateTask(task.id, { progressUpdatedAt: fiveMinAgo });
  check("تحت الحد (5 دقائق) → false", isStalled(notYet!) === false);

  console.log("6) الاستثناءات:");
  const syncTask = await insertTask({
    provider: "cometapi", providerTaskId: "sync-123", keyId: "k2", model: "x", type: "image",
    prompt: "p", params: {}, status: "processing", progress: 0,
  });
  await updateTask(syncTask.id, { progressUpdatedAt: elevenMinAgo });
  check("مهمة متزامنة sync- → لا تعتبر عالقة", isStalled((await getTask(syncTask.id))!) === false);

  const mergerTask = await insertTask({
    provider: "merger", providerTaskId: "mj1", keyId: null, model: "video-merger", type: "merge",
    prompt: "p", params: {}, status: "processing", progress: 0,
  });
  await updateTask(mergerTask.id, { progressUpdatedAt: elevenMinAgo });
  check("مهمة دمج merger → لها مسارها الخاص", isStalled((await getTask(mergerTask.id))!) === false);

  const doneTask = await insertTask({
    provider: "kie", providerTaskId: "kie-task-3", keyId: "k1", model: "m", type: "video",
    prompt: "p", params: {}, status: "completed", progress: 100,
  });
  await updateTask(doneTask.id, { progressUpdatedAt: elevenMinAgo });
  check("مهمة مكتملة → false", isStalled((await getTask(doneTask.id))!) === false);

  console.log("7) صف قديم بلا progress_updated_at (قبل الترحيل) → false حتى يُهيَّأ:");
  const legacy = await insertTask({
    provider: "kie", providerTaskId: "kie-task-4", keyId: "k1", model: "m", type: "video",
    prompt: "p", params: {}, status: "processing", progress: 0,
  });
  // محاكاة صف قديم: نمسح العمود يدويًا
  await getTurso().execute({ sql: "UPDATE tasks SET progress_updated_at = NULL WHERE id = ?", args: [legacy.id] });
  const legacyRow = (await getTask(legacy.id))!;
  check("NULL → isStalled false", isStalled(legacyRow) === false);

  console.log("8) ترحيل قاعدة بالشكل القديم (بلا الأعمدة الجديدة):");
  // عميل ثانٍ على ملف آخر — نعيد ضبط الحالة العالمية للمخطط
  (globalThis as unknown as { __tursoSchemaReady?: Promise<void> }).__tursoSchemaReady = undefined;
  (globalThis as unknown as { __tursoClient?: unknown }).__tursoClient = undefined;
  process.env.TURSO_DATABASE_URL = "file:/tmp/stall-test-old.db";
  try { unlinkSync("/tmp/stall-test-old.db"); } catch { /* لا ملف سابق */ }
  const oldDb = getTurso();
  await oldDb.executeMultiple(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      provider TEXT,
      provider_task_id TEXT,
      key_id TEXT,
      model TEXT NOT NULL,
      type TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      params_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      progress INTEGER NOT NULL DEFAULT 0,
      result_urls_json TEXT,
      error_message TEXT,
      attempts_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
  `);
  await oldDb.execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES ('legacy-row-1', 'kie', 'old-provider-task', NULL, 'm', 'video', 'قديمة', '{}', 'processing', 10)`,
  });
  // أي دالة تستدعي ensureSchema ستنفّذ الترحيل (ALTER) على القاعدة القديمة
  const legacyAfter = (await getTask("legacy-row-1"))!;
  check("الصف القديم يُقرأ بعد الترحيل", legacyAfter.id === "legacy-row-1");
  check("الأعمدة الجديدة على الصف القديم: restarts=0", legacyAfter.restarts === 0);
  check("الأعمدة الجديدة على الصف القديم: progressUpdatedAt=null", legacyAfter.progressUpdatedAt === null);
  const migrated = await insertTask({
    provider: "kie", providerTaskId: "new-after-migration", keyId: null, model: "m", type: "video",
    prompt: "p", params: {}, status: "processing", progress: 0,
  });
  check("insertTask يعمل على القاعدة المُرحَّلة", Boolean(migrated.id));

  console.log(`\nالنتيجة: ${passed} نجح / ${failed} فشل`);
  if (failed > 0) process.exit(1);
  console.log("STALL RESTART TESTS PASSED");
}

main().catch((e) => {
  console.error("STALL RESTART TEST FAILED:", e);
  process.exit(1);
});
