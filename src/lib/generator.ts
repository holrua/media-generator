/**
 * منسّق التوليد: يجمع المفاتيح النشطة (الأقل استخدامًا أولًا) ويجرّبها بالترتيب،
 * ويصنّف الأخطاء ويحدّث حالة المفاتيح تلقائيًا، ويخزّن كل مهمة وروابطها في Turso.
 * أثناء الانتظار يرسل Progress notifications للعميل عبر onProgress.
 */
import { MODELS, findModel, type MediaType, type ModelDef } from "./models";
import { kieAdapter } from "./providers/kie";
import { cometApiAdapter } from "./providers/cometapi";
import { ProviderError, type ProviderAdapter } from "./providers/base";
import {
  CLASS_MESSAGES,
  classifyProviderError,
  getKeyPool,
  getKey,
  maskKey,
  recordKeyOutcome,
  setKeyStatus,
  touchKeyUsage,
  type ApiKeyRow,
} from "./keys";
import { getTask, insertTask, updateTask, type TaskRow } from "./tasks";
import { refreshMergeTask } from "./merger";

export const adapters: Record<"kie" | "cometapi", ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometApiAdapter,
};

export interface ProgressInfo {
  /** ثوانٍ منقضية أو نسبة مئوية حسب السياق */
  progress: number;
  /** إجمالي تقديري لنفس الوحدة */
  total: number;
  message: string;
  percent?: number;
  taskId?: string;
}

export type ProgressCb = (info: ProgressInfo) => Promise<void> | void;

export interface GenerationArgs {
  type: MediaType;
  model?: string;
  prompt: string;
  imageUrl?: string;
  aspectRatio?: string;
  resolution?: string;
  background?: string;
  outputFormat?: string;
  duration?: number;
  enableAudio?: boolean;
  waitSeconds: number;
  onProgress?: ProgressCb;
  signal?: AbortSignal;
}

export type GenerationOutcome =
  | { kind: "completed"; task: TaskRow }
  | { kind: "processing"; task: TaskRow }
  | { kind: "failed"; task: TaskRow }
  | { kind: "invalid"; reason: string }
  | { kind: "no_keys"; model: string };

const POLL_INTERVAL_MS = 3_000;

function estimateTotalSeconds(type: MediaType, duration?: number): number {
  if (type === "image") return 60;
  return (duration ?? 8) * 8 + 60; // فيديو: تقدير تقريبي
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch { /* تجاهل أخطاء الحفظ الثانوية */ }
}

async function persistAttempt(taskId: string, attempt: TaskRow["attempts"][number]) {
  await safe(() => updateTask(taskId, { appendAttempt: attempt }));
}

async function pollUntilDone(
  task: TaskRow,
  key: ApiKeyRow,
  opts: { waitSeconds: number; startedAt: number; onProgress?: ProgressCb; signal?: AbortSignal }
): Promise<GenerationOutcome> {
  const adapter = adapters[task.provider as "kie" | "cometapi"];
  const total = estimateTotalSeconds(task.type, (JSON.parse(task.paramsJson) as { duration?: number }).duration);
  const deadline = opts.startedAt + opts.waitSeconds * 1000;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return { kind: "processing", task };
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (opts.signal?.aborted) return { kind: "processing", task };

    const elapsed = Math.round((Date.now() - opts.startedAt) / 1000);
    try {
      const status = await adapter.getTaskStatus(key.apiKey, task.providerTaskId!, task.type, opts.signal);
      const updated = await updateTask(task.id, {
        status: status.status === "completed" ? "completed" : status.status === "failed" ? "failed" : "processing",
        progress: status.progress,
        resultUrls: status.urls.length ? status.urls : undefined,
        errorMessage: status.error ?? null,
      });

      if (status.status === "completed") {
        await safe(() => recordKeyOutcome(key.id, true));
        if (!updated || updated.resultUrls.length === 0) {
          const failed = await updateTask(task.id, {
            status: "failed",
            progress: 100,
            errorMessage: "المزود أعلن النجاح لكنه لم يُرجع أي رابط نتيجة",
          });
          await safe(() => recordKeyOutcome(key.id, false, "no result urls"));
          return { kind: "failed", task: failed! };
        }
        await opts.onProgress?.({ progress: elapsed, total, percent: 100, message: "تم التوليد بنجاح ✓", taskId: task.id });
        return { kind: "completed", task: updated! };
      }
      if (status.status === "failed") {
        await safe(() => recordKeyOutcome(key.id, false, status.error));
        return { kind: "failed", task: updated! };
      }
      await opts.onProgress?.({
        progress: elapsed,
        total,
        percent: Math.max(3, Math.min(95, status.progress)),
        message: `قيد المعالجة عند ${task.provider} (${status.progress}%)`,
        taskId: task.id,
      });
    } catch (err) {
      // أخطاء الاستعلام أثناء الانتظار: نُعيد المحاولة حتى انتهاء المهلة (لا نغيّر حالة المفتاح)
      const msg = err instanceof Error ? err.message : String(err);
      await opts.onProgress?.({ progress: elapsed, total, percent: undefined, message: `تعذّر الاستعلام مؤقتًا: ${msg}`, taskId: task.id });
    }
  }
  const latest = await getTask(task.id);
  return { kind: "processing", task: latest ?? task };
}

