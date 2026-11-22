/**
 * عميل خدمة دمج الفيديوهات (Video Merger API v2)
 *
 * دمج عدة مقاطع فيديو في مقطع واحد عالي الجودة — دون تنزيل أي وسائط على هذا السيرفر:
 * نرسل روابط الفيديوهات للخدمة، ننفّذ خطوة process، نتابع الحالة، وعند الاكتمال نخزّن
 * رابط الفيديو النهائي في Turso (مثل بقية المهام تمامًا).
 *
 * REST v2 (عنوان الخدمة MERGER_API_BASE — الافتراضي https://dmg1.vercel.app، بلا مفاتيح):
 *   POST /api/jobs                    {videos:[...]} → {jobId, status:"queued", statusUrl, processUrl, expiresAt}
 *   POST /api/jobs/{job_id}/process   ينفّذ الدمج فعليًا (~10–15 ثانية blocking)
 *                                     200 → {status:"done", videoUrl, downloadUrl, size, duration, resolution, expiresAt}
 *                                     فشل → HTTP 4xx/5xx + {error} — فشل حتمي (المدخلات نفسها)
 *   GET  /api/jobs/{job_id}           {status:"queued|done|failed", progress, videoUrl?, downloadUrl?, error?}
 *   GET  /api/jobs/{job_id}/video     ملف MP4 النهائي (يدعم Range) — رابط النتيجة الاحتياطي
 *   DELETE /api/jobs/{job_id}         حذف فوري
 *   GET  /api/config                  حدود الخدمة (يُستخدم لفحص الجهوزية)
 *
 * القيود: 10 مقاطع كحد أقصى، 200MB لكل رابط مصدر، 150MB للناتج، 600 ثانية مجموع المدد.
 * لا معاملات resolution/fps — الناتج ثابت: MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18.
 * ملفات الخدمة تُحذف تلقائيًا بعد 24 ساعة (expiresAt) — ننبّه المستخدم بالتنزيل المبكر.
 *
 * قاعدة الأخطاء الحتمية: أي خطأ HTTP معلن من الخدمة (4xx/5xx) = فشل نهائي فوري —
 * أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة ويستمر التتبع.
 * التحليل دفاعي: الحقول تقبل أسماء بديلة (jobId|job_id، done|completed، videoUrl|downloadUrl، progress كسري…).
 */
import { insertTask, updateTask, type TaskRow } from "./tasks";

export const MERGER_BASE = (process.env.MERGER_API_BASE || "https://dmg1.vercel.app")
  .trim()
  .replace(/\/+$/, "");

export const MERGER_MODEL = "video-merger";

/** أنواع نتائج runMerge — نفس منطق runGeneration لكن بدون مفاتيح API */
export type MergeOutcome =
  | { kind: "completed"; task: TaskRow }
  | { kind: "processing"; task: TaskRow }
  | { kind: "failed"; task: TaskRow }
  | { kind: "invalid"; reason: string };

export interface MergeJobStatus {
  status: "processing" | "completed" | "failed";
  progress: number; // 0..100
  resultUrls: string[];
  error?: string;
}

/** خطأ معلن من خدمة الدمج نفسها (HTTP 4xx/5xx) — حتمي: تكرار المحاولة يعطي النتيجة نفسها */
export class MergerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MergerError";
    this.status = status;
  }
}

const HTTP_TIMEOUT_MS = 30_000;
/** مهلة خطوة process (الخدمة تعلن أنها تستغرق ~10–15 ثانية؛ نترك هامشًا للتنزيل والترميز) */
const PROCESS_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 3_000;

/* ─────────────────────────── مساعدات تحليل دفاعية ─────────────────────────── */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** استخراج معرّف المهمة من استجابة POST /api/jobs بأي صيغة معقولة (مُصدَّر للاختبار) */
export function extractJobId(data: unknown): string | undefined {
  if (typeof data === "string" && data.trim()) return data.trim(); // بعض الخدمات تعيد النص مجردًا
  if (!isObj(data)) return undefined;
  const inner = isObj(data.job) ? data.job : isObj(data.data) ? data.data : data;
  return pickStr(inner.jobId, inner.job_id, inner.id, inner.uuid) ?? undefined;
}

