// Ephemeral — push notification sender
// Runs on Supabase's servers on a schedule (via Cron Jobs), independent of
// whether anyone has the app open. This is what makes alerts survive the
// browser being fully closed.
//
// Required Edge Function secrets (set in Supabase Dashboard -> Edge Functions -> Secrets):
//   SUPABASE_URL                (already provided automatically by Supabase)
//   SUPABASE_SERVICE_ROLE_KEY   (Project Settings -> API -> service_role key — KEEP SECRET)
//   VAPID_PUBLIC_KEY            (from the pair generated for this app)
//   VAPID_PRIVATE_KEY           (from the same pair — KEEP SECRET, never put this in the client)
//   VAPID_SUBJECT               (e.g. "mailto:you@example.com" — required by the push spec)
//   TIMEZONE_OFFSET_MINUTES     (optional, defaults to 330 = IST / UTC+5:30)

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:example@example.com";
const TZ_OFFSET_MIN = Number(Deno.env.get("TIMEZONE_OFFSET_MINUTES") || "330"); // IST default

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

function toMinutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

async function sendPush(subs: any[], payload: Record<string, unknown>) {
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload)
        );
      } catch (e: any) {
        // 404/410 = subscription is dead (uninstalled, permissions revoked, etc.) — clean it up
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await sb.from("push_subscriptions").delete().eq("id", s.id);
        }
      }
    })
  );
}

async function alreadySent(user_id: string, ref_type: string, ref_id: string, dateStr: string) {
  const { data } = await sb
    .from("sent_notifications")
    .select("id")
    .eq("user_id", user_id).eq("ref_type", ref_type).eq("ref_id", ref_id).eq("sent_date", dateStr)
    .maybeSingle();
  return !!data;
}
async function markSent(user_id: string, ref_type: string, ref_id: string) {
  await sb.from("sent_notifications").insert({ user_id, ref_type, ref_id }).select();
}

Deno.serve(async () => {
  // Shift "now" by the configured timezone offset, then read wall-clock parts
  // with the UTC getters — this avoids Deno-runtime timezone-database issues.
  const shifted = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
  const nowMin = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const today = shifted.getUTCDay();
  const todayStr = shifted.toISOString().slice(0, 10);

  let entriesChecked = 0, deadlinesChecked = 0, examsChecked = 0, sent = 0;

  // ---- class / lab / entry alerts ----
  const { data: entries } = await sb.from("entries").select("*").eq("day", today).eq("muted", false);
  const { data: settingsRows } = await sb.from("notification_settings").select("*");
  const settingsByUser = Object.fromEntries((settingsRows || []).map((s: any) => [s.user_id, s]));

  for (const e of entries || []) {
    entriesChecked++;
    const notifyBefore = e.notify || 15;
    const diff = toMinutes(e.start_time) - nowMin;
    // Fire once, in the last ~5-minute slice before the alert window closes
    // (cron runs every 5 min, so this window guarantees exactly one hit).
    if (diff <= 0 || diff > notifyBefore || diff <= notifyBefore - 5) continue;

    const settings = settingsByUser[e.user_id];
    let inQuiet = false;
    if (settings?.quiet_start && settings?.quiet_end) {
      const [sh, sm] = settings.quiet_start.split(":").map(Number);
      const [eh, em] = settings.quiet_end.split(":").map(Number);
      const s = sh * 60 + sm, en = eh * 60 + em;
      inQuiet = s < en ? nowMin >= s && nowMin < en : nowMin >= s || nowMin < en;
    }
    if (inQuiet && !e.bypass_quiet) continue;
    if (await alreadySent(e.user_id, "entry", e.id, todayStr)) continue;

    const { data: subs } = await sb.from("push_subscriptions").select("*").eq("user_id", e.user_id);
    if (subs && subs.length) {
      await sendPush(subs, {
        title: `${e.title} in ${diff} min`,
        body: `${e.type}${e.location ? " · " + e.location : ""} · starts ${e.start_time}`,
        tag: "entry-" + e.id,
        data: { entryId: e.id },
      });
      await markSent(e.user_id, "entry", e.id, todayStr);
      sent++;
    }
  }

  // ---- deadline / exam reminders ----
  const { data: deadlines } = await sb.from("deadlines").select("*");
  for (const d of deadlines || []) {
    deadlinesChecked++;
    const due = new Date(d.due_date + "T00:00:00Z");
    const daysUntil = Math.round((due.getTime() - new Date(todayStr + "T00:00:00Z").getTime()) / 86400000);
    const remind = d.remind_days_before ?? 1;
    if (daysUntil !== remind) continue;
    if (await alreadySent(d.user_id, "deadline", d.id, todayStr)) continue;

    const { data: subs } = await sb.from("push_subscriptions").select("*").eq("user_id", d.user_id);
    if (subs && subs.length) {
      await sendPush(subs, {
        title: `${d.type || "Deadline"}: ${d.title}`,
        body: daysUntil === 0 ? "Due today" : `Due in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`,
        tag: "deadline-" + d.id,
      });
      await markSent(d.user_id, "deadline", d.id, todayStr);
      sent++;
    }
  }

  // ---- exam reminders ----
  const { data: exams } = await sb.from("exams").select("*");
  for (const x of exams || []) {
    examsChecked++;
    const due = new Date(x.exam_date + "T00:00:00Z");
    const daysUntil = Math.round((due.getTime() - new Date(todayStr + "T00:00:00Z").getTime()) / 86400000);
    const remind = x.remind_days_before ?? 1;
    if (daysUntil !== remind) continue;
    if (await alreadySent(x.user_id, "exam", x.id, todayStr)) continue;

    const { data: subs } = await sb.from("push_subscriptions").select("*").eq("user_id", x.user_id);
    if (subs && subs.length) {
      await sendPush(subs, {
        title: `Exam: ${x.course_code ? x.course_code + " — " : ""}${x.course_name}`,
        body: (daysUntil === 0 ? "Today" : `In ${daysUntil} day${daysUntil === 1 ? "" : "s"}`) +
          (x.exam_time ? ` · ${x.exam_time}` : "") + (x.location ? ` · ${x.location}` : ""),
        tag: "exam-" + x.id,
      });
      await markSent(x.user_id, "exam", x.id, todayStr);
      sent++;
    }
  }

  return new Response(
    JSON.stringify({ ok: true, entriesChecked, deadlinesChecked, examsChecked, sent, nowMin, today, todayStr }),
    { headers: { "Content-Type": "application/json" } }
  );
});