export async function runGeneration(args: GenerationArgs): Promise<GenerationOutcome> {
  // 1) التحقق من المعطيات — أخطاء المعطيات توقف فورًا قبل لمس أي مفتاح
  const def: ModelDef | null = findModel(args.model ?? (args.type === "image" ? MODELS[0].canonical : MODELS[1].canonical));
  if (!def || def.type !== args.type) {
    return { kind: "invalid", reason: `موديل غير معروف أو لا يطابق نوع الطلب. المتاح: ${MODELS.map((m) => m.canonical).join(" ، ")}` };
  }
  if (!args.prompt || !args.prompt.trim()) {
    return { kind: "invalid", reason: "الوصف (prompt) مطلوب ولا يمكن أن يكون فارغًا" };
  }
  if (args.type === "video" && args.prompt.length > 4096) {
    return { kind: "invalid", reason: "وصف الفيديو يجب أن يكون 4096 حرفًا كحد أقصى" };
  }

  // 2) تجميع المفاتيح النشطة — الأقل استخدامًا أولًا
  const pool = await getKeyPool(def.providers);
  if (pool.length === 0) {
    return { kind: "no_keys", model: def.canonical };
  }

  const params: Record<string, unknown> = {
    aspect_ratio: args.aspectRatio,
    resolution: args.resolution,
    background: args.background,
    output_format: args.outputFormat,
    duration: args.duration,
    enable_audio: args.enableAudio,
    image_url: args.imageUrl,
    wait_seconds: args.waitSeconds,
  };
  const startedAt = Date.now();
  const attempts: TaskRow["attempts"] = [];
  const totalKeys = pool.length;

  for (let i = 0; i < pool.length; i++) {
    const key = pool[i];
    await safe(() => touchKeyUsage(key.id));
    const label = key.label || maskKey(key.apiKey);
    await args.onProgress?.({
      progress: i,
      total: totalKeys,
      message: `تجربة المفتاح ${i + 1} من ${totalKeys} (${key.provider})`,
    });

    const adapter = adapters[key.provider];
    try {
      let task: TaskRow;

      if (args.type === "image" && adapter.createImageSync) {
        // مزود صور متزامن (CometAPI): النتيجة تعود مع الاستجابة نفسها
        const status = await adapter.createImageSync(key.apiKey, def.providerModel[key.provider], {
          prompt: args.prompt,
          aspect_ratio: args.aspectRatio,
          resolution: args.resolution,
          background: args.background,
          output_format: args.outputFormat,
        }, args.signal);
        task = await insertTask({
          provider: key.provider,
          providerTaskId: null,
          keyId: key.id,
          model: def.canonical,
          type: "image",
          prompt: args.prompt,
          params,
          status: status.status === "failed" ? "failed" : "completed",
          resultUrls: status.urls,
          errorMessage: status.error ?? null,
          attempts: [{ provider: key.provider, keyId: key.id, keyLabel: label, ok: true, at: new Date().toISOString() }],
        });
        await safe(() => recordKeyOutcome(key.id, status.status !== "failed", status.error));
        if (status.status === "failed") return { kind: "failed", task };
        await args.onProgress?.({ progress: 1, total: 1, percent: 100, message: "تم التوليد بنجاح ✓", taskId: task.id });
        return { kind: "completed", task };
      }

      // مسار المهام غير المتزامنة (kie.ai / فيديو CometAPI)
      const created = args.type === "image"
        ? await adapter.createImageTask(key.apiKey, def.providerModel[key.provider], {
            prompt: args.prompt,
            aspect_ratio: args.aspectRatio,
            resolution: args.resolution,
            background: args.background,
            output_format: args.outputFormat,
          }, args.signal)
        : await adapter.createVideoTask(key.apiKey, def.providerModel[key.provider], {
            prompt: args.prompt,
            image_url: args.imageUrl,
            aspect_ratio: args.aspectRatio,
            resolution: args.resolution,
            duration: args.duration,
            enable_audio: args.enableAudio,
          }, args.signal);

      task = await insertTask({
        provider: key.provider,
        providerTaskId: created.providerTaskId,
        keyId: key.id,
        model: def.canonical,
        type: args.type,
        prompt: args.prompt,
        params,
        status: "processing",
        progress: 5,
        attempts: [{ provider: key.provider, keyId: key.id, keyLabel: label, ok: true, at: new Date().toISOString() }],
      });
      await args.onProgress?.({
        progress: 0,
        total: estimateTotalSeconds(args.type, args.duration),
        percent: 5,
        message: `قُبل الطلب في ${key.provider} — جارٍ التوليد…`,
        taskId: task.id,
      });
      return await pollUntilDone(task, key, { waitSeconds: args.waitSeconds, startedAt, onProgress: args.onProgress, signal: args.signal });
    } catch (err) {
      const { cls, status, message } = classifyProviderError(err);
      attempts.push({
        provider: key.provider,
        keyId: key.id,
        keyLabel: label,
        ok: false,
        errorClass: cls,
        error: `[${status || "network"}] ${message}`,
        at: new Date().toISOString(),
      });
      await safe(() => recordKeyOutcome(key.id, false, `${CLASS_MESSAGES[cls]} — ${message}`));
      if (cls === "disabled") await safe(() => setKeyStatus(key.id, "disabled", message));
      if (cls === "exhausted") await safe(() => setKeyStatus(key.id, "exhausted", message));
      // params → إيقاف فوري (تبديل المفاتيح لن يحل مشكلة المعطيات)
      if (cls === "params") break;
      // temporary / provider → الانتقال للمفتاح التالي في نفس العملية
    }
  }

  // 3) فشلت كل المفاتيح — نخزن مهمة فاشلة بتفاصيل كل محاولة
  const failed = await insertTask({
    provider: null,
    providerTaskId: null,
    keyId: null,
    model: def.canonical,
    type: args.type,
    prompt: args.prompt,
    params,
    status: "failed",
    errorMessage: `فشلت كل المحاولات (${attempts.length} مفتاحًا)`,
    attempts,
  });
  return { kind: "failed", task: failed };
}