/** تحليل حالة المهمة من استجابة GET /api/jobs/{id} بأي صيغة معقولة (مُصدَّر للاختبار) */
export function parseJobStatus(data: unknown): MergeJobStatus {
  const root = isObj(data) ? data : {};
  const job = isObj(root.job) ? root.job : isObj(root.data) ? root.data : root;

  const statusRaw = (pickStr(job.status, job.state, root.status, root.state) ?? "").toLowerCase();
  const completed = ["done", "completed", "complete", "success", "succeeded", "finished"].includes(statusRaw);
  const failed = ["error", "failed", "failure", "cancelled", "canceled"].includes(statusRaw);

  const err =
    pickStr(job.error, root.error) ??
    (typeof job.detail === "string" ? job.detail : undefined) ??
    (typeof root.detail === "string" ? root.detail : undefined) ??
    (isObj(job.error) ? pickStr((job.error as Record<string, unknown>).message) : undefined);

  // ملاحظة موثقة من الخدمة: قد يرد الجسم فيه error بلا حقل status → فشل فورًا
  const noStatusButError = !statusRaw && Boolean(err);

  let progress = Number(job.progress ?? job.percent ?? root.progress ?? root.percent ?? 0);
  if (!Number.isFinite(progress) || progress < 0) progress = 0;
  if (progress > 0 && progress <= 1) progress *= 100; // بعض الاستجابات تعيد كسرًا 0..1
  if (completed) progress = 100;
  if (failed || noStatusButError) progress = 100; // المهمة الفاشلة تُعرض مكتملة النسبة مع سبب الخطأ

  // رابط النتيجة: فضّل videoUrl ثم downloadUrl المطلقين؛ وإن غابا وبقي المعرّف
  // فاضبط الرابط على نقطة /video المعروفة للخدمة العامة
  const jobId = pickStr(job.jobId, job.job_id, root.jobId, root.job_id, root.id);
  const directUrl =
    pickStr(job.videoUrl, job.video_url, job.downloadUrl, job.download_url, root.videoUrl, root.downloadUrl) ?? undefined;

  let url: string | undefined;
  if (directUrl && /^https?:\/\//i.test(directUrl)) {
    url = directUrl;
  } else if (jobId) {
    url = `${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}/video`;
  }

  return {
    status: completed ? "completed" : failed || noStatusButError ? "failed" : "processing",
    progress: Math.round(progress),
    resultUrls: completed && url ? [url] : [],
    ...(err ? { error: err } : {}),
  };
}

/* ─────────────────────────── نداءات REST ─────────────────────────── */

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = HTTP_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch { /* نص غير JSON — نمرره كما هو */ }
  if (!res.ok) {
    const msg =
      pickStr(
        isObj(body) ? (body.error as string) : undefined,
        isObj(body) ? (body.detail as string) : undefined,
        isObj(body) ? (body.message as string) : undefined,
        typeof body === "string" ? body : undefined
      ) || res.statusText;
    throw new MergerError(res.status, `خدمة الدمج ردّت ${res.status}${msg ? `: ${String(msg).slice(0, 300)}` : ""}`);
  }
  return body;
}

/** فحص جهوزية خدمة الدمج (يُستخدم في /api/health) */
export async function mergerHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${MERGER_BASE}/api/config`, { signal: AbortSignal.timeout(4_000), cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

/** إنشاء مهمة دمج جديدة لدى الخدمة — يعيد jobId */
export async function createMergeJob(urls: string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error("aborted");
  const body = await fetchJson(`${MERGER_BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: urls }),
  });
  const jobId = extractJobId(body);
  if (!jobId) throw new Error(`استجابة غير متوقعة من خدمة الدمج عند إنشاء المهمة: ${JSON.stringify(body).slice(0, 300)}`);
  return jobId;
}

