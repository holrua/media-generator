/**
 * اختبار وحدة لمحلل استجابات خدمة الدمج (parseJobStatus / extractJobId)
 * يُشغَّل: bun scripts/test-merger-parse.ts
 * يغطي الصيغ المحتملة للحقول (job_id|id، progress كسري|مئوي، file_url مطلق|download_path نسبي…)
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
check("job_id عادي", extractJobId({ job_id: "abc-123" }) === "abc-123");
check("id بديل", extractJobId({ id: "xyz" }) === "xyz");
check("متداخل داخل job", extractJobId({ job: { job_id: "nested" } }) === "nested");
check("نص مجرد", extractJobId("plain-id") === "plain-id");
check("فارغ → undefined", extractJobId({}) === undefined);

console.log("2) parseJobStatus — المثال الموثق (status=done + download_path نسبي):");
expectStatus("done + مسار نسبي", { status: "done", progress: 100, download_path: `/api/jobs/j1/download` }, {
  status: "completed",
  progress: 100,
  resultUrls: [`${MERGER_BASE}/api/jobs/j1/download`],
});

console.log("3) parseJobStatus — result.file_url مطلق:");
expectStatus(
  "file_url مطلق",
  { status: "done", progress: 1.0, result: { file_url: "https://cdn.example.com/files/j2/out.mp4", filename: "out.mp4" } },
  { status: "completed", progress: 100, resultUrls: ["https://cdn.example.com/files/j2/out.mp4"] }
);

console.log("4) parseJobStatus — تقدم كسري 0..1 أثناء المعالجة:");
expectStatus("processing 0.45", { status: "running", progress: 0.45 }, { status: "processing", progress: 45 });
expectStatus("processing مئوي 62", { status: "processing", progress: 62 }, { status: "processing", progress: 62 });
expectStatus("بدون progress", { status: "queued" }, { status: "processing", progress: 0 });

console.log("5) parseJobStatus — فشل مع رسالة:");
expectStatus("error + detail", { status: "error", detail: "ffprobe failed: bad container" }, {
  status: "failed",
  error: "ffprobe failed",
});

console.log("6) parseJobStatus — صيغ بديلة (state، result.download_path):");
expectStatus("state=finished", { state: "finished", result: { download_path: "/api/jobs/j3/download" } }, {
  status: "completed",
  resultUrls: [`${MERGER_BASE}/api/jobs/j3/download`],
});
expectStatus("file_url نسبي داخل result", { status: "done", result: { file_url: "/files/j4/out.mp4" } }, {
  status: "completed",
  resultUrls: [`${MERGER_BASE}/files/j4/out.mp4`],
});

console.log("7) parseJobStatus — حقل داخل job متداخل:");
expectStatus("nested job", { job: { status: "done", progress: 100, download_path: "/api/jobs/j5/download" } }, {
  status: "completed",
  progress: 100,
});

console.log(`\nالنتيجة: ${passed} نجح / ${failed} فشل`);
if (failed > 0) process.exit(1);
console.log("MERGER PARSER TESTS PASSED");
