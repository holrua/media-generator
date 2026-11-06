/**
 * عميل خدمة دمج الفيديوهات (Video Merger API)
 *
 * دمج عدة مقاطع فيديو في مقطع واحد عالي الجودة — دون تنزيل أي وسائط على هذا السيرفر:
 * نرسل روابط الفيديوهات للخدمة، نتابع حالة المهمة، وعند الاكتمال نخزّن رابط
 * الفيديو النهائي في Turso (مثل بقية المهام تمامًا).
 *
 * REST (عنوان الخدمة MERGER_API_BASE):
 *   POST /api/jobs                  {urls:[...], resolution?, fps?, auto_start?} → {job_id}
 *   GET  /api/jobs/{job_id}         الحالة والنسبة — حتى status = done | error
 *   GET  /api/jobs/{job_id}/download  الفيديو النهائي (أو result.file_url المباشر)
 *   GET  /api/health                فحص الجهوزية
 *
 * التحليل هنا دفاعي: الحقول تقبل أسماءً بديلة (job_id|id، progress|percent،
 * result.file_url|download_path…) لأن مخطط Swagger للخدمة غير مفصّل.
 */
import { insertTask, updateTask, type TaskRow } from "./tasks";

export const MERGER_BASE = (process.env.MERGER_API_BASE || "https://preview-chat-2263d573-4119-4428-acc3-b8916911b923.space-z.ai")
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

const HTTP_TIMEOUT_MS = 30_000;
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

function toAbsoluteUrl(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) return v; // رابط مطلق جاهز
  if (v.startsWith("/")) return `${base}${v}`; // مسار نسبي (download_path)
  return undefined;
}

/** استخراج معرّف المهمة من استجابة POST /api/jobs بأي صيغة معقولة (مُصدَّر للاختبار) */
export function extractJobId(data: unknown): string | undefined {
  if (typeof data === "string" && data.trim()) return data.trim(); // بعض الخدمات تعيد النص مجردًا
  if (!isObj(data)) return undefined;
  const inner = isObj(data.job) ? data.job : data;
  return pickStr(inner.job_id, inner.jobId, inner.id, inner.uuid) ?? undefined;
}

/** تحليل حالة المهمة من استجابة GET /api/jobs/{id} بأي صيغة معقولة (مُصدَّر للاختبار) */
export function parseJobStatus(data: unknown): MergeJobStatus {
  const root = isObj(data) ? data : {};
  const job = isObj(root.job) ? root.job : isObj(root.data) ? root.data : root;
  const result = isObj(job.result) ? job.result : isObj(root.result) ? root.result : {};

  const statusRaw = (pickStr(job.status, job.state, root.status, root.state) ?? "").toLowerCase();
  const completed = ["done", "completed", "complete", "success", "succeeded", "finished"].includes(statusRaw);
  const failed = ["error", "failed", "failure", "cancelled", "canceled"].includes(statusRaw);

  let progress = Number(job.progress ?? job.percent ?? root.progress ?? root.percent ?? 0);
  if (!Number.isFinite(progress) || progress < 0) progress = 0;
  if (progress > 0 && progress <= 1) progress *= 100; // بعض الخدمات تعيد كسرًا 0..1
  if (completed) progress = 100;
  if (failed) progress = Math.max(progress, 100);

  // رابط النتيجة — الأهم: نفضّل المسارات النسبية مسبوقة بعنوان الخدمة العام (MERGER_BASE)
  // لأن الحقول المطلقة من الخدمة (download_url / result.file_url) قد تشير لسيرفر داخلي
  // غير متاح للإنترنت العام (كما جرى التحقق عمليًا مع نطاق fcapp.run الداخلي).
  // الترتيب: download_path النسبي ← /files/{job_id}/{filename} ← أي رابط مطلق كحل أخير.
  const jobId = pickStr(job.job_id, job.id, root.job_id, root.id);
  const relPath =
    pickStr(job.download_path, job.downloadPath, result.download_path, result.downloadPath, root.download_path) ?? undefined;
  const absUrl =
    pickStr(result.file_url, result.fileUrl, job.download_url, job.file_url, job.result_url, root.download_url, root.file_url) ??
    undefined;
  const filename = pickStr(result.filename, job.filename) ?? undefined;

  let url: string | undefined;
  if (relPath && relPath.trim()) {
    url = `${MERGER_BASE}${relPath.trim().startsWith("/") ? "" : "/"}${relPath.trim()}`;
  } else if (jobId && filename) {
    url = `${MERGER_BASE}/files/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}`;
  } else {
    url = toAbsoluteUrl(absUrl, MERGER_BASE);
  }

  const err =
    pickStr(job.error, root.error) ??
    (typeof job.detail === "string" ? job.detail : undefined) ??
    (typeof root.detail === "string" ? root.detail : undefined) ??
    (isObj(job.error) ? pickStr((job.error as Record<string, unknown>).message) : undefined);

  return {
    status: completed ? "completed" : failed ? "failed" : "processing",
    progress: Math.round(progress),
    resultUrls: completed && url ? [url] : [],
    ...(err ? { error: err } : {}),
  };
}