/** الاستعلام عن حالة مهمة دمج */
export async function getMergeJob(jobId: string): Promise<MergeJobStatus> {
  const body = await fetchJson(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`);
  return parseJobStatus(body);
}

/* ─────────────────────── خطوة process (مرة واحدة لكل مهمة) ─────────────────────── */

/** قفل في الذاكرة: خطوة process تُنفَّذ مرة واحدة فقط في كل لحظة لكل مهمة */
const processInFlight = new Set<string>();

export type ProcessStepResult =
  | { kind: "done" }
  | { kind: "service-error"; message: string }
  | { kind: "transient"; message: string }
  | { kind: "skipped" };

/**
 * تنفيذ خطوة POST /api/jobs/{id}/process — قلب الخدمة v2:
 * إنشاء المهمة يضعها في قائمة الانتظار فقط، وهذه الخطوة تنفّذ الدمج فعليًا.
 * - خطأ معلن من الخدمة (4xx/5xx) → service-error (حتمي — فشل نهائي).
 * - خطأ شبكتنا نحن → transient (مؤقت — يستمر التتبع وتُعاد الخطوة عند get_task).
 */
async function runProcessStep(jobId: string, signal?: AbortSignal): Promise<ProcessStepResult> {
  if (processInFlight.has(jobId)) return { kind: "skipped" };
  processInFlight.add(jobId);
  try {
    if (signal?.aborted) return { kind: "transient", message: "aborted" };
    await fetchJson(
      `${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}/process`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      PROCESS_TIMEOUT_MS
    );
    return { kind: "done" };
  } catch (err) {
    if (err instanceof MergerError) return { kind: "service-error", message: err.message };
    return { kind: "transient", message: err instanceof Error ? err.message : String(err) };
  } finally {
    processInFlight.delete(jobId);
  }
}

/* ─────────────────────────── التدفق الكامل ─────────────────────────── */

export interface MergeArgs {
  urls: string[];
  waitSeconds: number;
  onProgress?: (info: { progress: number; total: number; message: string; percent?: number; taskId?: string }) => Promise<void> | void;
  signal?: AbortSignal;
}

/** تقدير مدة الدمج الكلية بالثواني (لنسب التقدم أثناء الانتظار) */
function estimateMergeSeconds(urls: string[]): number {
  return Math.max(30, 15 + urls.length * 8);
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch { /* تجاهل أخطاء الحفظ الثانوية */ }
}

/**
 * تنفيذ عملية دمج كاملة: إنشاء المهمة في Turso → إرسال الروابط للخدمة →
 * خطوة process → المتابعة مع إشعارات تقدم → تخزين رابط الفيديو النهائي عند الاكتمال.
 */
export async function runMerge(args: MergeArgs): Promise<MergeOutcome> {
  // 1) تحقق صارم من المعطيات — أخطاء المعطيات توقف فورًا
  const urls = args.urls.map((u) => u.trim()).filter(Boolean);
  if (urls.length < 2) {
    return { kind: "invalid", reason: "الدمج يحتاج رابطَي فيديو على الأقل (min 2 urls)" };
  }
  const bad = urls.filter((u) => !/^https?:\/\//i.test(u));
  if (bad.length) {
    return { kind: "invalid", reason: `كل الروابط يجب أن تكون روابط http/https مباشرة وعامة. غير صالح: ${bad.slice(0, 3).join(" ، ")}` };
  }
  if (urls.length > 10) {
    return { kind: "invalid", reason: "أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)" };
  }

  // 2) تسجيل المهمة في Turso أولًا (قابلة للتتبع حتى لو فشل الاتصال بالخدمة)
  const prompt = `دمج ${urls.length} مقاطع فيديو في مقطع واحد`;
  let task = await insertTask({
    provider: "merger",
    providerTaskId: null,
    keyId: null,
    model: MERGER_MODEL,
    type: "merge",
    prompt,
    params: { urls },
    status: "pending",
    progress: 0,
  });

  // 3) إنشاء المهمة لدى خدمة الدمج
  let jobId: string;
  try {
    jobId = await createMergeJob(urls, args.signal);
  } catch (err) {
    if (err instanceof MergerError) {
      // الخدمة رفضت صراحةً (مصدر كبير/مرفوض…) — فشل حتمي
      task = (await updateTask(task.id, { status: "failed", progress: 100, errorMessage: err.message })) ?? task;
      return { kind: "failed", task };
    }
    // خطأ شبكة لدينا — المهمة تبقى قيد المعالجة وتُعاد إنشاؤها تلقائيًا مع get_task
    const msg = err instanceof Error ? err.message : String(err);
    task = (await updateTask(task.id, {
      status: "processing",
      progress: 0,
      errorMessage: `تعذّر الاتصال بخدمة الدمج مؤقتًا: ${msg} — تُعاد المحاولة تلقائيًا مع المتابعة`,
    })) ?? task;
    return { kind: "processing", task };
  }

  task = (await updateTask(task.id, { providerTaskId: jobId, status: "processing", progress: 5 })) ?? task;
  const total = estimateMergeSeconds(urls);
  const startedAt = Date.now();

  await args.onProgress?.({
    progress: 0,
    total,
    percent: 5,
    message: `قُبلت مهمة الدمج في الخدمة — جارٍ دمج ${urls.length} مقاطع…`,
    taskId: task.id,
  });

  // 4) خطوة process مرة واحدة (تستغرق ~10–15 ثانية عند الخدمة)
  const step = await runProcessStep(jobId, args.signal);
  if (step.kind === "service-error") {
    task = (await updateTask(task.id, { status: "failed", progress: 100, errorMessage: step.message })) ?? task;
    return { kind: "failed", task };
  }
  // transient/skipped → نكمل التتبع؛ get_task سيعيد الخطوة لاحقًا إن لزم

  // 5) المتابعة حتى نهاية نافذة الانتظار (الدمج سريع عادةً: ثوانٍ إلى دقيقتين)
  const deadline = startedAt + args.waitSeconds * 1000;
  while (Date.now() < deadline) {
    if (args.signal?.aborted) return { kind: "processing", task };
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (args.signal?.aborted) return { kind: "processing", task };

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    try {
      const st = await getMergeJob(jobId);
      task = (await updateTask(task.id, {
        status: st.status === "completed" ? "completed" : st.status === "failed" ? "failed" : "processing",
        progress: st.progress,
        resultUrls: st.resultUrls.length ? st.resultUrls : undefined,
        errorMessage: st.error ?? null,
      })) ?? task;

      if (st.status === "completed") {
        if (!task.resultUrls.length) {
          task = (await updateTask(task.id, {
            status: "failed",
            progress: 100,
            errorMessage: "الخدمة أعلنت الاكتمال لكنها لم تُرجع رابط الفيديو النهائي",
          })) ?? task;
          return { kind: "failed", task };
        }
        await args.onProgress?.({ progress: elapsed, total, percent: 100, message: "تم الدمج بنجاح ✓", taskId: task.id });
        return { kind: "completed", task };
      }
      if (st.status === "failed") {
        return { kind: "failed", task };
      }
      await args.onProgress?.({
        progress: elapsed,
        total,
        percent: Math.max(3, Math.min(95, st.progress)),
        message: "قيد الدمج…", // النسبة تُلحق تلقائيًا بواسطة طبقة MCP
        taskId: task.id,
      });
    } catch (err) {
      if (err instanceof MergerError) {
        // 404 (حُذفت المهمة) أو خطأ آخر معلن من الخدمة أثناء التتبع — نثبته كفشل نهائي
        task = (await updateTask(task.id, { status: "failed", progress: 100, errorMessage: err.message })) ?? task;
        return { kind: "failed", task };
      }
      // تعذّر استعلام مؤقت (شبكتنا) — نُعيد المحاولة حتى انتهاء المهلة
      const msg = err instanceof Error ? err.message : String(err);
      await args.onProgress?.({ progress: elapsed, total, message: `تعذّر الاستعلام مؤقتًا: ${msg}`, taskId: task.id });
    }
  }

  return { kind: "processing", task };
}

/**
 * تحديث حي لمهمة دمج من الخدمة — تستخدمه get_task عند provider = "merger":
 * - بلا jobId بعد → تُعاد محاولة الإنشاء تلقائيًا (خطأ شبكة سابق).
 * - queued ولم تُنفَّذ process → تُنفَّذ الآن (مرة واحدة بقفل processInFlight).
 * - 404 من الخدمة → فشل نهائي (حُذفت المهمة أو انتهت صلاحيتها بعد 24 ساعة).
 */
export async function refreshMergeTask(task: TaskRow): Promise<TaskRow> {
  // مهمة لم تُنشأ لدى الخدمة بعد (فشل شبكة عند الإنشاء) → أعد الإنشاء الآن
  if (!task.providerTaskId) {
    let urls: string[] = [];
    try {
      const p = JSON.parse(task.paramsJson || "{}") as { urls?: unknown };
      if (Array.isArray(p.urls)) urls = p.urls.filter((u): u is string => typeof u === "string");
    } catch { /* تجاهل */ }
    if (urls.length < 2) {
      return (await updateTask(task.id, { status: "failed", progress: 100, errorMessage: "روابط الدمج مفقودة من سجل المهمة" })) ?? task;
    }
    try {
      const jobId = await createMergeJob(urls);
      task = (await updateTask(task.id, { providerTaskId: jobId, status: "processing", progress: 5, errorMessage: null })) ?? task;
    } catch (err) {
      if (err instanceof MergerError) {
        return (await updateTask(task.id, { status: "failed", progress: 100, errorMessage: err.message })) ?? task;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return (await updateTask(task.id, { errorMessage: `تعذّر الاتصال بخدمة الدمج مؤقتًا: ${msg} — تُعاد المحاولة تلقائيًا` })) ?? task;
    }
  }

  const jobId = task.providerTaskId!;
  try {
    let st = await getMergeJob(jobId);

    // queued = خطوة process لم تُنفَّذ/لم تكتمل بعد → نفّذها الآن (القفل يمنع التزامن)
    if (st.status === "processing" && st.progress === 0) {
      const step = await runProcessStep(jobId);
      if (step.kind === "service-error") {
        return (await updateTask(task.id, { status: "failed", progress: 100, errorMessage: step.message })) ?? task;
      }
      st = await getMergeJob(jobId);
    }

    return (
      (await updateTask(task.id, {
        status: st.status === "completed" ? "completed" : st.status === "failed" ? "failed" : "processing",
        progress: st.progress,
        resultUrls: st.resultUrls.length ? st.resultUrls : undefined,
        errorMessage: st.error ?? null,
      })) ?? task
    );
  } catch (err) {
    if (err instanceof MergerError && err.status === 404) {
      return (
        (await updateTask(task.id, {
          status: "failed",
          progress: 100,
          errorMessage: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة) — أعد عملية الدمج",
        })) ?? task
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return (await updateTask(task.id, { errorMessage: `تعذّر التحديث من خدمة الدمج: ${message}` })) ?? task;
  }
}