/** تحديث حي لحالة المهمة من المزود ثم من قاعدة البيانات — تستخدمه get_task */
export async function refreshTask(taskId: string, signal?: AbortSignal): Promise<TaskRow | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  // مهام الدمج: تُتابَع لدى خدمة Video Merger (بلا مفاتيح)
  if (task.provider === "merger") return refreshMergeTask(task);

  if (!task.provider || !task.providerTaskId || task.providerTaskId.startsWith("sync-")) return task;

  const key = task.keyId ? await getKey(task.keyId) : null;
  if (!key) {
    return updateTask(task.id, {
      status: "failed",
      progress: 100,
      errorMessage: task.keyId
        ? "لا يمكن متابعة المتابعة: حُذف المفتاح المستخدم في هذه المهمة"
        : "لا يمكن متابعة المتابعة: لا يوجد مفتاح مرتبط بهذه المهمة (فشلت محاولات الإنشاء)",
    });
  }
  try {
    const status = await adapters[task.provider].getTaskStatus(key.apiKey, task.providerTaskId, task.type, signal);
    return await updateTask(task.id, {
      status: status.status === "completed" ? "completed" : status.status === "failed" ? "failed" : "processing",
      progress: status.progress,
      resultUrls: status.urls.length ? status.urls : undefined,
      errorMessage: status.error ?? null,
    });
  } catch (err) {
    // لا نغيّر حالة المفتاح هنا — مجرد تعذّر استعلام مؤقت
    const message = err instanceof ProviderError ? err.message : String(err);
    return updateTask(task.id, { errorMessage: `تعذّر التحديث من المزود: ${message}` });
  }
}

/** تنسيق المهمة كنص للعميل (يُعرض داخل الدردشة ويوجه النموذج للخطوة التالية) */
export function renderTaskForClient(task: TaskRow, opts: { forTool?: "get_task" | "generation" } = {}): string {
  const lines: string[] = [];
  const labelEn = task.type === "image" ? "Image" : task.type === "merge" ? "Merged video" : "Video";
  if (task.status === "completed") {
    lines.push(`✅ ${labelEn} ready! (task_id: ${task.id})`);
    for (const url of task.resultUrls) {
      if (task.type === "image") lines.push(`![generated image](${url})`);
      else lines.push(`▶️ [Watch / download the video](${url})`);
    }
    if (task.provider) lines.push(`provider: ${task.provider} — model: ${task.model}`);
    lines.push(`أظهر الرابط أعلاه للمستخدم مباشرة.`);
    return lines.join("\n");
  }
  if (task.status === "failed") {
    lines.push(`❌ ${labelEn} generation FAILED (task_id: ${task.id})`);
    if (task.errorMessage) lines.push(`reason: ${task.errorMessage}`);
    const fails = task.attempts.filter((a) => !a.ok);
    if (fails.length) {
      lines.push("attempts:");
      for (const a of fails) lines.push(`- [${a.provider}] (${a.errorClass}) ${a.error}`);
    }
    lines.push(
      task.type === "merge"
        ? `أخبر المستخدم بالتفاصيل أعلاه.`
        : `أخبر المستخدم بالتفاصيل أعلاه. ملاحظة: مفاتيح خلص رصيدها تُنشَّط من الواجهة بعد الشحن.`
    );
    return lines.join("\n");
  }
  // pending / processing
  lines.push(`⏳ ${labelEn} task is ${task.status.toUpperCase()} (task_id: ${task.id})`);
  lines.push(`provider: ${task.provider ?? "?"} — model: ${task.model} — progress: ${task.progress}%`);
  lines.push(`➡️ Call get_task with task_id="${task.id}" every ~10 seconds until status becomes "completed", then show the result URL to the user and stop polling.`);
  return lines.join("\n");
}
