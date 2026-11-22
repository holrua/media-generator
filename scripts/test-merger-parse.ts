/**
 * اختبار وحدة لمحلل استجابات خدمة الدمج v2 (parseJobStatus / extractJobId)
 * يُشغَّل: bun scripts/test-merger-parse.ts
 * يغطي الأشكال الحقيقية المقاسة للخدمة (dmg1.vercel.app):
 *   POST /api/jobs → {jobId, status:"queued", statusUrl, processUrl, expiresAt}
 *   GET  /api/jobs/{id} → {status:"queued|done|failed", progress, videoUrl, downloadUrl, error}
 *   مع الصيغ الدفاعية (job_id|id، progress كسري، error بلا status، روابط نسبية…)
 */
import { parseJobStatus, extractJobId, MERGER_BASE, type MergeJobStatus } from "../src/lib/merger";

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

function expectStatus(name: string, data: unknown, want: Partial<MergeJobStatus>) {
  const got = parseJobStatus(data);
  check(
    name,
    got.status === want.status &&
      (want.progress === undefined || got.progress === want.progress) &&
      (want.resultUrls === undefined || JSON.stringify(got.resultUrls) === JSON.stringify(want.resultUrls)) &&
      (want.error === undefined || (got.error ?? "").includes(want.error)),
    `got ${JSON.stringify(got)}`
  );
}

console.log("1) extractJobId — صيغ مختلفة:");
check("jobId الموثق v2", extractJobId({ jobId: "wkucdefoxwvd", status: "queued" }) === "wkucdefoxwvd");
check("job_id بديل", extractJobId({ job_id: "abc-123" }) === "abc-123");
check("id بديل", extractJobId({ id: "xyz" }) === "xyz");
check("متداخل داخل job", extractJobId({ job: { jobId: "nested" } }) === "nested");
check("نص مجرد", extractJobId("plain-id") === "plain-id");
check("فارغ → undefined", extractJobId({}) === undefined);

console.log("2) الاستجابة الموثقة عند الإنشاء (queued):");
expectStatus("queued 0", { status: "queued", progress: 0 }, { status: "processing", progress: 0, resultUrls: [] });

console.log("3) الاستجابة الموثقة عند الاكتمال (status=done + videoUrl/downloadUrl):");
expectStatus(
  "done + videoUrl مطلق",
  {
    status: "done",
    progress: 100,
    videoUrl: `${MERGER_BASE}/api/jobs/j1/video`,
    downloadUrl: `${MERGER_BASE}/api/jobs/j1/video?download=1`,
    size: 1234567,
    duration: 30.2,
    resolution: "640x360",
  },
  { status: "completed", progress: 100, resultUrls: [`${MERGER_BASE}/api/jobs/j1/video`] }
);
{
  // downloadUrl له الأولوية الثانية — videoUrl أولًا
  const got = parseJobStatus({
    status: "done",
    videoUrl: `${MERGER_BASE}/api/jobs/j2/video`,
    downloadUrl: "https://cdn.example.com/alt.mp4",
  });
  check("videoUrl له الأولوية على downloadUrl", got.resultUrls[0] === `${MERGER_BASE}/api/jobs/j2/video`, got.resultUrls.join(","));
}

console.log("4) done بلا روابط صريحة → الرابط الاحتياطي /api/jobs/{id}/video:");
expectStatus(
  "done + jobId فقط",
  { job_id: "j3", status: "done", progress: 100 },
  { status: "completed", progress: 100, resultUrls: [`${MERGER_BASE}/api/jobs/j3/video`] }
);

console.log("5) التقدم الكسري 0..1 وأثناء المعالجة:");
expectStatus("processing 0.45 كسري", { status: "processing", progress: 0.45 }, { status: "processing", progress: 45 });
expectStatus("processing مئوي 62", { status: "processing", progress: 62 }, { status: "processing", progress: 62 });
expectStatus("بدون progress", { status: "queued" }, { status: "processing", progress: 0 });
check("الكسر الصغير 0.5 لا يُقبل إلا كسرًا", parseJobStatus({ status: "processing", progress: 50 }).progress === 50);

console.log("6) الفشل الحقيقي من خطوة process (HTTP 500 يُفكَّك قبل المرور هنا كـ error):");
expectStatus(
  "error + رسالة التحميل",
  { status: "failed", error: "Download failed (HTTP 403)" },
  { status: "failed", progress: 100, error: "Download failed" }
);
expectStatus(
  "error بلا status → فشل فورًا (موثق من الخدمة)",
  { error: "Download failed (HTTP 403)" },
  { status: "failed", error: "Download failed" }
);
expectStatus(
  "detail بدل error",
  { detail: "ffprobe failed: bad container" },
  { status: "failed", error: "ffprobe failed" }
);

console.log("7) صيغ بديلة (state بدل status، nesting داخل job/data):");
expectStatus("state=finished", { state: "finished", videoUrl: `${MERGER_BASE}/api/jobs/j4/video` }, {
  status: "completed",
  resultUrls: [`${MERGER_BASE}/api/jobs/j4/video`],
});
expectStatus("nested job", { job: { status: "done", progress: 100, jobId: "j5" } }, {
  status: "completed",
  progress: 100,
  resultUrls: [`${MERGER_BASE}/api/jobs/j5/video`],
});
expectStatus("nested data", { data: { status: "done", progress: 100, jobId: "j6" } }, {
  status: "completed",
  progress: 100,
});

console.log("8) فشل مع progress جزئي → تثبيت 100:");
expectStatus("failed عند 40", { status: "failed", progress: 40, error: "ffmpeg exited with code 1" }, {
  status: "failed",
  progress: 100,
  error: "ffmpeg exited",
});

console.log(`\nالنتيجة: ${passed} نجح / ${failed} فشل`);
if (failed > 0) process.exit(1);
console.log("MERGER PARSER TESTS PASSED");
