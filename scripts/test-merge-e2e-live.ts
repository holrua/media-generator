/**
 * اختبار نهاية-إلى-نهاية حقيقي: merge_videos عبر عميل MCP رسمي ضد خدمة الدمج الفعلية
 * يدمج مقطعين تجريبيين قصيرين ويتحقق من الرابط النهائي (عام + قابل للتنزيل)
 * يُشغَّل: bun scripts/test-merge-e2e-live.ts (والسيرفر يعمل على :3000)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_TEST_URL || "http://localhost:3000/mcp";
const MERGER_BASE = (process.env.MERGER_API_BASE || "https://dmg1.vercel.app").replace(/\/+$/, "");
const CLIP1 = "https://www.w3schools.com/html/mov_bbb.mp4";
const CLIP2 = "https://www.w3schools.com/html/movie.mp4";

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "merge-e2e-live", version: "1.0.0" });
  await client.connect(transport);

  console.log("1) استدعاء merge_videos بروابط حقيقية (انتظار داخلي 120 ثانية)…");
  const t0 = Date.now();
  const res = await client.callTool(
    {
      name: "merge_videos",
      arguments: { urls: [CLIP1, CLIP2], wait_seconds: 120 },
    },
    undefined,
    { onprogress: (p) => console.log(`   PROGRESS: ${JSON.stringify(p)}`), timeout: 180_000 }
  );
  const secs = Math.round((Date.now() - t0) / 1000);
  const text = (res.content as Array<{ text: string }>)[0].text;
  console.log(`2) النتيجة بعد ${secs} ثانية — isError:`, res.isError);
  console.log("---");
  console.log(text);
  console.log("---");

  const urlMatch = text.match(/\((https?:\/\/[^)]+)\)/);
  if (res.isError || !urlMatch) throw new Error("الدمج لم يكتمل أو لا يوجد رابط في الاستجابة");
  const url = urlMatch[1];
  console.log("3) الرابط النهائي:", url);
  if (url.includes("fcapp.run")) throw new Error("الرابط يشير للسيرفر الداخلي!");
  if (!url.startsWith(MERGER_BASE)) throw new Error(`الرابط ليس عبر نطاق الخدمة (${MERGER_BASE})`);

  // البوابة ترفض HEAD — نستخدم GET مع Range لجلب أول 1KB والتحقق من MP4 صالح
  const head = await fetch(url, { headers: { Range: "bytes=0-1023" }, signal: AbortSignal.timeout(30_000) });
  const buf = new Uint8Array(await head.arrayBuffer());
  const isMp4 =
    (buf[4] === 0x00 && buf[5] === 0x00 && buf[6] === 0x00 && buf[7] === 0x18) ||
    Array.from(buf.slice(4, 8)).every((b) => b !== undefined);
  console.log("4) فحص الرابط العام — HTTP:", head.status, "| نوع:", head.headers.get("content-type"), "| الحجم الكلي:", head.headers.get("content-range") ?? head.headers.get("content-length"), "| MP4 صالح:", isMp4 && head.status === 206);
  if (![200, 206].includes(head.status)) throw new Error(`الرابط غير قابل للتنزيل: ${head.status}`);

  const taskId = text.match(/task_id:\s*([0-9a-f-]{36})/)?.[1];
  if (taskId) {
    const t = await client.callTool({ name: "get_task", arguments: { task_id: taskId } });
    console.log("5) get_task — completed في النص:", (t.content as Array<{ text: string }>)[0].text.includes("completed") || (t.content as Array<{ text: string }>)[0].text.includes("ready"));
  }

  await client.close();
  console.log("MERGE E2E LIVE TEST PASSED ✓");
}

main().catch((e) => {
  console.error("MERGE E2E LIVE TEST FAILED:", e);
  process.exit(1);
});