/* ─────────────────────────── نداءات REST ─────────────────────────── */

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch { /* نص غير JSON — نمرره كما هو */ }
  if (!res.ok) {
    const msg = pickStr(
      isObj(body) ? (body.detail as string) : undefined,
      isObj(body) ? (body.error as string) : undefined,
      typeof body === "string" ? body : undefined
    );
    throw new Error(`خدمة الدمج ردّت ${res.status}${msg ? `: ${msg.slice(0, 300)}` : ""}`);
  }
  return body;
}

/** فحص جهوزية خدمة الدمج (يُستخدم في /api/health) */
export async function mergerHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${MERGER_BASE}/api/health`, { signal: AbortSignal.timeout(4_000), cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

/** إنشاء مهمة دمج جديدة — يعيد job_id */
export async function createMergeJob(
  opts: { urls: string[]; resolution: string; fps: number },
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) throw new Error("aborted");
  const body = await fetchJson(`${MERGER_BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: opts.urls, resolution: opts.resolution, fps: opts.fps, auto_start: true }),
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

/* ─────────────────────────── التدفق الكامل ─────────────────────────── */

export interface MergeArgs {
  urls: string[];
  resolution: string;
  fps: number;
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
 * المتابعة مع إشعارات تقدم → تخزين رابط الفيديو النهائي عند الاكتمال.
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
  if (urls.length > 20) {
    return { kind: "invalid", reason: "أقصى عدد مقاطع للدمج هو 20" };
  }

  // 2) تسجيل المهمة في Turso أولًا (قابلة للتتبع حتى لو فشل الاتصال بالخدمة)
  const prompt = `دمج ${urls.length} مقاطع فيديو — ${args.resolution} @ ${args.fps}fps`;
  let task = await insertTask({
    provider: "merger",
    providerTaskId: null,
    keyId: null,
    model: MERGER_MODEL,
    type: "merge",
    prompt,
    params: { urls, resolution: args.resolution, fps: args.fps },
    status: "pending",
    progress: 0,
  });

  // 3) إنشاء المهمة لدى خدمة الدمج
  let jobId: string;
  try {
    jobId = await createMergeJob({ urls, resolution: args.resolution, fps: args.fps }, args.signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    task = (await updateTask(task.id, { status: "failed", progress: 100, errorMessage: `فشل إنشاء مهمة الدمج: ${msg}` })) ?? task;
    return { kind: "failed", task };
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

  // 4) المتابعة حتى نهاية نافذة الانتظار (merge سريع عادةً: ثوانٍ إلى دقيقتين)
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
      // تعذّر استعلام مؤقت: نُعيد المحاولة حتى انتهاء المهلة
      const msg = err instanceof Error ? err.message : String(err);
      await args.onProgress?.({ progress: elapsed, total, message: `تعذّر الاستعلام مؤقتًا: ${msg}`, taskId: task.id });
    }
  }

  return { kind: "processing", task };
}

/**
 * تحديث حي لمهمة دمج من الخدمة — تستخدمه get_task عند provider = "merger"
 * (تماماً كما يستعلم refreshTask عن المهام لدى kie/CometAPI).
 */
export async function refreshMergeTask(task: TaskRow): Promise<TaskRow> {
  if (!task.providerTaskId) return task;
  try {
    const st = await getMergeJob(task.providerTaskId);
    return (
      (await updateTask(task.id, {
        status: st.status === "completed" ? "completed" : st.status === "failed" ? "failed" : "processing",
        progress: st.progress,
        resultUrls: st.resultUrls.length ? st.resultUrls : undefined,
        errorMessage: st.error ?? null,
      })) ?? task
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return (await updateTask(task.id, { errorMessage: `تعذّر التحديث من خدمة الدمج: ${message}` })) ?? task;
  }
}
